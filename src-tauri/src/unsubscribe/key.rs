use crate::categorize::signals::HeaderSignals;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyKind {
    ListId,
    Sender,
}

impl KeyKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            KeyKind::ListId => "list_id",
            KeyKind::Sender => "sender",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "list_id" => Some(KeyKind::ListId),
            "sender" => Some(KeyKind::Sender),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListKey {
    pub kind: KeyKind,
    pub value: String,
}

pub struct MailFacts<'a> {
    pub from_email: &'a str,
    pub signal_headers: &'a str,
    pub list_unsubscribe: &'a str,
}

/// `List-Id: Name <id>` reduced to the lowercase id, so display-name and case changes keep the list.
pub fn list_id_value(signal_headers: &str) -> Option<String> {
    let map: serde_json::Value = serde_json::from_str(signal_headers).ok()?;
    let raw = map.get("list-id")?.as_str()?;
    let id = match (raw.rfind('<'), raw.rfind('>')) {
        (Some(start), Some(end)) if start < end => &raw[start + 1..end],
        _ => raw,
    };
    let id = id.trim().to_lowercase();
    (!id.is_empty()).then_some(id)
}

/// On a mailing list the From name is whoever posted, so the list's own name labels the entry.
pub fn list_id_name(signal_headers: &str) -> Option<String> {
    let map: serde_json::Value = serde_json::from_str(signal_headers).ok()?;
    let raw = map.get("list-id")?.as_str()?;
    let name = raw[..raw.rfind('<')?].trim().trim_matches('"').trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub fn sender_key(from_email: &str) -> Option<ListKey> {
    let address = from_email.trim().to_lowercase();
    address.contains('@').then_some(ListKey { kind: KeyKind::Sender, value: address })
}

fn is_bulk(m: &MailFacts) -> bool {
    HeaderSignals::parse(m.signal_headers, m.list_unsubscribe).is_bulk()
}

pub fn list_key(m: &MailFacts) -> Option<ListKey> {
    if let Some(value) = list_id_value(m.signal_headers) {
        return Some(ListKey { kind: KeyKind::ListId, value });
    }
    if is_bulk(m) { sender_key(m.from_email) } else { None }
}

/// Sender keys only catch bulk mail unless blocked: a shop's receipts share the newsletter's address.
pub fn matches(kind: &KeyKind, value: &str, blocked: bool, m: &MailFacts) -> bool {
    match kind {
        KeyKind::ListId => list_id_value(m.signal_headers).as_deref() == Some(value),
        KeyKind::Sender => {
            m.from_email.trim().eq_ignore_ascii_case(value) && (blocked || is_bulk(m))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BULK: &str = "<https://news.halde-shop.example/u>";

    fn facts<'a>(from: &'a str, headers: &'a str, unsub: &'a str) -> MailFacts<'a> {
        MailFacts { from_email: from, signal_headers: headers, list_unsubscribe: unsub }
    }

    #[test]
    fn list_id_is_normalized() {
        assert_eq!(list_id_value(r#"{"list-id":"Wochenrückblick <WR.Halde-Shop.example>"}"#).as_deref(), Some("wr.halde-shop.example"));
        assert_eq!(list_id_value(r#"{"list-id":" wr.halde-shop.example "}"#).as_deref(), Some("wr.halde-shop.example"));
        assert_eq!(list_id_value("{}"), None);
    }

    #[test]
    fn bulk_mail_without_list_id_keys_on_exact_sender() {
        assert_eq!(
            list_key(&facts("News@Halde-Shop.example", "{}", BULK)),
            Some(ListKey { kind: KeyKind::Sender, value: "news@halde-shop.example".into() })
        );
    }

    #[test]
    fn personal_mail_has_no_list_key() {
        assert_eq!(list_key(&facts("anna.weber@studio-halde.example", "{}", "")), None);
    }

    #[test]
    fn sender_entry_ignores_transactional_mail() {
        let receipt = facts("info@halde-shop.example", "{}", "");
        assert!(!matches(&KeyKind::Sender, "info@halde-shop.example", false, &receipt));
        assert!(matches(&KeyKind::Sender, "info@halde-shop.example", true, &receipt));
    }

    #[test]
    fn sender_entry_never_matches_other_address_on_same_domain() {
        assert!(!matches(&KeyKind::Sender, "news@halde-shop.example", false, &facts("shop@halde-shop.example", "{}", BULK)));
    }

    #[test]
    fn list_id_entry_matches_any_sender_address() {
        let other = facts("news2@halde-shop.example", r#"{"list-id":"<wr.halde-shop.example>"}"#, BULK);
        assert!(matches(&KeyKind::ListId, "wr.halde-shop.example", false, &other));
    }

    #[test]
    fn list_id_name_is_the_display_part() {
        assert_eq!(list_id_name(r#"{"list-id":"Studio-Halde-Forum <forum.studio-halde.example>"}"#).as_deref(), Some("Studio-Halde-Forum"));
        assert_eq!(list_id_name(r#"{"list-id":"\"Wochenrückblick\" <wr.halde-shop.example>"}"#).as_deref(), Some("Wochenrückblick"));
        assert_eq!(list_id_name(r#"{"list-id":"<wr.halde-shop.example>"}"#), None);
        assert_eq!(list_id_name("{}"), None);
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [KeyKind::ListId, KeyKind::Sender] {
            assert_eq!(KeyKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(KeyKind::parse("domain"), None);
    }
}
