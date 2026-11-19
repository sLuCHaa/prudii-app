use lettre::message::header::{HeaderName, HeaderValue};
use lettre::message::MessageBuilder;

/// Outlook reads X-Priority and Importance, older Exchange X-MSMail-Priority.
pub const HIGH_PRIORITY_HEADERS: [(&str, &str); 3] = [
    ("X-Priority", "1 (Highest)"),
    ("X-MSMail-Priority", "High"),
    ("Importance", "High"),
];

pub fn with_high_priority(builder: MessageBuilder) -> MessageBuilder {
    HIGH_PRIORITY_HEADERS.iter().fold(builder, |b, (name, value)| {
        b.raw_header(HeaderValue::new(HeaderName::new_from_ascii_str(name), value.to_string()))
    })
}

pub fn is_high_priority(lookup: impl Fn(&str) -> Option<String>) -> bool {
    let x_priority = lookup("X-Priority")
        .and_then(|v| v.trim_start().chars().next())
        .is_some_and(|c| c == '1' || c == '2');
    x_priority || lookup("Importance").is_some_and(|v| v.trim().eq_ignore_ascii_case("high"))
}

pub fn is_high_importance(importance: Option<&str>) -> bool {
    importance.is_some_and(|v| v.eq_ignore_ascii_case("high"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn x_priority_one_and_two_are_high() {
        for value in ["1", "1 (Highest)", " 2 (High)"] {
            assert!(is_high_priority(headers(&[("X-Priority", value)])), "{value:?}");
        }
    }

    #[test]
    fn normal_low_and_garbage_are_not_high() {
        for value in ["3 (Normal)", "5 (Lowest)", "", "high"] {
            assert!(!is_high_priority(headers(&[("X-Priority", value)])), "{value:?}");
        }
        assert!(!is_high_priority(headers(&[])));
    }

    #[test]
    fn importance_header_is_case_insensitive() {
        assert!(is_high_priority(headers(&[("Importance", "HIGH")])));
        assert!(!is_high_priority(headers(&[("Importance", "low")])));
        assert!(!is_high_priority(headers(&[("Importance", "normal")])));
    }

    #[test]
    fn graph_importance() {
        assert!(is_high_importance(Some("high")));
        assert!(is_high_importance(Some("High")));
        assert!(!is_high_importance(Some("normal")));
        assert!(!is_high_importance(None));
    }

    #[test]
    fn old_request_without_field_is_normal() {
        let json = r#"{"account_id":"a","to":["anna.weber@studio-halde.example"],"cc":[],"bcc":[],"subject":"Angebot","body_text":"Hallo","body_html":null,"in_reply_to":null,"references":null,"attachments":null}"#;
        let request: crate::models::SendMailRequest = serde_json::from_str(json).unwrap();
        assert!(!request.high_priority);
    }
}
