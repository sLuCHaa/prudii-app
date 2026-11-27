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
                 OR EXISTS(SELECT 1 FROM pop3_uidls WHERE mail_id = ?1 AND state = 'stored')",
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
