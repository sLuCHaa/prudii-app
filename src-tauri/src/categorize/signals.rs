use serde_json::{Map, Value};

pub const SIGNAL_HEADERS: &[&str] = &[
    "List-Id",
    "Precedence",
    "Auto-Submitted",
    "Feedback-ID",
    "X-Mailer",
    "X-Mailgun-Sid",
    "X-SG-EID",
    "X-MC-User",
    "X-SES-Outgoing",
    "X-CSA-Complaints",
];

pub const GMAIL_CATEGORY_KEY: &str = "x-gmail-category";

const MAX_VALUE_CHARS: usize = 200;

pub fn signal_headers_json(lookup: impl Fn(&str) -> Option<String>, gmail_category: Option<&str>) -> String {
    let mut map = Map::new();
    for name in SIGNAL_HEADERS {
        if let Some(value) = lookup(name) {
            let value: String = value.trim().chars().take(MAX_VALUE_CHARS).collect();
            if !value.is_empty() {
                map.insert(name.to_ascii_lowercase(), Value::String(value));
            }
        }
    }
    if let Some(category) = gmail_category {
        map.insert(GMAIL_CATEGORY_KEY.to_string(), Value::String(category.to_string()));
    }
    Value::Object(map).to_string()
}

pub fn gmail_category_from_labels(label_ids: &[String]) -> Option<&'static str> {
    label_ids.iter().find_map(|l| match l.as_str() {
        "CATEGORY_SOCIAL" => Some("social"),
        "CATEGORY_PROMOTIONS" => Some("promotions"),
        "CATEGORY_UPDATES" => Some("updates"),
        "CATEGORY_FORUMS" => Some("forums"),
        _ => None,
    })
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct HeaderSignals {
    pub list_id: bool,
    pub unsubscribe: bool,
    pub precedence_bulk: bool,
    pub auto_submitted: bool,
    pub feedback_id: bool,
    pub esp: Option<&'static str>,
    pub gmail_category: Option<String>,
}

const ESP_HEADERS: &[(&str, &str)] = &[
    ("x-mailgun-sid", "Mailgun"),
    ("x-sg-eid", "SendGrid"),
    ("x-mc-user", "Mailchimp"),
    ("x-ses-outgoing", "Amazon SES"),
];

const ESP_MAILERS: &[(&str, &str)] = &[
    ("mailchimp", "Mailchimp"),
    ("brevo", "Brevo"),
    ("sendinblue", "Brevo"),
    ("hubspot", "HubSpot"),
    ("klaviyo", "Klaviyo"),
    ("cleverreach", "CleverReach"),
    ("rapidmail", "rapidmail"),
    ("mailjet", "Mailjet"),
];

impl HeaderSignals {
    pub fn parse(signal_headers: &str, list_unsubscribe: &str) -> Self {
        let map = match serde_json::from_str::<Value>(signal_headers) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        let get = |key: &str| map.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("");

        let precedence = get("precedence").to_ascii_lowercase();
        let auto_submitted = get("auto-submitted").to_ascii_lowercase();
        let mailer = get("x-mailer").to_ascii_lowercase();

        let esp = ESP_HEADERS
            .iter()
            .find(|(key, _)| map.contains_key(*key))
            .map(|(_, name)| *name)
            .or_else(|| ESP_MAILERS.iter().find(|(needle, _)| mailer.contains(needle)).map(|(_, name)| *name));

        Self {
            list_id: !get("list-id").is_empty(),
            unsubscribe: !list_unsubscribe.trim().is_empty(),
            precedence_bulk: matches!(precedence.as_str(), "bulk" | "list" | "junk") || map.contains_key("x-csa-complaints"),
            auto_submitted: !auto_submitted.is_empty() && auto_submitted != "no",
            feedback_id: !get("feedback-id").is_empty(),
            esp,
            gmail_category: Some(get(GMAIL_CATEGORY_KEY)).filter(|c| !c.is_empty()).map(str::to_string),
        }
    }

    pub fn is_bulk(&self) -> bool {
        self.list_id || self.unsubscribe || self.precedence_bulk
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn json_keeps_only_known_present_headers() {
        let lookup = |name: &str| match name {
            "List-Id" => Some("<wochenrueckblick.designweekly.example>".to_string()),
            "X-Unknown" => Some("x".to_string()),
            "Precedence" => Some("   ".to_string()),
            _ => None,
        };
        let v: Value = serde_json::from_str(&signal_headers_json(lookup, None)).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        assert_eq!(obj["list-id"], "<wochenrueckblick.designweekly.example>");
    }

    #[test]
    fn json_truncates_and_adds_gmail_category() {
        let lookup = |name: &str| (name == "X-Mailer").then(|| "a".repeat(300));
        let v: Value = serde_json::from_str(&signal_headers_json(lookup, Some("social"))).unwrap();
        assert_eq!(v["x-mailer"].as_str().unwrap().chars().count(), 200);
        assert_eq!(v[GMAIL_CATEGORY_KEY], "social");
    }

    #[test]
    fn empty_lookup_gives_empty_object() {
        assert_eq!(signal_headers_json(|_| None, None), "{}");
    }

    #[test]
    fn auto_submitted_no_is_not_automated() {
        assert!(!HeaderSignals::parse(r#"{"auto-submitted":"No"}"#, "").auto_submitted);
        assert!(HeaderSignals::parse(r#"{"auto-submitted":"auto-generated"}"#, "").auto_submitted);
    }

    #[test]
    fn precedence_is_case_insensitive() {
        let s = HeaderSignals::parse(r#"{"precedence":" BULK "}"#, "");
        assert!(s.precedence_bulk);
        assert!(s.is_bulk());
    }

    #[test]
    fn esp_from_header_and_mailer() {
        assert_eq!(HeaderSignals::parse(r#"{"x-sg-eid":"abc"}"#, "").esp, Some("SendGrid"));
        assert_eq!(HeaderSignals::parse(r#"{"x-mailer":"Brevo Mailer 3"}"#, "").esp, Some("Brevo"));
    }

    #[test]
    fn unsubscribe_from_column() {
        let s = HeaderSignals::parse("{}", "<mailto:abmelden@designweekly.example>");
        assert!(s.unsubscribe && s.is_bulk());
    }

    #[test]
    fn garbage_json_is_empty() {
        assert_eq!(HeaderSignals::parse("not json", ""), HeaderSignals::default());
    }

    #[test]
    fn gmail_labels_map() {
        let labels = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(gmail_category_from_labels(&labels(&["INBOX", "CATEGORY_PROMOTIONS"])), Some("promotions"));
        assert_eq!(gmail_category_from_labels(&labels(&["CATEGORY_PERSONAL"])), None);
    }
}
