pub mod client;
pub mod store;
pub mod sync;
#[cfg(test)]
pub(crate) mod test_server;

pub use client::{connect, Pop3Client, Pop3Session, MAX_MESSAGE_BYTES};

/// Only for permanent deletes by the user: the next sync may then remove the server copy.
pub(crate) fn mark_locally_deleted(
    conn: &rusqlite::Connection,
    account_id: &str,
    mail_ids: &[String],
) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(
        "UPDATE pop3_uidls SET local_deleted_at = datetime('now') WHERE account_id = ?1 AND mail_id = ?2",
    )?;
    mail_ids.iter().try_fold(0, |changed, mail_id| {
        Ok(changed + stmt.execute([account_id, mail_id.as_str()])?)
    })
}

/// Removes raw sources that neither a mail nor a pending server copy needs; a failed lookup keeps the file.
pub(crate) fn discard_orphan_sources(conn: &rusqlite::Connection, data_dir: &std::path::Path, mail_ids: &[String]) {
    for mail_id in mail_ids.iter().filter(|id| crate::safe_path::is_safe_mail_id(id)) {
        let needed: rusqlite::Result<bool> = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mails WHERE id = ?1)
                 OR EXISTS(SELECT 1 FROM pop3_uidls WHERE mail_id = ?1 AND state IN ('stored','restored'))",
            [mail_id],
            |r| r.get(0),
        );
        if !matches!(needed, Ok(false)) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(store::source_path(data_dir, mail_id)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("POP3: could not remove an unused raw source: {}", e);
            }
        }
    }
}

const DAY: u64 = 86_400;

/// Clears leftovers in mail_sources, orphaned sources via quarantine; the age limits protect files still being written.
pub(crate) fn cleanup_stray_sources(
    conn: &rusqlite::Connection,
    data_dir: &std::path::Path,
    now: std::time::SystemTime,
) -> usize {
    let dir = data_dir.join("mail_sources");
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let Ok(references) = source_references(conn) else {
        log::warn!("POP3: could not list referenced raw sources, nothing cleaned up");
        return 0;
    };
    // A new or reset database references nothing, which says nothing about the files.
    let has_mails = references.iter().any(|(_, is_mail)| *is_mail);
    let referenced: std::collections::HashSet<String> = references.into_iter().map(|(id, _)| id).collect();
    let quarantine = dir.join("orphaned");
    let mut cleaned = if has_mails { purge_quarantine(&quarantine, now) } else { 0 };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let done = if name.ends_with(".eml.tmp") {
            is_older(&entry, now, DAY) && std::fs::remove_file(entry.path()).is_ok()
        } else {
            match name.strip_suffix(".eml") {
                Some(id) if has_mails && !referenced.contains(id) && is_older(&entry, now, 7 * DAY) => {
                    match quarantine_source(&entry.path(), &quarantine, id, now) {
                        Ok(()) => true,
                        Err(e) => {
                            log::warn!("POP3: could not set an unused raw source aside: {}", e.kind());
                            false
                        }
                    }
                }
                _ => false,
            }
        };
        cleaned += usize::from(done);
    }
    if cleaned > 0 {
        log::info!("POP3: cleaned up {} stray raw source files", cleaned);
    }
    cleaned
}

fn is_older(entry: &std::fs::DirEntry, now: std::time::SystemTime, seconds: u64) -> bool {
    entry
        .metadata()
        .and_then(|m| m.modified())
        .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age.as_secs() >= seconds))
}

/// The mtime becomes the move time, which starts the retention period.
fn quarantine_source(
    path: &std::path::Path,
    quarantine: &std::path::Path,
    id: &str,
    now: std::time::SystemTime,
) -> std::io::Result<()> {
    std::fs::create_dir_all(quarantine)?;
    let raw = std::fs::read(path)?;
    let mut target = quarantine.join(format!("{id}.eml"));
    let mut counter = 0;
    while target.try_exists()? && std::fs::read(&target)? != raw {
        counter += 1;
        target = quarantine.join(format!("{id}.{counter}.eml"));
    }
    std::fs::File::options().write(true).open(path)?.set_modified(now)?;
    std::fs::rename(path, target)
}

fn purge_quarantine(quarantine: &std::path::Path, now: std::time::SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(quarantine) else { return 0 };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && is_older(e, now, 30 * DAY))
        .filter(|e| std::fs::remove_file(e.path()).is_ok())
        .count()
}

/// Ids whose source must stay; the flag marks ids of mail rows.
fn source_references(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, bool)>> {
    let mut stmt = conn.prepare(
        "SELECT id, 1 FROM mails
         UNION ALL
         SELECT mail_id, 0 FROM pop3_uidls WHERE mail_id IS NOT NULL AND state IN ('stored','restored')",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pop3Security {
    Ssl,
    StartTls,
}

impl std::str::FromStr for Pop3Security {
    type Err = Pop3Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ssl" => Ok(Self::Ssl),
            "starttls" => Ok(Self::StartTls),
            other => Err(Pop3Error::Protocol(format!(
                "unknown security mode: {other}"
            ))),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Pop3Error {
    #[error("connection error: {0}")]
    Io(String),
    #[error("the server did not respond in time")]
    Timeout,
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("unexpected server response: {0}")]
    Protocol(String),
    #[error("the server does not support UIDL")]
    NoUidl,
    #[error("the mailbox is locked: {0}")]
    Locked(String),
    #[error("the message is too large ({0} bytes)")]
    TooLarge(u64),
    #[error("database error: {0}")]
    Database(String),
    #[error("could not store the mail: {0}")]
    Storage(String),
    #[error("the account has no inbox folder")]
    NoInbox,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::db::Database;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};

    fn seeded() -> (Database, String, String) {
        let db = temp_db();
        let (account, mail) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "anna@studio-halde.example");
            let inbox = seed_folder(&conn, &account, "inbox");
            let mail = seed_mail(&conn, &SeedMail { account_id: &account, folder_id: &inbox, ..Default::default() });
            (account, mail)
        };
        (db, account, mail)
    }

    fn file(db: &Database, name: &str) -> PathBuf {
        let dir = db.data_dir.join("mail_sources");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, b"Subject: Angebot\r\n\r\nHallo").unwrap();
        path
    }

    fn cleanup_at(db: &Database, now: SystemTime) -> usize {
        cleanup_stray_sources(&db.lock_db(), &db.data_dir, now)
    }

    fn quarantined(db: &Database, name: &str) -> PathBuf {
        db.data_dir.join("mail_sources").join("orphaned").join(name)
    }

    #[test]
    fn cleanup_quarantines_orphans_and_deletes_them_after_thirty_days() {
        let (db, ..) = seeded();
        let eml = file(&db, "stray.eml");
        let now = SystemTime::now() + Duration::from_secs(8 * 86400);
        assert_eq!(cleanup_at(&db, now), 1);
        let moved = quarantined(&db, "stray.eml");
        assert!(!eml.exists() && moved.exists());
        let age = std::fs::metadata(&moved).unwrap().modified().unwrap().duration_since(now);
        assert!(age.map_or_else(|e| e.duration(), |d| d) < Duration::from_secs(1));
        assert_eq!(cleanup_at(&db, now + Duration::from_secs(29 * 86400)), 0);
        assert!(moved.exists());
        assert_eq!(cleanup_at(&db, now + Duration::from_secs(31 * 86400)), 1);
        assert!(!moved.exists());
    }

    #[test]
    fn quarantine_never_overwrites_a_different_file() {
        let (db, ..) = seeded();
        std::fs::create_dir_all(db.data_dir.join("mail_sources").join("orphaned")).unwrap();
        std::fs::write(quarantined(&db, "stray.eml"), b"Subject: Alt").unwrap();
        let eml = file(&db, "stray.eml");
        assert_eq!(cleanup_after(&db, 8 * 86400), 1);
        assert!(!eml.exists());
        assert_eq!(std::fs::read(quarantined(&db, "stray.eml")).unwrap(), b"Subject: Alt");
        assert_eq!(std::fs::read(quarantined(&db, "stray.1.eml")).unwrap(), b"Subject: Angebot\r\n\r\nHallo");
        file(&db, "stray.eml");
        assert_eq!(cleanup_after(&db, 8 * 86400), 1);
        assert_eq!(std::fs::read_dir(db.data_dir.join("mail_sources").join("orphaned")).unwrap().count(), 2);
    }

    #[test]
    fn discard_ignores_ids_that_leave_the_source_folder() {
        let (db, ..) = seeded();
        file(&db, "keep.eml");
        let outside = db.data_dir.join("outside.eml");
        std::fs::write(&outside, b"fremd").unwrap();
        discard_orphan_sources(&db.lock_db(), &db.data_dir, &["../outside".to_string()]);
        assert!(outside.exists());
        assert!(!store::has_source(&db.data_dir, "../outside"));
        assert!(store::read_source(&db.data_dir, "../outside").is_err());
        assert!(store::write_source(&db.data_dir, "../outside", b"neu").is_err());
        assert!(store::move_source(&db.data_dir, "keep", "../outside").is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"fremd");
    }

    fn cleanup_after(db: &Database, seconds: u64) -> usize {
        cleanup_at(db, SystemTime::now() + Duration::from_secs(seconds))
    }

    #[test]
    fn cleanup_removes_old_unreferenced_sources_and_tmp_files() {
        let (db, ..) = seeded();
        let eml = file(&db, "stray.eml");
        let tmp = file(&db, "stray.eml.tmp");
        let other = file(&db, "notes.txt");
        let folder = db.data_dir.join("mail_sources").join("folder.eml");
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(cleanup_after(&db, 8 * 86400), 2);
        assert!(!eml.exists() && !tmp.exists());
        assert!(other.exists() && folder.exists());
    }

    #[test]
    fn cleanup_keeps_young_files() {
        let (db, ..) = seeded();
        let eml = file(&db, "stray.eml");
        let tmp = file(&db, "stray.eml.tmp");
        assert_eq!(cleanup_after(&db, 3600), 0);
        assert_eq!(cleanup_at(&db, SystemTime::now() - Duration::from_secs(30 * 86400)), 0);
        assert!(eml.exists() && tmp.exists());
        assert_eq!(cleanup_after(&db, 2 * 86400), 1);
        assert!(eml.exists() && !tmp.exists());
    }

    #[test]
    fn cleanup_keeps_sources_of_mails_and_pending_server_deletes() {
        let (db, account, mail) = seeded();
        let other_mail = {
            let conn = db.lock_db();
            let other = seed_account(&conn, "info@studio-halde.example");
            let inbox = seed_folder(&conn, &other, "inbox");
            for (uidl, state) in [("u1", "stored"), ("u2", "restored"), ("u3", "server_deleted")] {
                conn.execute(
                    "INSERT INTO pop3_uidls (account_id, uidl, mail_id, state) VALUES (?1, ?2, ?3, ?3)",
                    [account.as_str(), uidl, state],
                )
                .unwrap();
            }
            conn.execute("INSERT INTO pop3_uidls (account_id, uidl) VALUES (?1, 'u4')", [&account]).unwrap();
            seed_mail(&conn, &SeedMail { account_id: &other, folder_id: &inbox, ..Default::default() })
        };
        let kept: Vec<PathBuf> = [mail.as_str(), other_mail.as_str(), "stored", "restored"]
            .iter()
            .map(|id| file(&db, &format!("{id}.eml")))
            .collect();
        let gone = file(&db, "server_deleted.eml");
        assert_eq!(cleanup_after(&db, 8 * 86400), 1);
        assert!(kept.iter().all(|p| p.exists()));
        assert!(!gone.exists());
    }

    #[test]
    fn cleanup_deletes_nothing_when_the_query_fails() {
        let (db, ..) = seeded();
        let eml = file(&db, "stray.eml");
        let tmp = file(&db, "stray.eml.tmp");
        db.lock_db().execute_batch("DROP TABLE pop3_uidls").unwrap();
        assert_eq!(cleanup_after(&db, 8 * 86400), 0);
        assert!(eml.exists() && tmp.exists());
    }

    #[test]
    fn cleanup_keeps_sources_when_there_are_no_mails() {
        let db = temp_db();
        let eml = file(&db, "stray.eml");
        let tmp = file(&db, "stray.eml.tmp");
        assert_eq!(cleanup_after(&db, 8 * 86400), 1);
        assert!(eml.exists() && !tmp.exists());
    }
}
