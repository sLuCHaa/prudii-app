use chrono::NaiveDateTime;
use std::collections::HashSet;

const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return true;
    }
    let b = stem.as_bytes();
    b.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && (b'1'..=b'9').contains(&b[3])
}

pub fn safe_segment(name: &str, max_chars: usize) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '-' } else { c })
        .collect();
    let cut: String = replaced.chars().take(max_chars).collect();
    let mut out = cut.trim_matches(|c| c == '.' || c == ' ').to_string();
    if out.is_empty() {
        return "_".to_string();
    }
    if is_reserved(&out) {
        out.push('_');
    }
    out
}

pub fn mail_base_name(local: NaiveDateTime, subject: &str) -> String {
    let stamp = local.format("%Y-%m-%d_%H%M").to_string();
    let words = subject.split_whitespace().collect::<Vec<_>>().join("-");
    let words: String = words.chars().take(50).collect();
    if words.is_empty() {
        stamp
    } else {
        format!("{}_{}", stamp, words)
    }
}

pub fn attachment_name(raw: Option<&str>, index: usize) -> String {
    let last = raw
        .and_then(|r| r.rsplit(['/', '\\']).next())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match last {
        Some(name) => safe_segment(name, 50),
        None => format!("attachment-{}.bin", index),
    }
}

#[derive(Default)]
pub struct NameSet {
    used: HashSet<String>,
}

impl NameSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn claim(&mut self, base: &str) -> String {
        let (stem, ext) = match base.rfind('.') {
            Some(i) if i > 0 => (&base[..i], &base[i..]),
            _ => (base, ""),
        };
        let mut candidate = base.to_string();
        let mut n = 2;
        while !self.used.insert(candidate.to_lowercase()) {
            candidate = format!("{}-{}{}", stem, n, ext);
            n += 1;
        }
        candidate
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn base_name_has_date_time_and_subject() {
        let t = NaiveDate::from_ymd_opt(2026, 10, 21).unwrap().and_hms_opt(15, 28, 0).unwrap();
        assert_eq!(mail_base_name(t, "Angebot Neubau  Waldweg"), "2026-10-21_1528_Angebot-Neubau-Waldweg");
        assert_eq!(mail_base_name(t, "   "), "2026-10-21_1528");
    }

    #[test]
    fn segments_are_valid_on_every_os() {
        assert_eq!(safe_segment("Re: a/b\\c?*", 40), "Re- a-b-c--");
        assert_eq!(safe_segment("CON", 40), "CON_");
        assert_eq!(safe_segment("nul.txt", 40), "nul.txt_");
        assert_eq!(safe_segment(" ..Grüße 🎉.. ", 40), "Grüße 🎉");
        assert_eq!(safe_segment("", 40), "_");
        assert_eq!(safe_segment(&"ä".repeat(100), 10).chars().count(), 10);
    }

    #[test]
    fn attachment_names_never_leave_the_folder() {
        assert_eq!(attachment_name(Some("../../evil.exe"), 1), "evil.exe");
        assert_eq!(attachment_name(Some("C:\\x\\plan.pdf"), 1), "plan.pdf");
        assert_eq!(attachment_name(None, 3), "attachment-3.bin");
    }

    #[test]
    fn claimed_names_are_unique_case_insensitively() {
        let mut s = NameSet::new();
        assert_eq!(s.claim("Plan.pdf"), "Plan.pdf");
        assert_eq!(s.claim("plan.pdf"), "plan-2.pdf");
        assert_eq!(s.claim("Notiz"), "Notiz");
        assert_eq!(s.claim("notiz"), "notiz-2");
    }

    #[test]
    fn longest_relative_path_stays_short() {
        let long = "x".repeat(300);
        let t = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let path = format!(
            "{}/{}/{}/{}",
            safe_segment(&long, 30),
            safe_segment(&long, 30),
            safe_segment(&mail_base_name(t, &long), 70),
            attachment_name(Some(&long), 1)
        );
        assert!(path.chars().count() <= 180, "{}", path.chars().count());
    }
}
