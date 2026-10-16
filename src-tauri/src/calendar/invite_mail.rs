//! Finding the iCalendar part of an incoming mail.

use super::ical::parse_calendar;
use mail_parser::{Message, MessagePart, MimeHeaders, PartType};

/// One calendar body found in a mail.
#[derive(Debug, Clone, PartialEq)]
pub struct InviteCandidate {
    pub text: String,
    /// `method=` of the part's Content-Type, upper-case.
    pub method_param: Option<String>,
    /// Part of the message body rather than a file attachment.
    pub inline: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FoundInvite {
    pub method: String,
    pub ics: String,
}

// Real invitations are a few KB; the cap keeps hostile mails cheap to read.
pub const MAX_ICS_BYTES: usize = 1024 * 1024;

pub fn is_calendar_part(mime: &str, filename: Option<&str>) -> bool {
    let mime = mime.trim().to_ascii_lowercase();
    mime == "text/calendar"
        || mime == "application/ics"
        || mime == "text/x-vcalendar"
        || filename.is_some_and(|n| n.trim().to_ascii_lowercase().ends_with(".ics"))
}

pub fn method_param(content_type: &str) -> Option<String> {
    content_type
        .split(';')
        .skip(1)
        .find_map(|p| {
            let (k, v) = p.split_once('=')?;
            k.trim().eq_ignore_ascii_case("method").then(|| v.trim().trim_matches('"').to_ascii_uppercase())
        })
        .filter(|m| !m.is_empty())
}

/// Senders attach an `invite.ics` copy next to the inline part; the inline one wins.
pub fn choose(candidates: Vec<InviteCandidate>) -> Option<FoundInvite> {
    let mut sorted = candidates;
    sorted.sort_by_key(|c| !c.inline);
    sorted.into_iter().filter(|c| c.text.len() <= MAX_ICS_BYTES).find_map(|c| {
        let parsed = parse_calendar(&c.text);
        let has_event = !parsed.events.is_empty() || c.text.to_ascii_uppercase().contains("BEGIN:VEVENT");
        if !parsed.has_calendar || !has_event {
            return None;
        }
        let method = parsed.method.or(c.method_param).unwrap_or_else(|| "PUBLISH".into());
        Some(FoundInvite { method, ics: c.text })
    })
}

fn part_mime(part: &MessagePart) -> String {
    part.content_type()
        .map(|ct| format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("")))
        .unwrap_or_default()
}

/// The invitation sent as part of the message: no file name and not declared an attachment.
pub fn is_inline_calendar(part: &MessagePart) -> bool {
    part.attachment_name().is_none()
        && is_calendar_part(&part_mime(part), None)
        && part.content_disposition().map(|d| !d.ctype().eq_ignore_ascii_case("attachment")).unwrap_or(true)
}

pub fn candidates_from_message(msg: &Message) -> Vec<InviteCandidate> {
    msg.parts
        .iter()
        .filter_map(|part| {
            if !is_calendar_part(&part_mime(part), part.attachment_name()) {
                return None;
            }
            let text = match &part.body {
                PartType::Text(t) | PartType::Html(t) => t.to_string(),
                PartType::Binary(b) | PartType::InlineBinary(b) => String::from_utf8_lossy(b).into_owned(),
                _ => return None,
            };
            Some(InviteCandidate {
                text,
                method_param: part.content_type().and_then(|ct| ct.attribute("method")).map(|m| m.trim().to_ascii_uppercase()),
                inline: is_inline_calendar(part),
            })
        })
        .collect()
}

/// For providers that hand out invitations only in the raw message (Graph).
pub fn find_in_mime(raw: &[u8]) -> Option<FoundInvite> {
    let msg = mail_parser::MessageParser::default().parse(raw)?;
    choose(candidates_from_message(&msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T070000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const NO_METHOD: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T070000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn cand(text: &str, param: Option<&str>, inline: bool) -> InviteCandidate {
        InviteCandidate { text: text.into(), method_param: param.map(str::to_string), inline }
    }

    #[test]
    fn recognises_calendar_parts_by_type_or_file_name() {
        assert!(is_calendar_part("text/calendar", None));
        assert!(is_calendar_part("Application/ICS", None));
        assert!(is_calendar_part("application/octet-stream", Some("Invite.ICS")));
        assert!(!is_calendar_part("text/plain", Some("notes.txt")));
    }

    #[test]
    fn reads_the_method_parameter() {
        assert_eq!(method_param("text/calendar; charset=\"UTF-8\"; method=request").as_deref(), Some("REQUEST"));
        assert_eq!(method_param("text/calendar; METHOD=\"CANCEL\"").as_deref(), Some("CANCEL"));
        assert_eq!(method_param("text/calendar; charset=UTF-8"), None);
    }

    #[test]
    fn the_inline_part_wins_and_the_calendar_method_beats_the_header() {
        let found = choose(vec![cand(NO_METHOD, None, false), cand(REQUEST, Some("CANCEL"), true)]).unwrap();
        assert_eq!(found, FoundInvite { method: "REQUEST".into(), ics: REQUEST.into() });
    }

    #[test]
    fn falls_back_to_the_parameter_then_publish() {
        assert_eq!(choose(vec![cand(NO_METHOD, Some("CANCEL"), true)]).unwrap().method, "CANCEL");
        assert_eq!(choose(vec![cand(NO_METHOD, None, false)]).unwrap().method, "PUBLISH");
    }

    #[test]
    fn rejects_text_that_is_not_a_calendar_or_too_large() {
        assert_eq!(choose(vec![cand("hello", None, true)]), None);
        assert_eq!(choose(vec![cand("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", None, true)]), None);
        let huge = format!("{}X-PAD:{}\r\n", REQUEST, "x".repeat(MAX_ICS_BYTES));
        assert_eq!(choose(vec![cand(&huge, None, true)]), None);
    }

    #[test]
    fn finds_the_invitation_in_a_mime_message() {
        let raw = format!(
            "From: robin@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"m\"\r\n\r\n--m\r\nContent-Type: multipart/alternative; boundary=\"a\"\r\n\r\n--a\r\nContent-Type: text/plain\r\n\r\nInvited\r\n--a\r\nContent-Type: text/calendar; method=REQUEST; charset=UTF-8\r\n\r\n{}\r\n--a--\r\n--m\r\nContent-Type: application/ics; name=\"invite.ics\"\r\nContent-Disposition: attachment; filename=\"invite.ics\"\r\n\r\n{}\r\n--m--\r\n",
            REQUEST, NO_METHOD
        );
        let msg = mail_parser::MessageParser::default().parse(raw.as_bytes()).unwrap();
        let cands = candidates_from_message(&msg);
        assert_eq!(cands.iter().map(|c| c.inline).collect::<Vec<_>>(), vec![true, false]);
        assert_eq!(cands[0].method_param.as_deref(), Some("REQUEST"));
        assert_eq!(find_in_mime(raw.as_bytes()).unwrap().method, "REQUEST");
        let inline: Vec<bool> = msg.attachments().map(is_inline_calendar).collect();
        assert_eq!(inline, vec![true, false]);
    }
}
