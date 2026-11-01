use super::names::attachment_name;
use crate::smtp::attachment::{attachment_part, inline_attachment_part};
use chrono::{DateTime, FixedOffset, NaiveDateTime, TimeZone, Utc};
use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::Message;
use mail_parser::{MessageParser, MimeHeaders, PartType};
use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Addr {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Debug, Clone)]
pub struct ExportPart {
    pub filename: String,
    pub mime_type: String,
    pub content_id: Option<String>,
    pub bytes: Vec<u8>,
    pub is_body_part: bool,
}

#[derive(Debug, Clone)]
pub struct ParsedMail {
    pub subject: String,
    pub from: Addr,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub date: Option<DateTime<FixedOffset>>,
    pub html: Option<String>,
    pub text: Option<String>,
    pub parts: Vec<ExportPart>,
}

#[derive(Debug, Clone)]
pub struct LocalMail {
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub to_json: String,
    pub cc_json: String,
    pub date: String,
    pub body_html: String,
    pub body_text: String,
}

fn addrs(list: Option<&mail_parser::Address<'_>>) -> Vec<Addr> {
    list.map(|a| {
        a.iter()
            .map(|x| Addr {
                name: x.name().unwrap_or_default().to_string(),
                email: x.address().unwrap_or_default().to_string(),
            })
            .collect()
    })
    .unwrap_or_default()
}

fn header_date(d: &mail_parser::DateTime) -> Option<DateTime<FixedOffset>> {
    let secs = (d.tz_hour as i32 * 3600 + d.tz_minute as i32 * 60) * if d.tz_before_gmt { -1 } else { 1 };
    let offset = FixedOffset::east_opt(secs)?;
    Some(DateTime::from_timestamp(d.to_timestamp(), 0)?.with_timezone(&offset))
}

pub fn parse_raw(raw: &[u8]) -> Option<ParsedMail> {
    let msg = MessageParser::default().parse(raw)?;

    let html = msg.html_part(0).and_then(|p| match &p.body {
        PartType::Html(h) => Some(h.to_string()),
        _ => None,
    });
    let text = msg.text_part(0).and_then(|p| match &p.body {
        PartType::Text(t) => Some(t.to_string()),
        _ => None,
    });
    let html_for_cid = html.clone().unwrap_or_default();

    let mut parts = Vec::new();
    for (i, part) in msg.attachments().enumerate() {
        let raw_name = part.attachment_name();
        let has_real_filename = raw_name.is_some();
        let filename = attachment_name(raw_name, i + 1);
        let mime_type = part
            .content_type()
            .map(|ct| format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("octet-stream")))
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let content_id = part
            .content_id()
            .map(|c| c.trim_matches(|ch| ch == '<' || ch == '>').to_string())
            .filter(|c| !c.is_empty());
        let disposition_inline = part.content_disposition().map(|cd| cd.ctype() == "inline");
        let is_body_part = crate::imap::is_body_part(
            &filename,
            Some(&mime_type),
            content_id.as_deref(),
            disposition_inline,
            has_real_filename,
            &html_for_cid,
        );
        parts.push(ExportPart {
            filename,
            mime_type,
            content_id,
            bytes: part.contents().to_vec(),
            is_body_part,
        });
    }

    let from = addrs(msg.from()).into_iter().next().unwrap_or_default();

    Some(ParsedMail {
        subject: msg.subject().unwrap_or_default().to_string(),
        from,
        to: addrs(msg.to()),
        cc: addrs(msg.cc()),
        date: msg.date().and_then(header_date),
        html,
        text,
        parts,
    })
}

pub(crate) fn parse_local_date(s: &str) -> Option<DateTime<FixedOffset>> {
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d);
    }
    let naive = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()?;
    Some(Utc.from_utc_datetime(&naive).fixed_offset())
}

pub fn from_local(row: &LocalMail, attachments: Vec<ExportPart>) -> ParsedMail {
    let non_blank = |s: &str| if s.trim().is_empty() { None } else { Some(s.to_string()) };
    ParsedMail {
        subject: row.subject.clone(),
        from: Addr { name: row.from_name.clone(), email: row.from_email.clone() },
        to: serde_json::from_str(&row.to_json).unwrap_or_default(),
        cc: serde_json::from_str(&row.cc_json).unwrap_or_default(),
        date: parse_local_date(&row.date),
        html: non_blank(&row.body_html),
        text: non_blank(&row.body_text),
        parts: attachments,
    }
}

pub fn has_content(mail: &ParsedMail) -> bool {
    let filled = |s: &Option<String>| s.as_deref().is_some_and(|v| !v.trim().is_empty());
    filled(&mail.html) || filled(&mail.text) || mail.parts.iter().any(|p| !p.is_body_part)
}

fn mailbox(a: &Addr) -> Option<Mailbox> {
    let email = a.email.parse().ok()?;
    Some(Mailbox::new(if a.name.is_empty() { None } else { Some(a.name.clone()) }, email))
}

pub fn build_eml(mail: &ParsedMail) -> Vec<u8> {
    let from = mailbox(&mail.from).unwrap_or_else(|| {
        Mailbox::new(None, "unknown@unknown.invalid".parse().expect("static address"))
    });
    let mut builder = Message::builder().from(from).subject(mail.subject.clone());
    for a in mail.to.iter().filter_map(mailbox) {
        builder = builder.to(a);
    }
    for a in mail.cc.iter().filter_map(mailbox) {
        builder = builder.cc(a);
    }
    if let Some(d) = mail.date {
        if let Ok(secs) = u64::try_from(d.timestamp()) {
            builder = builder.date(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs));
        }
    }

    let has_html = mail.html.is_some();
    let (inline, regular): (Vec<&ExportPart>, Vec<&ExportPart>) =
        mail.parts.iter().partition(|p| p.is_body_part && p.content_id.is_some() && has_html);

    let text_part = SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .body(mail.text.clone().unwrap_or_default());
    let mut alternative = MultiPart::alternative().singlepart(text_part);
    if let Some(html) = &mail.html {
        let html_part = SinglePart::builder().header(ContentType::TEXT_HTML).body(html.clone());
        if inline.is_empty() {
            alternative = alternative.singlepart(html_part);
        } else {
            let mut related = MultiPart::related().singlepart(html_part);
            for p in &inline {
                let cid = p.content_id.as_deref().unwrap_or_default();
                related = related.singlepart(inline_attachment_part(&p.filename, &p.mime_type, p.bytes.clone(), cid));
            }
            alternative = alternative.multipart(related);
        }
    }

    let mut mixed = MultiPart::mixed().multipart(alternative);
    for p in regular {
        mixed = mixed.singlepart(attachment_part(&p.filename, &p.mime_type, p.bytes.clone()));
    }

    match builder.multipart(mixed) {
        Ok(m) => m.formatted(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn multipart_fixture() -> Vec<u8> {
        let src = "From: Jonas Brandt <jonas.brandt@studio-halde.example>\n\
To: Anna Weber <anna@studio-halde.example>\n\
Subject: Angebot Neubau Waldweg\n\
Date: Wed, 21 Oct 2026 15:28:44 +0200\n\
MIME-Version: 1.0\n\
Content-Type: multipart/mixed; boundary=\"outer\"\n\
\n\
--outer\n\
Content-Type: multipart/related; boundary=\"rel\"\n\
\n\
--rel\n\
Content-Type: text/html; charset=utf-8\n\
\n\
<p>Hallo</p><img src=\"cid:logo@halde\">\n\
--rel\n\
Content-Type: image/png; name=\"logo.png\"\n\
Content-Transfer-Encoding: base64\n\
Content-ID: <logo@halde>\n\
Content-Disposition: inline; filename=\"logo.png\"\n\
\n\
iVBORw0KGgo=\n\
--rel--\n\
--outer\n\
Content-Type: application/pdf; name=\"Plaene.pdf\"\n\
Content-Transfer-Encoding: base64\n\
Content-Disposition: attachment; filename=\"Plaene.pdf\"\n\
\n\
JVBERi0xLjQ=\n\
--outer--\n";
        src.replace('\n', "\r\n").into_bytes()
    }

    #[test]
    fn parses_html_inline_image_and_attachment() {
        let m = parse_raw(&multipart_fixture()).unwrap();
        assert_eq!(m.subject, "Angebot Neubau Waldweg");
        assert_eq!(m.from.email, "jonas.brandt@studio-halde.example");
        assert_eq!(m.to[0].name, "Anna Weber");
        assert!(m.html.as_deref().unwrap().contains("cid:logo@halde"));
        let logo = m.parts.iter().find(|p| p.filename == "logo.png").unwrap();
        assert!(logo.is_body_part);
        assert_eq!(logo.content_id.as_deref(), Some("logo@halde"));
        assert!(!m.parts.iter().find(|p| p.filename == "Plaene.pdf").unwrap().is_body_part);
    }

    #[test]
    fn decodes_latin1_text() {
        let m = parse_raw(
            b"From: Anna Weber <anna@studio-halde.example>\r\nSubject: =?ISO-8859-1?Q?Gr=FC=DFe?=\r\nContent-Type: text/plain; charset=ISO-8859-1\r\n\r\nSch\xf6ne Gr\xfc\xdfe\r\n",
        )
        .unwrap();
        assert_eq!(m.subject, "Grüße");
        assert!(m.text.unwrap().contains("Schöne Grüße"));
    }

    #[test]
    fn rebuilt_eml_round_trips() {
        let local = LocalMail {
            subject: "Termin".into(),
            from_name: "Anna Weber".into(),
            from_email: "anna@studio-halde.example".into(),
            to_json: r#"[{"email":"jonas.brandt@studio-halde.example","name":"Jonas Brandt"}]"#.into(),
            cc_json: "[]".into(),
            date: "2026-10-21T15:28:44Z".into(),
            body_html: "<p>Dienstag 10 Uhr?</p>".into(),
            body_text: String::new(),
        };
        let pdf = ExportPart {
            filename: "Plan.pdf".into(),
            mime_type: "application/pdf".into(),
            content_id: None,
            bytes: b"%PDF-1.4".to_vec(),
            is_body_part: false,
        };
        let back = parse_raw(&build_eml(&from_local(&local, vec![pdf]))).unwrap();
        assert_eq!(back.subject, "Termin");
        assert!(back.html.unwrap().contains("Dienstag 10 Uhr?"));
        assert_eq!(back.parts.iter().filter(|p| !p.is_body_part).count(), 1);
    }

    #[test]
    fn empty_local_mail_has_no_content() {
        let local = LocalMail {
            subject: "x".into(),
            from_name: String::new(),
            from_email: "a@studio-halde.example".into(),
            to_json: "[]".into(),
            cc_json: "[]".into(),
            date: String::new(),
            body_html: " ".into(),
            body_text: String::new(),
        };
        assert!(!has_content(&from_local(&local, vec![])));
    }
}
