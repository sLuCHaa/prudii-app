use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};

pub fn source_path(data_dir: &Path, mail_id: &str) -> PathBuf {
    data_dir.join("mail_sources").join(format!("{mail_id}.eml"))
}

pub fn write_source(data_dir: &Path, mail_id: &str, raw: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let path = source_path(data_dir, mail_id);
    let dir = data_dir.join("mail_sources");
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{mail_id}.eml.tmp"));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(raw)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn read_source(data_dir: &Path, mail_id: &str) -> std::io::Result<Vec<u8>> {
    std::fs::read(source_path(data_dir, mail_id))
}

pub fn has_source(data_dir: &Path, mail_id: &str) -> bool {
    std::fs::metadata(source_path(data_dir, mail_id)).is_ok_and(|m| m.is_file() && m.len() > 0)
}

pub struct UidlRow {
    pub uidl: String,
    pub mail_id: Option<String>,
    pub fetched_at: DateTime<Utc>,
    pub state: String,
    pub local_deleted_at: Option<String>,
}

pub enum DeleteMode {
    Keep,
    AfterFetch,
    AfterDays(i64),
}

pub struct DeletePolicy {
    pub mode: DeleteMode,
    pub with_local: bool,
}

pub fn plan_deletions(
    now: DateTime<Utc>,
    policy: &DeletePolicy,
    rows: &[UidlRow],
    server_uidls: &HashSet<String>,
) -> Vec<String> {
    rows.iter()
        .filter(|r| r.state == "stored" && r.mail_id.is_some() && server_uidls.contains(&r.uidl))
        .filter(|r| {
            let by_mode = match policy.mode {
                DeleteMode::Keep => false,
                DeleteMode::AfterFetch => true,
                DeleteMode::AfterDays(days) => r.fetched_at <= now - Duration::days(days),
            };
            by_mode || (policy.with_local && r.local_deleted_at.is_some())
        })
        .map(|r| r.uidl.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 27, 12, 0, 0).unwrap()
    }

    fn row(uidl: &str, days_ago: i64) -> UidlRow {
        UidlRow {
            uidl: uidl.into(),
            mail_id: Some(format!("mail-{uidl}")),
            fetched_at: now() - Duration::days(days_ago),
            state: "stored".into(),
            local_deleted_at: None,
        }
    }

    fn rows() -> Vec<UidlRow> {
        vec![row("u1", 15), row("u2", 3)]
    }

    fn server(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn policy(mode: DeleteMode, with_local: bool) -> DeletePolicy {
        DeletePolicy { mode, with_local }
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("prudii-pop3-store-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn keep_deletes_nothing() {
        let plan = plan_deletions(now(), &policy(DeleteMode::Keep, false), &rows(), &server(&["u1", "u2"]));
        assert!(plan.is_empty());
    }

    #[test]
    fn after_fetch_deletes_all_stored_on_server() {
        let plan = plan_deletions(now(), &policy(DeleteMode::AfterFetch, false), &rows(), &server(&["u1", "u2"]));
        assert_eq!(plan, vec!["u1", "u2"]);
    }

    #[test]
    fn after_days_14_deletes_only_old() {
        let plan = plan_deletions(now(), &policy(DeleteMode::AfterDays(14), false), &rows(), &server(&["u1", "u2"]));
        assert_eq!(plan, vec!["u1"]);
    }

    #[test]
    fn with_local_deletes_locally_deleted_even_in_keep() {
        let mut rows = rows();
        rows[1].local_deleted_at = Some("2026-11-26 10:00:00".into());
        let plan = plan_deletions(now(), &policy(DeleteMode::Keep, true), &rows, &server(&["u1", "u2"]));
        assert_eq!(plan, vec!["u2"]);
        let plan = plan_deletions(now(), &policy(DeleteMode::Keep, false), &rows, &server(&["u1", "u2"]));
        assert!(plan.is_empty());
    }

    #[test]
    fn never_deletes_uidl_missing_on_server() {
        let plan = plan_deletions(now(), &policy(DeleteMode::AfterFetch, false), &rows(), &server(&["u2"]));
        assert_eq!(plan, vec!["u2"]);
    }

    #[test]
    fn never_deletes_server_deleted_state() {
        let mut rows = rows();
        rows[0].state = "server_deleted".into();
        let plan = plan_deletions(now(), &policy(DeleteMode::AfterFetch, true), &rows, &server(&["u1", "u2"]));
        assert_eq!(plan, vec!["u2"]);
    }

    #[test]
    fn never_deletes_row_without_mail_id() {
        let mut rows = rows();
        rows[0].mail_id = None;
        let plan = plan_deletions(now(), &policy(DeleteMode::AfterFetch, true), &rows, &server(&["u1", "u2"]));
        assert_eq!(plan, vec!["u2"]);
    }

    #[test]
    fn write_source_round_trips_and_leaves_no_temp_file() {
        let dir = temp_dir();
        write_source(&dir, "m1", b"From: Anna Weber <anna@studio-halde.example>\r\n\r\nHallo").unwrap();
        assert!(has_source(&dir, "m1"));
        assert_eq!(read_source(&dir, "m1").unwrap(), b"From: Anna Weber <anna@studio-halde.example>\r\n\r\nHallo");
        let count = std::fs::read_dir(dir.join("mail_sources")).unwrap().count();
        assert_eq!(count, 1);
    }

    #[test]
    fn has_source_is_false_for_missing_and_empty_files() {
        let dir = temp_dir();
        assert!(!has_source(&dir, "m1"));
        write_source(&dir, "m1", b"").unwrap();
        assert!(!has_source(&dir, "m1"));
    }

    #[test]
    fn write_source_overwrites_existing_file() {
        let dir = temp_dir();
        write_source(&dir, "m1", b"alt").unwrap();
        write_source(&dir, "m1", b"neu").unwrap();
        assert_eq!(read_source(&dir, "m1").unwrap(), b"neu");
    }
}
