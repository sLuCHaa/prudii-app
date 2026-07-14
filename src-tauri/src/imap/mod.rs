pub mod client;

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use base64::Engine;
use mail_parser::{MessageParser, MimeHeaders};
use tauri::Emitter;

use crate::db::Database;
use crate::models::{Folder, SyncProgress, SyncStats};

pub use client::ImapClient;
pub type ImapSession = ImapClient;

/// Owned data extracted from a single IMAP fetch
struct FetchedMail {
    uid: u32,
    raw_bytes: Vec<u8>,
    flags: Vec<String>,
    size: u32,
}

/// Connect to an IMAP server with TLS and login.
pub async fn connect(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> Result<ImapSession> {
    ImapClient::connect(host, port, email, password).await
}

/// Connect using the appropriate auth method (password or OAuth).
pub async fn connect_with_auth(
    host: &str,
    port: u16,
    email: &str,
    auth_type: &str,
    credential: &str,
) -> Result<ImapSession> {
    if auth_type == "oauth" {
        ImapClient::connect_oauth(host, port, email, credential).await
    } else {
        ImapClient::connect(host, port, email, credential).await
    }
}

/// Test IMAP connection: connect, login, list mailboxes, logout
pub async fn test_connection(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> Result<String> {
    let mut session = connect(host, port, email, password).await?;

    let mailboxes = session
        .list(Some(""), Some("*"))
        .await
        .context("Failed to list mailboxes")?;

    let count = mailboxes.len();
    let _ = session.logout().await;
    Ok(format!("Connection successful. Found {} folders.", count))
}

pub async fn test_connection_with_auth(
    host: &str,
    port: u16,
    email: &str,
    auth_type: &str,
    credential: &str,
) -> Result<String> {
    let mut session = connect_with_auth(host, port, email, auth_type, credential).await?;

    let mailboxes = session
        .list(Some(""), Some("*"))
        .await
        .context("Failed to list mailboxes")?;

    let count = mailboxes.len();
    let _ = session.logout().await;
    Ok(format!("Connection successful. Found {} folders.", count))
}

/// Sync IMAP folders to the local database
pub async fn sync_folders(
    session: &mut ImapSession,
    account_id: &str,
    db: &Database,
) -> Result<Vec<Folder>> {
    let mailbox_results = session
        .list(Some(""), Some("*"))
        .await
        .context("Failed to list mailboxes")?;

    let conn = db.lock_db();
    let mut folders = Vec::new();

    // Gmail-Erkennung: Prüfen ob [Gmail] oder [Google Mail] Namespace existiert
    let is_gmail = mailbox_results.iter().any(|m| {
        let p = m.name.to_lowercase();
        p.starts_with("[gmail]") || p.starts_with("[google mail]")
    });

    conn.execute_batch("BEGIN IMMEDIATE")?;

    let result = (|| -> Result<()> {
        for entry in &mailbox_results {
            // Skip non-selectable folders (e.g. [Gmail], [Google Mail] containers)
            let is_noselect = entry.attributes.iter().any(|attr| {
                let a = attr.to_lowercase();
                a.contains("noselect") || a.contains("nonexistent")
            });
            if is_noselect {
                continue;
            }

            let path = &entry.name;
            let path_lower = path.to_lowercase();

            // Skip Gmail namespace containers
            if path_lower == "[gmail]" || path_lower == "[google mail]" {
                continue;
            }

            // Bei Gmail: Nur echte Systemordner synchronisieren (INBOX + [Google Mail]/...)
            // Custom Labels (Top-Level-Ordner ohne Präfix) werden übersprungen.
            if is_gmail
                && path_lower != "inbox"
                && !path_lower.starts_with("[gmail]/")
                && !path_lower.starts_with("[google mail]/")
            {
                continue;
            }

            // Bei Gmail: Virtuelle Ordner überspringen — Starred und Important
            if is_gmail {
                let last_seg = path_lower.rsplit('/').next().unwrap_or(&path_lower);
                let is_virtual_by_path = matches!(
                    last_seg,
                    "starred" | "markiert" | "favoris" | "destacados" | "con estrella"
                        | "important" | "wichtig" | "importants" | "importantes"
                );

                let is_virtual_by_attr = entry.attributes.iter().any(|attr| {
                    let a = attr.to_lowercase();
                    a.contains("\\flagged") || a.contains("flagged")
                        || a.contains("\\important") || a.contains("important")
                });

                if is_virtual_by_path || is_virtual_by_attr {
                    log::debug!("Gmail: Überspringe virtuellen Ordner '{}'", path);
                    continue;
                }
            }

            let raw_name = path.rsplit('/').next().unwrap_or(path);
            let raw_name = raw_name.rsplit('.').next().unwrap_or(raw_name);
            let name = utf7_imap::decode_utf7_imap(raw_name.to_string());

            let folder_type = detect_folder_type(path, &entry.attributes);

            log::debug!(
                "Sync Ordner: path='{}', name='{}', type='{}', attrs={:?}",
                path, name, folder_type, entry.attributes
            );

            let folder_id: String = {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT id FROM folders WHERE account_id = ?1 AND path = ?2",
                        rusqlite::params![account_id, path],
                        |row| row.get(0),
                    )
                    .ok();

                if let Some(id) = existing {
                    conn.execute(
                        "UPDATE folders SET name = ?1, folder_type = ?2, path = ?3, is_local = 0 WHERE id = ?4",
                        rusqlite::params![name, folder_type, path, id],
                    )?;
                    id
                } else {
                    let id = uuid::Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO folders (id, account_id, name, folder_type, path, is_local) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                        rusqlite::params![id, account_id, name, folder_type, path],
                    )?;
                    id
                }
            };

            // Bei Gmail: Duplikat-Systemordner auflösen
            if is_gmail && folder_type != "custom" {
                let other: Option<(String, String)> = conn
                    .query_row(
                        "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = ?2 AND id != ?3",
                        rusqlite::params![account_id, folder_type, folder_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .ok();

                if let Some((other_id, other_path)) = other {
                    let (remove_id, remove_is_self) = if path.len() >= other_path.len() {
                        (other_id.clone(), false)
                    } else {
                        (folder_id.clone(), true)
                    };

                    let _ = conn.execute(
                        "DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)",
                        rusqlite::params![remove_id],
                    );
                    let _ = conn.execute(
                        "DELETE FROM folders WHERE id = ?1",
                        rusqlite::params![remove_id],
                    );

                    if remove_is_self {
                        continue;
                    } else {
                        folders.retain(|f: &Folder| f.id != other_id);
                    }
                }
            }

            folders.push(Folder {
                id: folder_id,
                account_id: account_id.to_string(),
                name: name.to_string(),
                folder_type: folder_type.to_string(),
                path: path.to_string(),
                unread_count: 0,
                total_count: 0,
                is_local: false,
                color: String::new(),
            });
        }
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    // Stale-folder cleanup: remove local non-local folders that no longer exist on server
    let server_paths: HashSet<String> = folders.iter().map(|f| f.path.clone()).collect();
    let stale_folders: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, path FROM folders WHERE account_id = ?1 AND is_local = 0"
        )?;
        let rows: Vec<(String, String)> = stmt.query_map(rusqlite::params![account_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?.filter_map(|r| r.ok()).collect();
        rows.into_iter()
            .filter(|(_, path)| !server_paths.contains(path))
            .collect()
    };

    if !stale_folders.is_empty() {
        for (stale_id, stale_path) in &stale_folders {
            let _ = conn.execute(
                "DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)",
                rusqlite::params![stale_id],
            );
            let _ = conn.execute("DELETE FROM mails WHERE folder_id = ?1", rusqlite::params![stale_id]);
            let _ = conn.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![stale_id]);
            log::info!("Removed stale folder '{}' (no longer on server)", stale_path);
        }
    }

    Ok(folders)
}

fn detect_folder_type(
    path: &str,
    attrs: &[String],
) -> &'static str {
    // Phase 1: IMAP special-use attributes (RFC 6154) — authoritative
    for attr in attrs {
        let attr_lower = attr.to_lowercase();
        if attr_lower.contains("inbox") {
            return "inbox";
        }
        if attr_lower.contains("sent") {
            return "sent";
        }
        if attr_lower.contains("drafts") || attr_lower.contains("draft") {
            return "drafts";
        }
        if attr_lower.contains("trash") || attr_lower.contains("deleted") {
            return "trash";
        }
        if attr_lower.contains("junk") || attr_lower.contains("spam") {
            return "spam";
        }
        if attr_lower.contains("archive") || attr_lower.contains("all") {
            return "archive";
        }
    }

    // Phase 2: Path-based fallback
    let lower = path.to_lowercase();
    let last_segment = lower.rsplit('/').next().unwrap_or(&lower);
    let last_segment = last_segment.rsplit('.').next().unwrap_or(last_segment);

    match last_segment {
        "inbox" => "inbox",
        "sent" | "sent mail" | "sent items" | "sent messages" | "gesendet" | "envoy\u{e9}s" | "enviados" => "sent",
        "drafts" | "draft" | "entw\u{fc}rfe" | "brouillons" | "borradores" => "drafts",
        "trash" | "deleted items" | "deleted" | "deleted messages" | "papierkorb" | "bin" | "corbeille" | "papelera" => "trash",
        "spam" | "junk" | "junk e-mail" | "junk-e-mail" | "bulk mail" => "spam",
        "archive" | "all mail" | "alle nachrichten" | "tous les messages" => "archive",
        _ => "custom",
    }
}

/// UID reconciliation + flag sync: EXAMINE the folder, UID FETCH 1:* FLAGS,
/// remove local mails whose UIDs no longer exist on the server, and update
/// flags (read/starred/replied) for existing mails that differ from the server.
async fn reconcile_and_sync_flags(
    session: &mut ImapSession,
    folder: &Folder,
    db: &Database,
) {
    // EXAMINE to get read-only access
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.examine(&folder.path),
    ).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            log::warn!("reconcile '{}': EXAMINE failed: {}", folder.name, e);
            return;
        }
        Err(_) => {
            log::warn!("reconcile '{}': EXAMINE timed out", folder.name);
            return;
        }
    }

    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.uid_fetch("1:*", "FLAGS"),
    ).await {
        Ok(Ok(fetched)) => {
            // Build server state: UID → (is_read, is_starred, is_replied)
            let mut server_flags: HashMap<u32, (bool, bool, bool)> = HashMap::new();
            for item in &fetched {
                if let Some(uid) = item.uid {
                    let is_read = item.flags.iter().any(|f| f.contains("Seen"));
                    let is_starred = item.flags.iter().any(|f| f.contains("Flagged"));
                    let is_replied = item.flags.iter().any(|f| f.contains("Answered"));
                    server_flags.insert(uid, (is_read, is_starred, is_replied));
                }
            }

            let local_mails: Vec<(String, u32, bool, bool, bool)> = {
                let conn = db.lock_db();
                let mut stmt = match conn.prepare(
                    "SELECT id, uid, is_read, is_starred, is_replied FROM mails WHERE folder_id = ?1 AND uid IS NOT NULL"
                ) {
                    Ok(s) => s,
                    Err(e) => { log::warn!("reconcile '{}': prepare failed: {}", folder.name, e); return; }
                };
                stmt.query_map(rusqlite::params![folder.id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, i32>(2)? != 0,
                        row.get::<_, i32>(3)? != 0,
                        row.get::<_, i32>(4)? != 0,
                    ))
                }).unwrap()
                .filter_map(|r| r.ok())
                .collect()
            };

            let server_uid_set: HashSet<u32> = server_flags.keys().copied().collect();
            let mut stale_ids: Vec<String> = Vec::new();
            let mut flag_updates: Vec<(String, bool, bool, bool)> = Vec::new();

            for (mail_id, uid, local_read, local_starred, local_replied) in &local_mails {
                if let Some(&(server_read, server_starred, server_replied)) = server_flags.get(uid) {
                    if *local_read != server_read || *local_starred != server_starred || *local_replied != server_replied {
                        flag_updates.push((mail_id.clone(), server_read, server_starred, server_replied));
                    }
                } else if !server_uid_set.is_empty() {
                    // UID not on server — stale mail (only if server returned UIDs)
                    stale_ids.push(mail_id.clone());
                }
            }

            if !stale_ids.is_empty() {
                let conn = db.lock_db();
                for stale_id in &stale_ids {
                    let _ = conn.execute(
                        "DELETE FROM mails_fts WHERE mail_id = ?1",
                        rusqlite::params![stale_id],
                    );
                    let _ = conn.execute(
                        "DELETE FROM mails WHERE id = ?1",
                        rusqlite::params![stale_id],
                    );
                }
                log::info!(
                    "reconcile '{}': removed {} stale mails (UIDs no longer on server)",
                    folder.name, stale_ids.len()
                );
            }

            if !flag_updates.is_empty() {
                let conn = db.lock_db();
                for (mail_id, is_read, is_starred, is_replied) in &flag_updates {
                    let _ = conn.execute(
                        "UPDATE mails SET is_read = ?1, is_starred = ?2, is_replied = ?3 WHERE id = ?4",
                        rusqlite::params![*is_read as i32, *is_starred as i32, *is_replied as i32, mail_id],
                    );
                }
                log::info!(
                    "reconcile '{}': updated flags on {} mails",
                    folder.name, flag_updates.len()
                );
            }
        }
        Ok(Err(e)) => {
            log::warn!("reconcile '{}': UID FETCH FLAGS failed: {}", folder.name, e);
        }
        Err(_) => {
            log::warn!("reconcile '{}': UID FETCH FLAGS timed out", folder.name);
        }
    }
}

/// Sync mails from a single IMAP folder — HEADERS ONLY (UID-based incremental).
pub async fn sync_mails(
    session: &mut ImapSession,
    folder: &Folder,
    account_id: &str,
    db: &Database,
    progress_ctx: Option<(&tauri::AppHandle, u32, u32, u32)>,
) -> Result<SyncStats> {
    let t0 = std::time::Instant::now();

    let (stored_uid_validity, stored_uid_next): (u32, u32) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COALESCE(uid_validity, 0), COALESCE(uid_next, 0) FROM folders WHERE id = ?1",
            rusqlite::params![folder.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, 0))
    };

    // Phase 1: lightweight STATUS to check UIDNEXT/UIDVALIDITY
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.status(&folder.path, "(UIDNEXT UIDVALIDITY MESSAGES)"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder status timed out"))?
    .context(format!("Failed to get status for folder: {}", folder.path))?;

    let server_uid_validity = status.uid_validity.unwrap_or(0);
    let server_uid_next = status.uid_next.unwrap_or(0);
    let server_exists = status.exists;

    log::debug!(
        "sync_mails '{}': STATUS took {:?} (EXISTS={}, UIDNEXT={}, UIDVALIDITY={})",
        folder.name, t0.elapsed(), server_exists, server_uid_next, server_uid_validity
    );

    // Case 0: the server folder is authoritatively empty (STATUS EXISTS=0). Any
    // server-synced local mails (uid IS NOT NULL) were deleted or moved on
    // another client — e.g. Trash emptied elsewhere. reconcile_and_sync_flags
    // can't clear these because a UID FETCH on an empty folder returns nothing
    // and its empty-set guard bails to avoid wiping on a transient error. The
    // STATUS EXISTS count is authoritative, so remove them here. Optimistic
    // local moves (uid NULL, not yet pushed to the server) are preserved.
    if server_exists == 0 {
        let removed = {
            let conn = db.lock_db();
            let n = conn.execute(
                "DELETE FROM mails WHERE folder_id = ?1 AND uid IS NOT NULL",
                rusqlite::params![folder.id],
            ).unwrap_or(0);
            if n > 0 {
                let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)", []);
            }
            n
        };
        if removed > 0 {
            log::info!(
                "sync_mails '{}': server folder empty (EXISTS=0), removed {} stale local mails",
                folder.name, removed
            );
        }
        update_folder_counts(db, folder, server_exists, server_uid_validity, server_uid_next)?;
        return Ok(SyncStats { new_mails: 0, folder_name: folder.name.clone() });
    }

    // Case 1: UIDVALIDITY changed
    if stored_uid_validity > 0 && server_uid_validity != stored_uid_validity {
        log::info!(
            "sync_mails '{}': UIDVALIDITY changed ({} → {}), clearing folder for re-sync",
            folder.name, stored_uid_validity, server_uid_validity
        );
        let conn = db.lock_db();
        let _ = conn.execute("DELETE FROM mails WHERE folder_id = ?1", rusqlite::params![folder.id]);
        let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)", []);
        drop(conn);
    }
    // Case 2: UIDNEXT unchanged — check for missing or stale local mails
    else if stored_uid_next > 0 && server_uid_next == stored_uid_next {
        let local_count: u32 = {
            let conn = db.lock_db();
            conn.query_row(
                "SELECT COUNT(*) FROM mails WHERE folder_id = ?1",
                rusqlite::params![folder.id],
                |row| row.get::<_, u32>(0),
            ).unwrap_or(0)
        };
        if server_exists > 0 && (local_count == 0 || local_count * 3 < server_exists) {
            log::info!(
                "sync_mails '{}': UIDNEXT unchanged but local mails missing (local={}, server={}), re-fetching all",
                folder.name, local_count, server_exists
            );
            // Reset stored state so we fetch from UID 1
            let conn = db.lock_db();
            let _ = conn.execute(
                "DELETE FROM mails WHERE folder_id = ?1",
                rusqlite::params![folder.id],
            );
            drop(conn);
            // Fall through to Case 3 to re-fetch
        } else if local_count > server_exists && server_exists > 0 {
            // Local has MORE mails than server — mails were moved/deleted on another client.
            // Run UID reconciliation to remove stale local mails.
            log::info!(
                "sync_mails '{}': UIDNEXT unchanged but local has more mails than server (local={}, server={}), reconciling",
                folder.name, local_count, server_exists
            );
            reconcile_and_sync_flags(session, folder, db).await;
            update_folder_counts(db, folder, server_exists, server_uid_validity, server_uid_next)?;
            return Ok(SyncStats {
                new_mails: 0,
                folder_name: folder.name.clone(),
            });
        } else {
            log::debug!(
                "sync_mails '{}': UIDNEXT unchanged ({}), syncing flags ({:?} total)",
                folder.name, server_uid_next, t0.elapsed()
            );
            reconcile_and_sync_flags(session, folder, db).await;
            update_folder_counts(db, folder, server_exists, server_uid_validity, server_uid_next)?;
            return Ok(SyncStats {
                new_mails: 0,
                folder_name: folder.name.clone(),
            });
        }
    }

    // Case 3: New mails — EXAMINE folder for UID FETCH
    let t_examine = std::time::Instant::now();
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.examine(&folder.path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder examine timed out"))?
    .context(format!("Failed to examine folder: {}", folder.path))?;
    log::debug!("sync_mails '{}': EXAMINE took {:?}", folder.name, t_examine.elapsed());

    let last_uid: u32 = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COALESCE(MAX(uid), 0) FROM mails WHERE account_id = ?1 AND folder_id = ?2",
            rusqlite::params![account_id, folder.id],
            |row| row.get::<_, u32>(0),
        )
        .unwrap_or(0)
    };

    let fetch_range = format!("{}:*", last_uid + 1);
    let fetched = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        session.uid_fetch(&fetch_range, "(UID RFC822.HEADER FLAGS RFC822.SIZE)"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("IMAP fetch timed out after 60s"))?
    .context("Failed to fetch mails")?;

    let parser = MessageParser::default();
    let mut new_count: u32 = 0;
    let mut all_new_mail_ids: Vec<String> = Vec::new();
    let batch_size = 500;
    let mut batch: Vec<FetchedMail> = Vec::with_capacity(batch_size);

    for item in &fetched {
        let uid = match item.uid {
            Some(uid) if uid > last_uid => uid,
            _ => continue,
        };

        let raw_bytes = item.data.clone().unwrap_or_default();
        let flags = item.flags.clone();
        let size = item.size.unwrap_or(0);

        batch.push(FetchedMail { uid, raw_bytes, flags, size });

        if batch.len() >= batch_size {
            let (count, ids) = process_header_batch(&batch, &parser, account_id, folder, db);
            new_count += count;
            all_new_mail_ids.extend(ids);
            batch.clear();

            if let Some((app, folder_idx, folder_count, base_new)) = progress_ctx {
                let _ = app.emit("sync-progress", &SyncProgress {
                    account_id: account_id.to_string(),
                    status: "syncing_mails".into(),
                    folder_name: Some(folder.name.clone()),
                    folder_index: folder_idx,
                    folder_count,
                    new_mails: base_new + new_count,
                    message: format!(
                        "Syncing {} ({}/{})... {} mails",
                        folder.name, folder_idx + 1, folder_count, base_new + new_count,
                    ),
                });
            }
        }
    }

    if !batch.is_empty() {
        let (count, ids) = process_header_batch(&batch, &parser, account_id, folder, db);
        new_count += count;
        all_new_mail_ids.extend(ids);
    }

    if !all_new_mail_ids.is_empty() {
        crate::rules::apply_rules_to_mails(account_id, &all_new_mail_ids, db);
    }

    let local_count_after: u32 = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COUNT(*) FROM mails WHERE folder_id = ?1",
            rusqlite::params![folder.id],
            |row| row.get::<_, u32>(0),
        ).unwrap_or(0)
    };
    if local_count_after > server_exists && server_exists > 0 {
        log::info!(
            "sync_mails '{}': local has more mails than server (local={}, server={}), reconciling UIDs",
            folder.name, local_count_after, server_exists
        );
        reconcile_and_sync_flags(session, folder, db).await;
    }

    log::info!(
        "sync_mails '{}': {} new mails, total {:?}",
        folder.name, new_count, t0.elapsed()
    );

    update_folder_counts(db, folder, server_exists, server_uid_validity, server_uid_next)?;

    Ok(SyncStats {
        new_mails: new_count,
        folder_name: folder.name.clone(),
    })
}

/// Update folder counts and store UIDVALIDITY/UIDNEXT after sync.
fn update_folder_counts(
    db: &Database,
    folder: &Folder,
    server_exists: u32,
    uid_validity: u32,
    uid_next: u32,
) -> Result<()> {
    let conn = db.lock_db();
    let unread: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM mails WHERE folder_id = ?1 AND is_read = 0",
            rusqlite::params![folder.id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let db_total: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM mails WHERE folder_id = ?1",
            rusqlite::params![folder.id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let total = db_total.max(server_exists as i32);

    conn.execute(
        "UPDATE folders SET unread_count = ?1, total_count = ?2, uid_validity = ?3, uid_next = ?4, last_sync = datetime('now') WHERE id = ?5",
        rusqlite::params![unread, total, uid_validity, uid_next, folder.id],
    )?;

    Ok(())
}

/// Process a batch of header-only fetches: parse headers, insert into DB.
/// Returns (new_count, new_mail_ids) for rule engine integration.
fn process_header_batch(
    batch: &[FetchedMail],
    parser: &MessageParser,
    account_id: &str,
    folder: &Folder,
    db: &Database,
) -> (u32, Vec<String>) {
    let mut guard = db.lock_db();
    let conn = &mut *guard;
    let mut new_count: u32 = 0;
    let mut new_mail_ids: Vec<String> = Vec::new();

    // Use Transaction so that any panic mid-loop auto-rolls-back on drop
    // instead of leaving a dangling BEGIN that blocks the next writer with SQLITE_BUSY.
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(e) => {
            log::error!("Failed to begin batch insert transaction: {}", e);
            return (0, Vec::new());
        }
    };

    for fetched in batch {
        let parsed = parser.parse(&fetched.raw_bytes);

        let (
            subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
            date, message_id, in_reply_to, thread_id, has_attachments, list_unsubscribe,
            references_str,
        ) = if let Some(msg) = &parsed {
            let subject = msg.subject().unwrap_or_default().to_string();
            let (from_name, from_email) = extract_first_address(msg.from());
            let to_json = addresses_to_json(msg.to());
            let cc_json = addresses_to_json(msg.cc());
            let bcc_json = addresses_to_json(msg.bcc());
            let reply_to_json = addresses_to_json(msg.reply_to());

            let date = msg
                .date()
                .map(|d| {
                    chrono::DateTime::from_timestamp(d.to_timestamp(), 0)
                        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string())
                })
                .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

            let message_id = msg.message_id().unwrap_or_default().to_string();
            // Try as_text_list first, fall back to as_text for In-Reply-To
            // (some headers may not be parsed as a list by mail_parser)
            let in_reply_to = msg
                .in_reply_to()
                .as_text_list()
                .and_then(|list| list.first().map(|s| s.to_string()))
                .or_else(|| msg.in_reply_to().as_text().map(|s| s.to_string()))
                .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string())
                .filter(|s| !s.is_empty());

            // Extract References header for proper thread detection
            let references = msg.header("References")
                .and_then(|v| v.as_text())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());

            let thread_id = references.clone()
                .or_else(|| in_reply_to.clone())
                .or_else(|| Some(message_id.clone()));

            let references_str = references.unwrap_or_default();

            let has_attachments = msg
                .content_type()
                .map(|ct| {
                    let ctype = ct.ctype();
                    let sub = ct.subtype().unwrap_or("");
                    // multipart/mixed is standard, but related (inline images), signed,
                    // and encrypted can also contain file attachments
                    ctype == "multipart" && (sub == "mixed" || sub == "related" || sub == "signed")
                })
                .unwrap_or(false);

            let list_unsubscribe = msg.header("List-Unsubscribe")
                .and_then(|v| v.as_text())
                .unwrap_or_default().to_string();

            (
                subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
                date, message_id, in_reply_to, thread_id, has_attachments, list_unsubscribe,
                references_str,
            )
        } else {
            (
                String::new(), String::new(), String::new(),
                "[]".to_string(), "[]".to_string(), "[]".to_string(), "[]".to_string(),
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                String::new(), None, None, false, String::new(),
                String::new(),
            )
        };

        let is_read = fetched.flags.iter().any(|f| f.contains("Seen"));
        let is_starred = fetched.flags.iter().any(|f| f.contains("Flagged"));
        let is_replied = fetched.flags.iter().any(|f| f.contains("Answered"));

        let mail_id = uuid::Uuid::new_v4().to_string();

        // If a locally-moved mail exists with uid=NULL and matching message_id,
        // claim it by updating the UID instead of inserting a duplicate.
        if !message_id.is_empty() {
            let claimed = tx.execute(
                "UPDATE mails SET uid = ?1 WHERE account_id = ?2 AND folder_id = ?3 AND message_id = ?4 AND uid IS NULL",
                rusqlite::params![fetched.uid, account_id, folder.id, message_id],
            ).unwrap_or(0);
            if claimed > 0 {
                continue;
            }
        }

        let insert_result = tx.execute(
            "INSERT OR IGNORE INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, list_unsubscribe, reply_to_json, \"references\") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, '', '', '', ?13, ?14, 0, ?15, 0, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            rusqlite::params![
                mail_id, account_id, folder.id, message_id, fetched.uid,
                subject, from_name, from_email, to_json, cc_json, bcc_json, date,
                is_read as i32, is_starred as i32, is_replied as i32,
                has_attachments as i32, thread_id, in_reply_to, fetched.size as i64,
                list_unsubscribe, reply_to_json, references_str,
            ],
        );

        if let Ok(rows) = insert_result {
            if rows > 0 {
                if let Err(e) = tx.execute(
                    "INSERT INTO mails_fts (mail_id, subject, from_email, from_name, body_text) VALUES (?1, ?2, ?3, ?4, '')",
                    rusqlite::params![mail_id, subject, from_email, from_name],
                ) {
                    log::error!("FTS insert failed for mail {}: {}", mail_id, e);
                }
                new_mail_ids.push(mail_id.clone());
                new_count += 1;
            }
        }
    }

    if let Err(e) = tx.commit() {
        log::error!("Failed to commit batch insert transaction: {}", e);
        return (0, Vec::new());
    }
    (new_count, new_mail_ids)
}

/// Insert a just-sent mail into the local DB immediately after a successful IMAP
/// APPEND to the Sent folder, so it shows up without waiting for the next server
/// sync to re-fetch it. Relying on that round-trip was unreliable (e.g. GMX's
/// STATUS UIDNEXT can lag, causing the "UIDNEXT unchanged" fast-path in
/// `sync_mails` to skip fetching new mail), which made sent mail go missing.
///
/// The row is stored with `uid = NULL` and the full body (so it is viewable
/// offline and opening it does not require an IMAP fetch by a UID it doesn't have
/// yet). When a later sync fetches the same message from the server, the
/// claim-by-Message-ID step in `process_header_batch` updates this row's UID in
/// place instead of inserting a duplicate.
pub fn insert_local_sent_mail(
    db: &Database,
    account_id: &str,
    folder_id: &str,
    raw_bytes: &[u8],
) -> Result<String> {
    let parser = MessageParser::default();
    let msg = parser
        .parse(raw_bytes)
        .ok_or_else(|| anyhow::anyhow!("Failed to parse sent message for local insert"))?;

    let subject = msg.subject().unwrap_or_default().to_string();
    let (from_name, from_email) = extract_first_address(msg.from());
    let to_json = addresses_to_json(msg.to());
    let cc_json = addresses_to_json(msg.cc());
    let bcc_json = addresses_to_json(msg.bcc());
    let reply_to_json = addresses_to_json(msg.reply_to());

    let date = msg
        .date()
        .and_then(|d| chrono::DateTime::from_timestamp(d.to_timestamp(), 0))
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

    let message_id = msg.message_id().unwrap_or_default().to_string();

    let in_reply_to = msg
        .in_reply_to()
        .as_text_list()
        .and_then(|list| list.first().map(|s| s.to_string()))
        .or_else(|| msg.in_reply_to().as_text().map(|s| s.to_string()))
        .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string())
        .filter(|s| !s.is_empty());

    let references_raw = msg
        .header("References")
        .and_then(|v| v.as_text())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let references_str = references_raw.clone().unwrap_or_default();

    let thread_id = references_raw
        .or_else(|| in_reply_to.clone())
        .or_else(|| Some(message_id.clone()));

    let has_attachments = msg
        .content_type()
        .map(|ct| {
            let ctype = ct.ctype();
            let sub = ct.subtype().unwrap_or("");
            ctype == "multipart" && (sub == "mixed" || sub == "related" || sub == "signed")
        })
        .unwrap_or(false);

    let list_unsubscribe = msg
        .header("List-Unsubscribe")
        .and_then(|v| v.as_text())
        .unwrap_or_default()
        .to_string();

    let body_text = msg.body_text(0).unwrap_or_default().to_string();
    let body_html = msg.body_html(0).unwrap_or_default().to_string();
    let snippet: String = {
        let basis = if body_text.is_empty() {
            // Fall back to a minimal tag-stripped HTML preview when there is no plain part.
            let mut out = String::with_capacity(body_html.len());
            let mut in_tag = false;
            for c in body_html.chars() {
                match c {
                    '<' => in_tag = true,
                    '>' => in_tag = false,
                    _ if !in_tag => out.push(c),
                    _ => {}
                }
            }
            out
        } else {
            body_text.clone()
        };
        basis.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()
    };

    let mail_id = uuid::Uuid::new_v4().to_string();
    let size = raw_bytes.len() as i64;

    let conn = db.lock_db();
    // uid = NULL (claimed by the next sync via Message-ID); is_read = 1 because we
    // authored it. is_starred/is_flagged/is_replied/is_forwarded default to 0.
    conn.execute(
        "INSERT OR IGNORE INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, list_unsubscribe, reply_to_json, \"references\") VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, 0, 0, 0, 0, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
        rusqlite::params![
            mail_id, account_id, folder_id, message_id,
            subject, from_name, from_email, to_json, cc_json, bcc_json, date,
            snippet, body_text, body_html,
            has_attachments as i32, thread_id, in_reply_to, size,
            list_unsubscribe, reply_to_json, references_str,
        ],
    )
    .context("Failed to insert local sent mail")?;

    let _ = conn.execute(
        "INSERT INTO mails_fts (mail_id, subject, from_email, from_name, body_text) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![mail_id, subject, from_email, from_name, body_text],
    );

    Ok(mail_id)
}

/// Fetch the full body of a single mail from IMAP and update the DB.
pub async fn fetch_mail_body(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    mail_id: &str,
    message_id: Option<&str>,
    db: &Database,
    skip_examine: bool,
) -> Result<()> {
    let t0 = std::time::Instant::now();

    if skip_examine {
        log::debug!("  imap::fetch_mail_body SKIPPING EXAMINE '{}' (session already in folder)", folder_path);
    } else {
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            session.examine(folder_path),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Folder examine timed out"))?
        .context("Failed to examine folder")?;

        log::debug!("  imap::fetch_mail_body EXAMINE '{}' took {:?}", folder_path, t0.elapsed());
    }

    // Phase 1: UID Fetch body
    let body_bytes: Option<Vec<u8>> = {
        let t_fetch = std::time::Instant::now();
        let fetch_range = format!("{}", uid);
        let items = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            session.uid_fetch(&fetch_range, "(UID BODY.PEEK[])"),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Body fetch timed out after 120s"))?
        .context("Failed to fetch mail body")?;

        let result = items
            .into_iter()
            .find(|f| f.uid == Some(uid) || f.uid.is_none())
            .and_then(|f| f.data);

        log::debug!("  imap::fetch_mail_body UID FETCH took {:?}, got {} bytes",
            t_fetch.elapsed(), result.as_ref().map(|b| b.len()).unwrap_or(0));
        result
    };

    // Phase 2: Fallback — SEARCH by Message-ID
    let body_bytes = match body_bytes {
        Some(b) if !b.is_empty() => b,
        Some(_) => anyhow::bail!("Server returned empty body for UID {} in {}", uid, folder_path),
        None => {
            if let Some(mid) = message_id.filter(|s| !s.is_empty()) {
                log::info!("UID {} not found in {}, searching by Message-ID", uid, folder_path);
                let safe_mid = mid.replace('\\', "\\\\").replace('"', "\\\"");
                let search_query = format!("HEADER Message-ID \"{}\"", safe_mid);
                let search_result = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    session.uid_search(&search_query),
                )
                .await
                .map_err(|_| anyhow::anyhow!("SEARCH timed out"))?
                .context("SEARCH by Message-ID failed")?;

                let new_uid = search_result.into_iter().next();
                if let Some(new_uid) = new_uid {
                    log::info!("Found UID {} via Message-ID in {}", new_uid, folder_path);
                    {
                        let conn = db.lock_db();
                        let _ = conn.execute(
                            "UPDATE mails SET uid = ?1 WHERE id = ?2",
                            rusqlite::params![new_uid, mail_id],
                        );
                    }
                    let fetch_range = format!("{}", new_uid);
                    let items = tokio::time::timeout(
                        std::time::Duration::from_secs(120),
                        session.uid_fetch(&fetch_range, "(UID BODY.PEEK[])"),
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("Body fetch timed out"))?
                    .context("Failed to fetch mail body with resolved UID")?;

                    items
                        .into_iter()
                        .find(|f| f.uid == Some(new_uid) || f.uid.is_none())
                        .and_then(|f| f.data)
                        .filter(|b| !b.is_empty())
                        .ok_or_else(|| anyhow::anyhow!(
                            "Body fetch failed for resolved UID {} in {}", new_uid, folder_path
                        ))?
                } else {
                    anyhow::bail!(
                        "Mail nicht gefunden in {} (UID {} veraltet, Message-ID Suche ohne Ergebnis)",
                        folder_path, uid
                    );
                }
            } else {
                anyhow::bail!("UID {} nicht gefunden in {}", uid, folder_path);
            }
        }
    };

    // Phase 3: Parse body and write to DB
    store_body_and_attachments(db, mail_id, &body_bytes)
        .await
        .with_context(|| format!("Body konnte nicht verarbeitet werden für Mail {} in {}", mail_id, folder_path))
}

/// Parse a raw RFC822 message and persist its body, inline images and attachments.
/// Attachment files are written to `{data_dir}/attachments/{mail_id}`.
///
/// Shared by the IMAP body fetch and by the local mirror of a mail we wrote ourselves
/// (a sent copy or a saved draft). The mirror already holds the raw bytes, so it can
/// store the attachments immediately instead of waiting for the server to hand them
/// back on the next sync — without this, a freshly saved draft reopens with its
/// attachments missing.
pub async fn store_body_and_attachments(db: &Database, mail_id: &str, body_bytes: &[u8]) -> Result<()> {
    let parser = MessageParser::default();
    if let Some(msg) = parser.parse(body_bytes) {
        let body_text = msg.body_text(0).unwrap_or_default().to_string();
        let mut body_html = msg.body_html(0).unwrap_or_default().to_string();
        let snippet = {
            let s = if body_text.len() > 200 {
                let mut end = 200;
                while end > 0 && !body_text.is_char_boundary(end) { end -= 1; }
                &body_text[..end]
            } else {
                &body_text
            };
            s.replace('\n', " ").replace('\r', "")
        };
        let has_attachments = msg.attachment_count() > 0;

        let attach_dir = db.data_dir.join("attachments").join(mail_id);
        let _ = tokio::fs::create_dir_all(&attach_dir).await;

        let mut processed_filenames = std::collections::HashSet::new();

        for part in msg.attachments() {
            let raw_filename = part.attachment_name().unwrap_or("unnamed").to_string();
            let filename = if processed_filenames.contains(&raw_filename) {
                let stem = raw_filename.rfind('.').map(|i| &raw_filename[..i]).unwrap_or(&raw_filename);
                let ext = raw_filename.rfind('.').map(|i| &raw_filename[i..]).unwrap_or("");
                let mut counter = 2;
                loop {
                    let candidate = format!("{}_{}{}", stem, counter, ext);
                    if !processed_filenames.contains(&candidate) { break candidate; }
                    counter += 1;
                }
            } else {
                raw_filename.clone()
            };
            processed_filenames.insert(filename.clone());

            let safe_name = sanitize_filename(&filename);
            let mime_type = part.content_type().map(|ct: &mail_parser::ContentType| {
                let sub = ct.subtype().unwrap_or("octet-stream");
                format!("{}/{}", ct.ctype(), sub)
            });
            let raw_cid = part.content_id().map(|s| s.to_string());
            let content_id = raw_cid.map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string());
            // Determine inline status — only images embedded in HTML are truly inline.
            // Many clients (Outlook, Gmail) set Content-Disposition: inline for regular
            // file attachments like PDFs, so we can't trust the header alone.
            let is_image = mime_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false);
            let has_real_filename = part.attachment_name().is_some() && raw_filename != "unnamed";
            let disposition_inline = part.content_disposition()
                .map(|cd| cd.ctype() == "inline")
                .unwrap_or(false);
            let is_inline = if disposition_inline && is_image && content_id.is_some() {
                true // image with CID referenced in HTML — genuinely inline
            } else if !disposition_inline && content_id.is_some() && !has_real_filename && is_image {
                true // no disposition header, unnamed image with CID — embedded image
            } else {
                false // everything else is a regular attachment
            };
            let data = part.contents();
            let size = data.len() as i64;

            if data.len() > 50 * 1024 * 1024 {
                log::warn!("Skipping oversized attachment '{}' ({} bytes)", filename, data.len());
                continue;
            }

            // Always replace CID references in HTML regardless of is_inline flag.
            // Many clients (e.g. Outlook) mark inline images as Content-Disposition: attachment
            // while still referencing them via cid: in the HTML body.
            if let Some(ref cid) = content_id {
                let mime = mime_type.as_deref().unwrap_or("application/octet-stream");
                let b64 = base64::engine::general_purpose::STANDARD.encode(data);
                let data_uri = format!("data:{};base64,{}", mime, b64);
                body_html = body_html.replace(&format!("cid:{}", cid), &data_uri);
            }

            let file_path = attach_dir.join(&safe_name);
            match tokio::fs::write(&file_path, data).await {
                Ok(_) => {
                    let path_str = file_path.to_string_lossy().to_string();
                    let conn = db.lock_db();
                    // Check if attachment already exists for this mail+filename to preserve its ID
                    let existing: Option<String> = conn.query_row(
                        "SELECT id FROM attachments WHERE mail_id = ?1 AND filename = ?2",
                        rusqlite::params![mail_id, filename],
                        |row| row.get(0),
                    ).ok();
                    let att_id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    if let Err(e) = conn.execute(
                        "INSERT OR REPLACE INTO attachments (id, mail_id, filename, mime_type, size_bytes, content_id, is_inline, local_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        rusqlite::params![att_id, mail_id, filename, mime_type, size, content_id, is_inline as i32, path_str],
                    ) {
                        log::error!("Failed to insert attachment '{}' for mail {}: {}", filename, mail_id, e);
                    }
                }
                Err(e) => {
                    log::error!("Failed to write attachment '{}' for mail {}: {}", filename, mail_id, e);
                }
            }
        }

        let conn = db.lock_db();
        conn.execute(
            "UPDATE mails SET body_text = ?1, body_html = ?2, snippet = ?3, has_attachments = ?4 WHERE id = ?5",
            rusqlite::params![body_text, body_html, snippet, has_attachments as i32, mail_id],
        )?;

        let _ = conn.execute(
            "UPDATE mails_fts SET body_text = ?1 WHERE mail_id = ?2",
            rusqlite::params![body_text, mail_id],
        );
    } else {
        anyhow::bail!("Body konnte nicht geparst werden für Mail {}", mail_id);
    }

    Ok(())
}

fn extract_first_address(addr: Option<&mail_parser::Address<'_>>) -> (String, String) {
    match addr {
        Some(addr) => match addr.first() {
            Some(a) => (
                a.name().unwrap_or_default().to_string(),
                a.address().unwrap_or_default().to_string(),
            ),
            None => (String::new(), String::new()),
        },
        None => (String::new(), String::new()),
    }
}

fn sanitize_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => c,
        })
        .collect();
    if sanitized.is_empty() {
        return "unnamed".to_string();
    }
    let stem = sanitized.split('.').next().unwrap_or("").to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if reserved.contains(&stem.as_str()) {
        format!("_{}", sanitized)
    } else {
        sanitized
    }
}

fn addresses_to_json(addr: Option<&mail_parser::Address<'_>>) -> String {
    let mut result = Vec::new();
    if let Some(addr) = addr {
        for a in addr.iter() {
            let name = a.name().unwrap_or_default().to_string();
            let email = a.address().unwrap_or_default().to_string();
            result.push(serde_json::json!({"name": name, "email": email}));
        }
    }
    serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
}

/// Backfill full bodies for a batch of mails in a single IMAP folder.
/// `cumulative` is an optional (account_id, offset, total) tuple for account-level progress tracking.
/// When provided, per-chunk `backfill-progress` events include cumulative counts.
pub async fn backfill_folder_bodies(
    session: &mut ImapSession,
    folder_path: &str,
    mails: &[(String, u32)],
    db: &Database,
    app: &tauri::AppHandle,
    cumulative: Option<(&str, u32, usize)>,
) -> Result<u32> {
    let t_examine = std::time::Instant::now();
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.examine(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder examine timed out"))?
    .context(format!("Failed to examine folder: {}", folder_path))?;
    log::debug!("backfill_folder_bodies EXAMINE '{}' took {:?}", folder_path, t_examine.elapsed());

    let parser = MessageParser::default();
    let mut processed: u32 = 0;

    for chunk in mails.chunks(200) {
        let uid_list: String = chunk
            .iter()
            .map(|(_, uid)| uid.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let fetched_items = match tokio::time::timeout(
            std::time::Duration::from_secs(120),
            session.uid_fetch(&uid_list, "(UID BODY.PEEK[])"),
        )
        .await
        {
            Ok(Ok(items)) => items,
            Ok(Err(e)) => {
                log::error!("Backfill fetch error in {}: {}", folder_path, e);
                continue;
            }
            Err(_) => {
                log::error!("Backfill fetch timed out in {}", folder_path);
                continue;
            }
        };

        for item in &fetched_items {
            let uid = match item.uid {
                Some(u) => u,
                None => continue,
            };
            let body_bytes = match &item.data {
                Some(d) if !d.is_empty() => d,
                _ => continue,
            };

            let mail_id = match chunk.iter().find(|(_, u)| *u == uid) {
                Some((id, _)) => id,
                None => continue,
            };

            if let Some(msg) = parser.parse(body_bytes) {
                let body_text = msg.body_text(0).unwrap_or_default().to_string();
                let mut body_html = msg.body_html(0).unwrap_or_default().to_string();
                let snippet = {
                    let s = if body_text.len() > 200 {
                        let mut end = 200;
                        while end > 0 && !body_text.is_char_boundary(end) { end -= 1; }
                        &body_text[..end]
                    } else {
                        &body_text
                    };
                    s.replace('\n', " ").replace('\r', "")
                };
                let has_attachments = msg.attachment_count() > 0;

                let attach_dir = db.data_dir.join("attachments").join(mail_id);
                let _ = tokio::fs::create_dir_all(&attach_dir).await;

                let mut processed_filenames = std::collections::HashSet::new();

                for part in msg.attachments() {
                    let original_name = part.attachment_name().unwrap_or("unnamed").to_string();
                    let filename = if processed_filenames.contains(&original_name) {
                        let mut counter = 2;
                        let mut unique_name = original_name.clone();
                        while processed_filenames.contains(&unique_name) {
                            let dot_pos = original_name.rfind('.');
                            unique_name = if let Some(pos) = dot_pos {
                                format!("{}_{}{}", &original_name[..pos], counter, &original_name[pos..])
                            } else {
                                format!("{}_{}", original_name, counter)
                            };
                            counter += 1;
                        }
                        unique_name
                    } else {
                        original_name
                    };
                    processed_filenames.insert(filename.clone());

                    let safe_name = sanitize_filename(&filename);
                    let mime_type = part.content_type().map(|ct: &mail_parser::ContentType| {
                        let sub = ct.subtype().unwrap_or("octet-stream");
                        format!("{}/{}", ct.ctype(), sub)
                    });
                    let raw_cid = part.content_id().map(|s| s.to_string());
                    let content_id = raw_cid.map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string());
                    let is_image = mime_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false);
                    let has_real_filename = part.attachment_name().is_some_and(|n| n != "unnamed");
                    let disposition_inline = part.content_disposition()
                        .map(|cd| cd.ctype() == "inline")
                        .unwrap_or(false);
                    let is_inline = if disposition_inline && is_image && content_id.is_some() {
                        true
                    } else if !disposition_inline && content_id.is_some() && !has_real_filename && is_image {
                        true
                    } else {
                        false
                    };
                    let data = part.contents();
                    let size = data.len() as i64;

                    if data.len() > 50 * 1024 * 1024 {
                        log::warn!("Skipping oversized attachment '{}' ({} bytes) in backfill", filename, data.len());
                        continue;
                    }

                    // Always replace CID references in HTML regardless of is_inline flag.
                    // Many clients (e.g. Outlook) mark inline images as Content-Disposition: attachment
                    // while still referencing them via cid: in the HTML body.
                    if let Some(ref cid) = content_id {
                        let mime = mime_type.as_deref().unwrap_or("application/octet-stream");
                        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
                        let data_uri = format!("data:{};base64,{}", mime, b64);
                        body_html = body_html.replace(&format!("cid:{}", cid), &data_uri);
                    }

                    let file_path = attach_dir.join(&safe_name);
                    if tokio::fs::write(&file_path, data).await.is_ok() {
                        let path_str = file_path.to_string_lossy().to_string();
                        let conn = db.lock_db();
                        let existing: Option<String> = conn.query_row(
                            "SELECT id FROM attachments WHERE mail_id = ?1 AND filename = ?2",
                            rusqlite::params![mail_id, filename],
                            |row| row.get(0),
                        ).ok();
                        let att_id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        if let Err(e) = conn.execute(
                            "INSERT OR REPLACE INTO attachments (id, mail_id, filename, mime_type, size_bytes, content_id, is_inline, local_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            rusqlite::params![att_id, mail_id, filename, mime_type, size, content_id, is_inline as i32, path_str],
                        ) {
                            log::error!("Failed to insert attachment '{}' for mail {}: {}", filename, mail_id, e);
                        }
                    }
                }

                let conn = db.lock_db();
                let _ = conn.execute(
                    "UPDATE mails SET body_text = ?1, body_html = ?2, snippet = ?3, has_attachments = ?4 WHERE id = ?5",
                    rusqlite::params![body_text, body_html, snippet, has_attachments as i32, mail_id],
                );
                let _ = conn.execute(
                    "UPDATE mails_fts SET body_text = ?1 WHERE mail_id = ?2",
                    rusqlite::params![body_text, mail_id],
                );

                processed += 1;
            }
        }

        if let Some((account_id, offset, total)) = cumulative {
            let _ = app.emit("backfill-progress", serde_json::json!({
                "account_id": account_id,
                "processed": offset + processed,
                "total": total,
            }));
        }
    }

    Ok(processed)
}

pub async fn search_uid_by_message_id(
    session: &mut ImapSession,
    folder_path: &str,
    message_id: &str,
) -> Result<Option<u32>> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    let safe_id = message_id.replace('\\', "\\\\").replace('"', "\\\"");
    let query = format!("HEADER Message-ID \"{}\"", safe_id);
    let uids = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_search(&query),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Search timed out"))?
    .context("IMAP SEARCH failed")?;

    Ok(uids.into_iter().next())
}

/// Find Gmail's "All Mail" folder path.
pub async fn find_all_mail_folder(session: &mut ImapSession) -> Result<Option<String>> {
    let entries = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.list(Some(""), Some("*")),
    )
    .await
    .map_err(|_| anyhow::anyhow!("LIST timed out"))?
    .context("Failed to list folders")?;

    for entry in &entries {
        let has_all_attr = entry.attributes.iter().any(|a| {
            let lower = a.to_lowercase();
            lower.contains("all")
        });
        if has_all_attr {
            return Ok(Some(entry.name.clone()));
        }
    }
    Ok(None)
}

/// Gmail-specific: Move a mail to Trash via X-GM-LABELS.
pub async fn gmail_trash_mail(
    session: &mut ImapSession,
    folder_path: &str,
    trash_folder_path: &str,
    uid: u32,
    message_id: &str,
) -> Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    let uid_str = format!("{}", uid);

    // Approach 1: Try Gmail's X-GM-LABELS extension
    let gm_result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_store(&uid_str, "+X-GM-LABELS (\\Trash)"),
    )
    .await;

    match gm_result {
        Ok(Ok(())) => {
            log::debug!("Gmail: added \\Trash label via X-GM-LABELS for uid={}", uid);
            // Remove \Inbox label so the mail disappears from Inbox
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                session.uid_store(&uid_str, "-X-GM-LABELS (\\Inbox)"),
            )
            .await;
            return Ok(());
        }
        Ok(Err(e)) => {
            log::warn!("Gmail X-GM-LABELS failed: {}, trying COPY via INBOX", e);
        }
        Err(_) => {
            log::warn!("Gmail X-GM-LABELS timed out, trying COPY via INBOX");
        }
    }

    // Approach 2: Fallback — COPY to INBOX, then from INBOX to Trash
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_copy(&uid_str, "INBOX"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("COPY to INBOX timed out"))?
    .context("Failed to COPY from archive to INBOX")?;

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select("INBOX"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("INBOX select timed out"))?
    .context("Failed to select INBOX")?;

    let safe_id = message_id.replace('\\', "\\\\").replace('"', "\\\"");
    let query = format!("HEADER Message-ID \"{}\"", safe_id);
    let uids = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_search(&query),
    )
    .await
    .map_err(|_| anyhow::anyhow!("INBOX search timed out"))?
    .context("INBOX search failed")?;

    let inbox_uid = uids
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("Mail not found in INBOX after COPY"))?;
    let inbox_uid_str = format!("{}", inbox_uid);

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_copy(&inbox_uid_str, trash_folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("COPY to Trash timed out"))?
    .context("Failed to COPY from INBOX to Trash")?;

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_store(&inbox_uid_str, "+FLAGS (\\Deleted)"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("INBOX cleanup timed out"))?
    .context("Failed to clean up INBOX copy")?;

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.close(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("INBOX close timed out"))?
    .context("Failed to close INBOX")?;

    log::debug!("Gmail: trashed via INBOX intermediary for uid={}", uid);
    Ok(())
}

/// Delete a mail from the IMAP server permanently.
pub async fn delete_mail_from_server(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
) -> Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    let uid_str = format!("{}", uid);
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_store(&uid_str, "+FLAGS (\\Deleted)"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Store flag timed out"))?
    .context("Failed to set Deleted flag")?;

    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.close(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Close/expunge timed out"))?
    .context("Failed to close/expunge folder")?;

    Ok(())
}

/// Permanently delete a message from the IMAP server, resolving its UID first.
///
/// The UID is taken from `uid` if present, otherwise searched by Message-ID in
/// `folder_path` (and, for Gmail, in the All Mail folder). For Gmail the Trash
/// label is applied first so the message actually disappears, then it is
/// expunged from Trash; other servers are expunged in place.
///
/// If the message cannot be found on the server it is treated as already gone
/// and `Ok(())` is returned, so a retrying caller does not loop forever.
pub async fn permanent_delete_on_server(
    session: &mut ImapSession,
    folder_path: &str,
    uid: Option<u32>,
    message_id: &str,
    trash_folder_path: Option<&str>,
    is_gmail: bool,
) -> Result<()> {
    // Resolve the correct UID: stored value, or search by Message-ID.
    let resolved = if let Some(u) = uid {
        Some((folder_path.to_string(), u))
    } else if !message_id.is_empty() {
        let found = search_uid_by_message_id(session, folder_path, message_id).await.unwrap_or(None);
        if let Some(u) = found {
            Some((folder_path.to_string(), u))
        } else if is_gmail {
            if let Ok(Some(all_mail_path)) = find_all_mail_folder(session).await {
                search_uid_by_message_id(session, &all_mail_path, message_id)
                    .await
                    .unwrap_or(None)
                    .map(|u| (all_mail_path, u))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let (actual_folder, real_uid) = match resolved {
        Some(x) => x,
        None => {
            log::info!("permanent_delete_on_server: message not found on server (already gone?), nothing to do");
            return Ok(());
        }
    };

    if is_gmail {
        let trash_path = trash_folder_path.unwrap_or("[Google Mail]/Papierkorb");
        if actual_folder != trash_path {
            // Add the Trash label first, then expunge from Trash.
            gmail_trash_mail(session, &actual_folder, trash_path, real_uid, message_id).await?;
            if let Ok(Some(trash_uid)) = search_uid_by_message_id(session, trash_path, message_id).await {
                delete_mail_from_server(session, trash_path, trash_uid).await?;
            }
            Ok(())
        } else {
            delete_mail_from_server(session, &actual_folder, real_uid).await
        }
    } else {
        delete_mail_from_server(session, &actual_folder, real_uid).await
    }
}

pub async fn mark_as_read_on_server(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
) -> Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    let uid_str = format!("{}", uid);
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_store(&uid_str, "+FLAGS (\\Seen)"),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Store flag timed out"))?
    .context("Failed to set Seen flag")?;

    Ok(())
}

pub async fn set_seen_flag_on_server(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    seen: bool,
) -> Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    let uid_str = format!("{}", uid);
    let action = if seen { "+FLAGS (\\Seen)" } else { "-FLAGS (\\Seen)" };
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_store(&uid_str, action),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Store flag timed out"))?
    .context("Failed to update Seen flag")?;

    Ok(())
}

/// Set or remove the \Flagged (starred) flag on the IMAP server.
pub async fn set_flagged_on_server(
    session: &mut ImapSession,
    folder_path: &str,
    uid: u32,
    flagged: bool,
) -> Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(folder_path),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select folder")?;

    let uid_str = format!("{}", uid);
    let action = if flagged { "+FLAGS (\\Flagged)" } else { "-FLAGS (\\Flagged)" };
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.uid_store(&uid_str, action),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Store flag timed out"))?
    .context("Failed to update Flagged flag")?;

    Ok(())
}

pub async fn move_mail_on_server(
    session: &mut ImapSession,
    source_folder: &str,
    dest_folder: &str,
    uid: u32,
    skip_copy: bool,
    skip_delete: bool,
) -> Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        session.select(source_folder),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Folder select timed out"))?
    .context("Failed to select source folder")?;

    let uid_str = format!("{}", uid);

    if !skip_copy {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            session.uid_copy(&uid_str, dest_folder),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Copy timed out"))?
        .context(format!("Failed to copy mail to {}", dest_folder))?;
    }

    if !skip_delete {
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            session.uid_store(&uid_str, "+FLAGS (\\Deleted)"),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Store flag timed out"))?
        .context("Failed to mark original as deleted")?;

        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            session.close(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Close/expunge timed out"))?
        .context("Failed to close/expunge source folder")?;
    }

    Ok(())
}

pub async fn create_folder(
    session: &mut ImapSession,
    folder_name: &str,
) -> Result<String> {
    session.create(folder_name).await
        .context(format!("Failed to create folder: {}", folder_name))?;

    let _ = session.subscribe(folder_name).await;

    let entries = session.list(Some(""), Some(folder_name)).await
        .context("Failed to list created folder")?;

    for entry in &entries {
        return Ok(entry.name.clone());
    }

    Ok(folder_name.to_string())
}

pub async fn delete_folder(
    session: &mut ImapSession,
    folder_path: &str,
) -> Result<()> {
    let _ = session.unsubscribe(folder_path).await;
    session.delete(folder_path).await
        .context(format!("Failed to delete folder: {}", folder_path))?;
    Ok(())
}

pub async fn rename_folder(
    session: &mut ImapSession,
    old_path: &str,
    new_path: &str,
) -> Result<()> {
    session.rename(old_path, new_path).await
        .context(format!("Failed to rename folder from {} to {}", old_path, new_path))?;
    Ok(())
}

pub async fn empty_folder_on_server(
    session: &mut ImapSession,
    folder_path: &str,
) -> Result<()> {
    let mailbox = session.select(folder_path).await
        .context("Failed to select folder")?;

    if mailbox.exists == 0 {
        return Ok(());
    }

    session.store("1:*", "+FLAGS (\\Deleted)").await
        .context("Failed to mark messages as deleted")?;

    session.expunge().await
        .context("Failed to expunge")?;

    Ok(())
}

/// Append a message (draft) to a folder on the IMAP server.
pub async fn append_to_folder(
    session: &mut ImapSession,
    folder_path: &str,
    message: &[u8],
    flags: &[&str],
) -> Result<()> {
    let flags_str = if flags.is_empty() {
        None
    } else {
        Some(format!("({})", flags.join(" ")))
    };

    session.append(folder_path, flags_str.as_deref(), None, message).await
        .context(format!("Failed to append message to {}", folder_path))?;

    Ok(())
}
