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
    for mail_id in mail_ids {
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

/// Removes leftover files in mail_sources; the age limits protect files whose mail row is not written yet.
pub(crate) fn cleanup_stray_sources(
    conn: &rusqlite::Connection,
    data_dir: &std::path::Path,
    now: std::time::SystemTime,
) -> usize {
    const DAY: u64 = 86_400;
    let Ok(references) = source_references(conn) else {
        log::warn!("POP3: could not list referenced raw sources, nothing cleaned up");
        return 0;
    };
    // A new or reset database references nothing, which says nothing about the files.
    let has_mails = references.iter().any(|(_, is_mail)| *is_mail);
    let referenced: std::collections::HashSet<String> = references.into_iter().map(|(id, _)| id).collect();
    let Ok(entries) = std::fs::read_dir(data_dir.join("mail_sources")) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let min_age = if name.ends_with(".eml.tmp") {
            DAY
        } else {
            match name.strip_suffix(".eml") {
                Some(id) if has_mails && !referenced.contains(id) => 7 * DAY,
                _ => continue,
            }
        };
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age.as_secs() >= min_age));
        if old_enough && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("POP3: removed {} stray raw source files", removed);
    }
    removed
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
