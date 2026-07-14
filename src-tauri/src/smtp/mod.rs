use anyhow::{Context, Result};
use lettre::{
    message::{header::ContentType, Mailbox, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use std::time::Duration;

pub mod attachment;
pub use attachment::attachment_part;

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
            .map(|id| ensure_angle_brackets(id))
            .collect();
        email_builder = email_builder.references(bracketed.join(" "));
    }

    let email = if !message.attachments.is_empty() {
        let body_part = if let Some(html) = &message.body_html {
            MultiPart::alternative()
                .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(message.body_text.clone()))
                .singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(html.clone()))
        } else {
            MultiPart::alternative().singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(message.body_text.clone()))
        };

        let mut mixed = MultiPart::mixed().multipart(body_part);
        for att in &message.attachments {
            mixed = mixed.singlepart(attachment_part(&att.name, &att.mime_type, att.data.clone()));
        }

        email_builder.multipart(mixed).context("Failed to build email message")?
    } else if let Some(html) = &message.body_html {
        email_builder.multipart(
            MultiPart::alternative()
                .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(message.body_text.clone()))
                .singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(html.clone())),
        ).context("Failed to build email message")?
    } else {
        email_builder.body(message.body_text.clone()).context("Failed to build email message")?
    };

    Ok(email)
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

    /// Guards the whole outgoing path, not just the helper: a mail built for the wire
    /// must carry the RFC 6266 filename form, never lettre's `filename*0*` continuation.
    #[test]
    fn a_built_mail_carries_a_readable_filename_for_a_non_ascii_attachment() {
        let message = EmailMessage {
            to: vec!["to@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Zählerwechsel".into(),
            body_text: "hi".into(),
            body_html: None,
            in_reply_to: None,
            references: None,
            attachments: vec![EmailAttachment {
                name: "AKDB-Export-Donauwörth.xml".into(),
                mime_type: "text/xml".into(),
                data: b"<root/>".to_vec(),
            }],
        };

        let raw = String::from_utf8_lossy(&build_message(config(), message).unwrap()).to_string();
        let unfolded = raw.replace("\r\n ", "").replace("\r\n\t", "");

        assert!(unfolded.contains("filename=\"AKDB-Export-Donauwoerth.xml\""), "{unfolded}");
        assert!(unfolded.contains("filename*=UTF-8''AKDB-Export-Donauw%C3%B6rth.xml"), "{unfolded}");
        assert!(!unfolded.contains("filename*0"), "regressed to RFC 2231 continuation");
        assert!(unfolded.contains("Content-Transfer-Encoding: base64"));
    }
}
