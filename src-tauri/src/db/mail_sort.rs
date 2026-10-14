use rusqlite::functions::FunctionFlags;

const REPLY_PREFIXES: [&str; 5] = ["re", "aw", "fwd", "fw", "wg"];

/// Subject without reply/forward prefixes, lowercased, for sorting.
pub fn sort_subject(subject: &str) -> String {
    let mut rest = subject.trim_start();
    'strip: loop {
        for prefix in REPLY_PREFIXES {
            let Some(head) = rest.get(..prefix.len()) else { continue };
            if !head.eq_ignore_ascii_case(prefix) {
                continue;
            }
            if let Some(stripped) = rest[prefix.len()..].trim_start().strip_prefix(':') {
                rest = stripped.trim_start();
                continue 'strip;
            }
        }
        break;
    }
    rest.to_lowercase()
}

pub fn register_functions(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "sort_subject",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let subject: Option<String> = ctx.get(0)?;
            Ok(sort_subject(subject.as_deref().unwrap_or("")))
        },
    )
}

/// Outgoing mail sorts by its first recipient, everything else by its sender.
fn correspondent(p: &str) -> String {
    format!(
        "(CASE WHEN {p}folder_id IN (SELECT id FROM folders WHERE folder_type IN ('sent', 'drafts')) \
              OR LOWER({p}from_email) IN (SELECT LOWER(email) FROM accounts) \
         THEN CASE WHEN json_valid({p}to_json) \
                   THEN COALESCE(NULLIF(json_extract({p}to_json, '$[0].name'), ''), json_extract({p}to_json, '$[0].email'), '') \
                   ELSE '' END \
         ELSE COALESCE(NULLIF({p}from_name, ''), {p}from_email) END) COLLATE NOCASE"
    )
}

pub fn order_clause(sort: Option<&str>, p: &str, pinned_first: bool) -> String {
    let keys = match sort.unwrap_or("date_desc") {
        "date_asc" => format!("{p}date ASC, {p}id ASC"),
        "subject_asc" => format!("sort_subject({p}subject) ASC, {p}date DESC, {p}id DESC"),
        "subject_desc" => format!("sort_subject({p}subject) DESC, {p}date DESC, {p}id DESC"),
        "correspondent_asc" => format!("{} ASC, {p}date DESC, {p}id DESC", correspondent(p)),
        "correspondent_desc" => format!("{} DESC, {p}date DESC, {p}id DESC", correspondent(p)),
        _ => format!("{p}date DESC, {p}id DESC"),
    };
    if pinned_first {
        format!("{p}is_pinned DESC, {keys}")
    } else {
        keys
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_stacked_reply_and_forward_prefixes() {
        assert_eq!(sort_subject("Re: AW: Fwd: Angebot"), "angebot");
        assert_eq!(sort_subject("re:angebot"), "angebot");
        assert_eq!(sort_subject("  WG: Re:  X"), "x");
        assert_eq!(sort_subject("FW: Bericht"), "bericht");
    }

    #[test]
    fn keeps_words_that_only_start_like_a_prefix() {
        assert_eq!(sort_subject("Antwort"), "antwort");
        assert_eq!(sort_subject("Rechnung"), "rechnung");
        assert_eq!(sort_subject("Fwdx: a"), "fwdx: a");
    }

    #[test]
    fn handles_empty_and_non_ascii_subjects() {
        assert_eq!(sort_subject(""), "");
        assert_eq!(sort_subject("Re:"), "");
        assert_eq!(sort_subject("Ärger"), "ärger");
        assert_eq!(sort_subject("Ré: x"), "ré: x");
    }

    #[test]
    fn unknown_sort_falls_back_to_newest_first() {
        assert_eq!(order_clause(None, "m.", false), "m.date DESC, m.id DESC");
        assert_eq!(order_clause(Some("bogus; DROP TABLE mails"), "m.", false), "m.date DESC, m.id DESC");
    }

    #[test]
    fn pinned_first_prefixes_every_sort() {
        assert!(order_clause(Some("subject_asc"), "mails.", true).starts_with("mails.is_pinned DESC, sort_subject(mails.subject) ASC"));
        assert_eq!(order_clause(Some("date_asc"), "m.", true), "m.is_pinned DESC, m.date ASC, m.id ASC");
    }
}
