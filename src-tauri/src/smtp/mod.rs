use anyhow::{Context, Result};
use lettre::{
    message::{header::ContentType, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use std::time::Duration;

pub mod attachment;
pub use attachment::{attachment_part, inline_attachment_part};

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub security: String, // "ssl" or "starttls"
    pub email: String,
    pub password: String,      // password OR access_token
    pub auth_type: String,     // "password" or "oauth"
    pub display_name: String,
}

pub struct EmailAttachment {
    pub name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
    /// Set for images referenced as `cid:` from the HTML body (quoted signature
    /// logos etc.) — they become inline parts in a multipart/related container
    /// instead of regular attachments.
    pub content_id: Option<String>,
}

/// iMIP payload: the text/calendar alternative plus an invite.ics copy for
/// clients that only list attachments.
pub struct CalendarPart {
    pub method: String,
    pub ics: String,
}

pub struct EmailMessage {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<EmailAttachment>,
    pub calendar_part: Option<CalendarPart>,
}

/// Build the `Message-ID` header value for an outgoing mail.
///
/// lettre never generates one, and without it the local copy of a mail cannot be
/// matched against the server's copy: a sent draft keeps its UID-less local row, so
/// the follow-up move out of the Drafts folder finds nothing to move and the draft
/// stays there. The domain comes from the sender address — lettre's own fallback
/// would put the machine's hostname on the wire.
pub fn generate_message_id(from_email: &str) -> String {
    let domain = from_email
        .rsplit_once('@')
        .map(|(_, d)| d.trim())
        .filter(|d| !d.is_empty() && !d.contains(char::is_whitespace))
        .unwrap_or("localhost");
    format!("<{}@{}>", uuid::Uuid::new_v4(), domain)
}

/// Ensure a message ID is wrapped in angle brackets per RFC 5322.
fn ensure_angle_brackets(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.starts_with('<') && trimmed.ends_with('>') {
        trimmed.to_string()
    } else {
        format!("<{}>", trimmed)
    }
}

/// Build an RFC 2822 message from config + message data.
/// Returns the formatted bytes without sending.
pub fn build_message(config: SmtpConfig, message: EmailMessage) -> Result<Vec<u8>> {
    let email = build_lettre_message(&config, &message)?;
    Ok(email.formatted())
}

/// Parse a recipient string into a Mailbox, handling edge cases robustly.
/// Always extracts the email from angle brackets if present, regardless of what
/// the display name contains. Uses Mailbox::new() which lets lettre handle the
/// internal encoding/quoting — avoids strict RFC 5322 parsing failures on
/// display names with special characters like '|', ',', etc.
pub fn parse_recipient(raw: &str) -> Result<Mailbox> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Empty address");
    }

    // Format: "Display Name <email@example.com>" or "<email@example.com>"
    if let Some(start) = trimmed.rfind('<') {
        if let Some(end) = trimmed.rfind('>') {
            if end > start {
                let email_str = trimmed[start + 1..end].trim();
                let addr: lettre::Address = email_str
                    .parse()
                    .with_context(|| format!("Invalid email address: {}", email_str))?;
                let name_part = trimmed[..start]
                    .trim()
                    .trim_matches('"')
                    .trim();
                let display = if name_part.is_empty() || name_part == email_str {
                    None
                } else {
                    Some(name_part.to_string())
                };
                return Ok(Mailbox::new(display, addr));
            }
        }
    }

    // Plain email address (no angle brackets, no display name)
    let addr: lettre::Address = trimmed
        .parse()
        .with_context(|| format!("Invalid email address: {}", trimmed))?;
    Ok(Mailbox::new(None, addr))
}

fn build_lettre_message(config: &SmtpConfig, message: &EmailMessage) -> Result<Message> {
    let from_mailbox = Mailbox::new(
        if config.display_name.is_empty() { None } else { Some(config.display_name.clone()) },
        config.email.parse().context("Invalid from email address")?,
    );

    let mut email_builder = Message::builder()
        .from(from_mailbox)
        .message_id(Some(generate_message_id(&config.email)))
        .subject(&message.subject);

    for to in &message.to {
        email_builder = email_builder.to(parse_recipient(to)?);
    }

    for cc in &message.cc {
        if !cc.is_empty() {
            email_builder = email_builder.cc(parse_recipient(cc)?);
        }
    }

    for bcc in &message.bcc {
        if !bcc.is_empty() {
            let bcc_mailbox = parse_recipient(bcc)?;
            email_builder = email_builder.bcc(bcc_mailbox);
        }
    }

    if let Some(ref reply_to) = message.in_reply_to {
        email_builder = email_builder.in_reply_to(ensure_angle_brackets(reply_to));
    }
    if let Some(ref refs) = message.references {
        // References header contains space-separated message IDs, each needs brackets
        let bracketed: Vec<String> = refs.split_whitespace()
            .map(ensure_angle_brackets)
            .collect();
        email_builder = email_builder.references(bracketed.join(" "));
    }

    // Inline parts (cid: referenced from the HTML) live in a multipart/related
    // container around the HTML part; everything else stays a regular
    // attachment in the mixed container. Inline without an HTML body would be
    // unreferenced — degrade those to regular attachments defensively.
    let (inline, regular): (Vec<&EmailAttachment>, Vec<&EmailAttachment>) = message
        .attachments
        .iter()
        .partition(|a| a.content_id.is_some() && message.body_html.is_some());

    let html_side = message.body_html.as_ref().map(|html| {
        let html_part = SinglePart::builder().header(ContentType::TEXT_HTML).body(html.clone());
        if inline.is_empty() {
            HtmlSide::Single(html_part)
        } else {
            let mut related = MultiPart::related().singlepart(html_part);
            for att in &inline {
                let cid = att.content_id.as_deref().unwrap_or_default();
                related = related.singlepart(inline_attachment_part(&att.name, &att.mime_type, att.data.clone(), cid));
            }
            HtmlSide::Related(related)
        }
    });

    enum HtmlSide {
        Single(SinglePart),
        Related(MultiPart),
    }

    let text_part = || SinglePart::builder().header(ContentType::TEXT_PLAIN).body(message.body_text.clone());
    let calendar = message.calendar_part.as_ref().map(calendar_body_part).transpose()?;
    let mut files: Vec<SinglePart> = regular.iter().map(|a| attachment_part(&a.name, &a.mime_type, a.data.clone())).collect();
    if let Some(c) = &message.calendar_part {
        files.push(attachment_part("invite.ics", "application/ics", c.ics.clone().into_bytes()));
    }

    let alternative = if html_side.is_none() && calendar.is_none() {
        None
    } else {
        let mut alt = MultiPart::alternative().singlepart(text_part());
        match html_side {
            Some(HtmlSide::Single(html_part)) => alt = alt.singlepart(html_part),
            Some(HtmlSide::Related(related)) => alt = alt.multipart(related),
            None => {}
        }
        if let Some(cal) = calendar {
            alt = alt.singlepart(cal);
        }
        Some(alt)
    };

    let email = match (alternative, files.is_empty()) {
        (Some(alt), true) => email_builder.multipart(alt),
        (None, true) => email_builder.body(message.body_text.clone()),
        (alt, false) => {
            let mut mixed = MultiPart::mixed()
                .multipart(alt.unwrap_or_else(|| MultiPart::alternative().singlepart(text_part())));
            for file in files {
                mixed = mixed.singlepart(file);
            }
            email_builder.multipart(mixed)
        }
    }
    .context("Failed to build email message")?;

    Ok(email)
}

fn calendar_body_part(part: &CalendarPart) -> Result<SinglePart> {
    let content_type = ContentType::parse(&format!("text/calendar; method={}; charset=UTF-8", part.method))
        .map_err(|e| anyhow::anyhow!("Invalid calendar method {}: {}", part.method, e))?;
    Ok(SinglePart::builder().header(content_type).body(part.ics.clone()))
}

/// Send an email via SMTP. Returns the raw RFC822 message bytes on success
/// so the caller can append it to the Sent folder.
pub async fn send_mail(config: SmtpConfig, message: EmailMessage) -> Result<Vec<u8>> {
    let email = build_lettre_message(&config, &message)?;

    let creds = Credentials::new(config.email.clone(), config.password);

    let mailer: AsyncSmtpTransport<Tokio1Executor> = if config.security == "ssl" {
        let builder = AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
            .context(format!("Failed to connect to SMTP server: {}", config.host))?
            .port(config.port)
            .timeout(Some(Duration::from_secs(30)));
        if config.auth_type == "oauth" {
            builder.credentials(creds)
                .authentication(vec![lettre::transport::smtp::authentication::Mechanism::Xoauth2])
                .build()
        } else {
            builder.credentials(creds).build()
        }
    } else {
        let builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            .context(format!("Failed to connect to SMTP server: {}", config.host))?
            .port(config.port)
            .timeout(Some(Duration::from_secs(30)));
        if config.auth_type == "oauth" {
            builder.credentials(creds)
                .authentication(vec![lettre::transport::smtp::authentication::Mechanism::Xoauth2])
                .build()
        } else {
            builder.credentials(creds).build()
        }
    };

    // Get the formatted RFC822 bytes before sending
    let message_bytes = email.formatted();

    mailer
        .send(email)
        .await
        .context("Failed to send email")?;

    Ok(message_bytes)
}

pub async fn test_smtp_connection(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
    security: &str,
    auth_type: &str,
) -> Result<()> {
    if port == 0 {
        anyhow::bail!("Invalid SMTP port: 0");
    }
    let creds = Credentials::new(email.to_string(), password.to_string());

    // Use the explicit security setting instead of port-based heuristic
    let mailer: AsyncSmtpTransport<Tokio1Executor> = if security == "ssl" {
        let builder = AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .context(format!("Failed to connect to SMTP server: {}", host))?
            .port(port)
            .timeout(Some(Duration::from_secs(15)));
        if auth_type == "oauth" {
            builder.credentials(creds)
                .authentication(vec![lettre::transport::smtp::authentication::Mechanism::Xoauth2])
                .build()
        } else {
            builder.credentials(creds).build()
        }
    } else {
        let builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .context(format!("Failed to connect to SMTP server: {}", host))?
            .port(port)
            .timeout(Some(Duration::from_secs(15)));
        if auth_type == "oauth" {
            builder.credentials(creds)
                .authentication(vec![lettre::transport::smtp::authentication::Mechanism::Xoauth2])
                .build()
        } else {
            builder.credentials(creds).build()
        }
    };

    mailer.test_connection().await.context("SMTP connection test failed")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SmtpConfig {
        SmtpConfig {
            host: "smtp.example.com".into(),
            port: 465,
            security: "ssl".into(),
            email: "sender@example.com".into(),
            password: String::new(),
            auth_type: "password".into(),
            display_name: "Sender".into(),
        }
    }

    fn message_with(html: Option<&str>, attachments: Vec<EmailAttachment>) -> EmailMessage {
        EmailMessage {
            to: vec!["to@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Test".into(),
            body_text: "hi".into(),
            body_html: html.map(|h| h.to_string()),
            in_reply_to: None,
            references: None,
            attachments,
            calendar_part: None,
        }
    }

    fn att(name: &str, mime: &str, content_id: Option<&str>) -> EmailAttachment {
        EmailAttachment {
            name: name.into(),
            mime_type: mime.into(),
            data: vec![1, 2, 3],
            content_id: content_id.map(String::from),
        }
    }

    /// The reply-quote case: an embedded signature image travels as an inline
    /// part inside multipart/related, referenced by Content-ID — never as a
    /// local file:// path and never as a listed attachment.
    #[test]
    fn cid_attachments_become_inline_parts_in_a_related_container() {
        let message = message_with(
            Some("<p>Hi</p><img src=\"cid:inline-1@prudii\">"),
            vec![
                att("logo.png", "image/png", Some("inline-1@prudii")),
                att("report.pdf", "application/pdf", None),
            ],
        );

        let raw = String::from_utf8_lossy(&build_message(config(), message).unwrap()).to_string();
        let unfolded = raw.replace("\r\n ", "").replace("\r\n\t", "");

        assert!(unfolded.contains("multipart/related"), "{unfolded}");
        assert!(unfolded.contains("Content-ID: <inline-1@prudii>"), "{unfolded}");
        assert!(unfolded.contains("Content-Disposition: inline; filename=\"logo.png\""), "{unfolded}");
        assert!(unfolded.contains("Content-Disposition: attachment; filename=\"report.pdf\""), "{unfolded}");
    }

    #[test]
    fn without_cid_attachments_no_related_container_is_emitted() {
        let message = message_with(
            Some("<p>Hi</p>"),
            vec![att("report.pdf", "application/pdf", None)],
        );
        let raw = String::from_utf8_lossy(&build_message(config(), message).unwrap()).to_string();
        assert!(!raw.contains("multipart/related"), "{raw}");
        assert!(raw.contains("multipart/mixed"), "{raw}");
    }

    #[test]
    fn inline_only_mail_needs_no_mixed_container() {
        let message = message_with(
            Some("<img src=\"cid:inline-1@prudii\">"),
            vec![att("logo.png", "image/png", Some("inline-1@prudii"))],
        );
        let raw = String::from_utf8_lossy(&build_message(config(), message).unwrap()).to_string();
        assert!(raw.contains("multipart/related"), "{raw}");
        assert!(!raw.contains("multipart/mixed"), "{raw}");
    }

    /// Guards the whole outgoing path, not just the helper: a mail built for the wire
    /// must carry the RFC 6266 filename form, never lettre's `filename*0*` continuation.
    #[test]
    fn a_built_mail_carries_a_readable_filename_for_a_non_ascii_attachment() {
        let message = EmailMessage {
            to: vec!["to@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Bericht".into(),
            body_text: "hi".into(),
            body_html: None,
            in_reply_to: None,
            references: None,
            attachments: vec![EmailAttachment {
                name: "export-übersicht.xml".into(),
                mime_type: "text/xml".into(),
                data: b"<root/>".to_vec(),
                content_id: None,
            }],
            calendar_part: None,
        };

        let raw = String::from_utf8_lossy(&build_message(config(), message).unwrap()).to_string();
        let unfolded = raw.replace("\r\n ", "").replace("\r\n\t", "");

        assert!(unfolded.contains("filename=\"export-uebersicht.xml\""), "{unfolded}");
        assert!(unfolded.contains("filename*=UTF-8''export-%C3%BCbersicht.xml"), "{unfolded}");
        assert!(!unfolded.contains("filename*0"), "regressed to RFC 2231 continuation");
        assert!(unfolded.contains("Content-Transfer-Encoding: base64"));
    }

    /// Without a Message-ID the local copy of an outgoing mail can never be matched
    /// against the server's copy — a sent draft then stays in the Drafts folder.
    #[test]
    fn a_built_mail_carries_a_message_id_from_the_sender_domain() {
        let message = EmailMessage {
            to: vec!["to@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Bericht".into(),
            body_text: "hi".into(),
            body_html: None,
            in_reply_to: None,
            references: None,
            attachments: vec![],
            calendar_part: None,
        };

        let raw = String::from_utf8_lossy(&build_message(config(), message).unwrap()).to_string();

        let header = raw
            .lines()
            .find(|l| l.starts_with("Message-ID:"))
            .unwrap_or_else(|| panic!("no Message-ID header in:\n{raw}"));
        assert!(header.contains("@example.com>"), "{header}");
    }

    #[test]
    fn a_message_id_never_leaks_the_hostname_for_a_malformed_sender() {
        assert!(generate_message_id("not-an-address").ends_with("@localhost>"));
        assert!(generate_message_id("user@example.com").ends_with("@example.com>"));
        assert_ne!(
            generate_message_id("user@example.com"),
            generate_message_id("user@example.com"),
            "every mail needs its own id"
        );
    }

    const REPLY_ICS: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T070000Z\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:sender@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn a_calendar_reply_carries_the_method_alternative_and_an_invite_file() {
        let message = EmailMessage {
            calendar_part: Some(CalendarPart { method: "REPLY".into(), ics: REPLY_ICS.into() }),
            ..message_with(None, vec![])
        };
        let raw = build_message(config(), message).unwrap();
        let text = String::from_utf8_lossy(&raw).replace("\r\n ", " ").replace("\r\n\t", " ");
        assert!(text.contains("multipart/mixed"), "{text}");
        assert!(text.contains("multipart/alternative"), "{text}");
        assert!(text.contains("text/calendar") && text.contains("method=REPLY"), "{text}");
        assert!(text.contains("filename=\"invite.ics\""), "{text}");
        let parsed = mail_parser::MessageParser::default().parse(&raw[..]).unwrap();
        let candidates = crate::calendar::invite_mail::candidates_from_message(&parsed);
        assert_eq!(candidates.iter().map(|c| c.inline).collect::<Vec<_>>(), vec![true, false]);
        assert_eq!(crate::calendar::invite_mail::choose(candidates).map(|f| f.method).as_deref(), Some("REPLY"));
    }

    #[test]
    fn plain_mails_stay_single_part() {
        let raw = String::from_utf8_lossy(&build_message(config(), message_with(None, vec![])).unwrap()).to_string();
        assert!(!raw.contains("multipart/"), "{raw}");
    }
}
