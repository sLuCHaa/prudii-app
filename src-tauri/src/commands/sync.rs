use crate::credentials;
use crate::db::Database;
use crate::gmail;
use crate::imap;
use crate::outlook;
use crate::models::{Account, SearchResult, SyncProgress};
use crate::pool::ImapPool;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Per-account sync lock — prevents concurrent syncs of the same account.
/// Public so the IDLE watcher can check it before quick-syncing.
pub static SYNCING_ACCOUNTS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn emit_progress(app: &AppHandle, progress: &SyncProgress) {
    let _ = app.emit("sync-progress", progress);
}

/// Process pending operations for a Gmail account before sync.
/// Retries any operations that failed or were interrupted on previous attempts.
async fn process_pending_ops_gmail(client: &gmail::api::GmailClient, account_id: &str, db: &Database) {
    let ops: Vec<(i64, String, String, String)> = {
        let conn = db.lock_db();
        let mut stmt = match conn.prepare(
            "SELECT id, mail_id, op_type, payload FROM pending_ops WHERE account_id = ?1 AND retry_count < 10 ORDER BY created_at ASC"
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        stmt.query_map(rusqlite::params![account_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        }).unwrap().filter_map(|r| r.ok()).collect()
    };
    if ops.is_empty() { return; }

    log::info!("Processing {} pending ops for Gmail account {}", ops.len(), account_id);

    for (id, _mail_id, op_type, payload) in &ops {
        let parsed: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => { delete_stale_op(db, *id); continue; }
        };
        let api_id = parsed["api_id"].as_str().unwrap_or("");
        if api_id.is_empty() && op_type != "set_read" && op_type != "set_star" {
            delete_stale_op(db, *id);
            continue;
        }

        let result = match op_type.as_str() {
            "set_read" => {
                let value = parsed["value"].as_bool().unwrap_or(true);
                // `value` is the desired is_read state. toggle_read sets
                // is_read = !currently_read, so pass !value to land on `value`.
                // (Passing a literal false here marked unread mails as read on retry.)
                if value {
                    gmail::messages::mark_as_read(client, api_id).await
                } else {
                    gmail::messages::toggle_read(client, api_id, !value).await
                }
            }
            "set_star" => {
                let value = parsed["value"].as_bool().unwrap_or(true);
                if value {
                    client.modify_message(api_id, &["STARRED"], &[]).await
                } else {
                    client.modify_message(api_id, &[], &["STARRED"]).await
                }
            }
            "archive" => gmail::messages::archive_message(client, api_id).await,
            "trash" => gmail::messages::trash_message(client, api_id).await,
            "delete" => gmail::messages::delete_message(client, api_id).await,
            "move" => {
                let source = parsed["source_folder"].as_str().unwrap_or("");
                let dest = parsed["dest_folder"].as_str().unwrap_or("");
                if dest.is_empty() {
                    delete_stale_op(db, *id);
                    continue;
                }
                gmail::messages::move_message(client, api_id, dest, source).await
            }
            _ => { delete_stale_op(db, *id); continue; }
        };

        let conn = db.lock_db();
        if result.is_ok() {
            let _ = conn.execute("DELETE FROM pending_ops WHERE id = ?1", rusqlite::params![id]);
            log::info!("Pending op {} ({}) succeeded for Gmail", id, op_type);
        } else {
            let _ = conn.execute("UPDATE pending_ops SET retry_count = retry_count + 1 WHERE id = ?1", rusqlite::params![id]);
            log::warn!("Pending op {} ({}) failed for Gmail, will retry", id, op_type);
        }
    }
}

/// Execute one Outlook pending op against the Graph API.
/// For move-type ops the message's NEW Graph ID (IDs change on every move)
/// is persisted to the local mail row if it still exists.
async fn exec_outlook_op(
    client: &outlook::api::OutlookClient,
    db: &Database,
    mail_id: &str,
    op_type: &str,
    parsed: &serde_json::Value,
    api_id: &str,
) -> anyhow::Result<()> {
    match op_type {
        "set_read" => {
            let value = parsed["value"].as_bool().unwrap_or(true);
            // `value` is the desired is_read state. toggle_read sets
            // is_read = !currently_read, so pass !value to land on `value`.
            // (Passing a literal false here marked unread mails as read on retry.)
            if value {
                outlook::messages::mark_as_read(client, api_id).await
            } else {
                outlook::messages::toggle_read(client, api_id, !value).await
            }
        }
        "set_star" => {
            let value = parsed["value"].as_bool().unwrap_or(true);
            outlook::messages::toggle_star(client, api_id, !value).await
        }
        "archive" | "trash" | "move" => {
            let dest = parsed["dest_folder"].as_str().unwrap_or("");
            let new_id = outlook::messages::move_message(client, api_id, dest).await?;
            let conn = db.lock_db();
            let _ = conn.execute(
                "UPDATE mails SET message_id = ?1 WHERE id = ?2",
                rusqlite::params![new_id, mail_id],
            );
            Ok(())
        }
        "delete" => outlook::messages::delete_message(client, api_id).await,
        _ => anyhow::bail!("unknown op type"),
    }
}

/// Process pending operations for an Outlook account before sync.
async fn process_pending_ops_outlook(client: &outlook::api::OutlookClient, account_id: &str, db: &Database) {
    // Purge ops that exhausted their retries — the processor below only loads
    // retry_count < 10, so these would otherwise linger invisibly forever.
    {
        let conn = db.lock_db();
        let purged = conn.execute(
            "DELETE FROM pending_ops WHERE account_id = ?1 AND retry_count >= 10",
            rusqlite::params![account_id],
        ).unwrap_or(0);
        if purged > 0 {
            log::error!("Outlook: dropped {} pending ops that exhausted their retries for account {}", purged, account_id);
        }
    }

    let ops: Vec<(i64, String, String, String)> = {
        let conn = db.lock_db();
        let mut stmt = match conn.prepare(
            "SELECT id, mail_id, op_type, payload FROM pending_ops WHERE account_id = ?1 AND retry_count < 10 ORDER BY created_at ASC"
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        stmt.query_map(rusqlite::params![account_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        }).unwrap().filter_map(|r| r.ok()).collect()
    };
    if ops.is_empty() { return; }

    log::info!("Processing {} pending ops for Outlook account {}", ops.len(), account_id);

    for (id, mail_id, op_type, payload) in &ops {
        let parsed: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => { delete_stale_op(db, *id); continue; }
        };
        let api_id = parsed["api_id"].as_str().unwrap_or("");
        if !matches!(op_type.as_str(), "set_read" | "set_star" | "archive" | "trash" | "move" | "delete") {
            delete_stale_op(db, *id);
            continue;
        }
        let needs_dest = matches!(op_type.as_str(), "archive" | "trash" | "move");
        if needs_dest && parsed["dest_folder"].as_str().unwrap_or("").is_empty() {
            delete_stale_op(db, *id);
            continue;
        }
        if api_id.is_empty() {
            delete_stale_op(db, *id);
            continue;
        }

        let mut result = exec_outlook_op(client, db, mail_id, op_type, &parsed, api_id).await;

        // Graph message IDs are mutable — a 404 usually means the stored ID went
        // stale after a folder move. Re-resolve via internetMessageId (from the op
        // payload, falling back to the mail row) and retry once with the fresh ID.
        let is_stale = matches!(&result, Err(e) if e.to_string().contains("(404"));
        if is_stale {
            let internet_id = parsed["internet_id"].as_str()
                .map(str::to_string)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT COALESCE(\"references\", '') FROM mails WHERE id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get::<_, String>(0),
                    ).ok().filter(|s| !s.is_empty())
                });

            let resolved = match internet_id {
                Some(iid) => client.find_message_by_internet_id(&iid).await.ok().flatten(),
                None => None,
            };

            match resolved {
                Some(found) => {
                    let new_api_id = found.id;
                    {
                        let conn = db.lock_db();
                        let _ = conn.execute(
                            "UPDATE mails SET message_id = ?1 WHERE id = ?2",
                            rusqlite::params![new_api_id, mail_id],
                        );
                        // Persist the corrected ID in the payload for any future retry
                        let mut updated = parsed.clone();
                        updated["api_id"] = serde_json::Value::String(new_api_id.clone());
                        let _ = conn.execute(
                            "UPDATE pending_ops SET payload = ?1 WHERE id = ?2",
                            rusqlite::params![updated.to_string(), id],
                        );
                    }
                    log::info!("Pending op {} ({}): stale Graph ID re-resolved via internetMessageId, retrying", id, op_type);
                    result = exec_outlook_op(client, db, mail_id, op_type, &parsed, &new_api_id).await;
                }
                None => {
                    // The message no longer exists in the mailbox (or can't be
                    // identified) — the op can never succeed, drop it now instead
                    // of burning retries.
                    log::warn!("Pending op {} ({}): message gone from server and not re-resolvable, dropping", id, op_type);
                    delete_stale_op(db, *id);
                    continue;
                }
            }
        }

        let conn = db.lock_db();
        if result.is_ok() {
            let _ = conn.execute("DELETE FROM pending_ops WHERE id = ?1", rusqlite::params![id]);
            log::info!("Pending op {} ({}) succeeded for Outlook", id, op_type);
        } else {
            let _ = conn.execute("UPDATE pending_ops SET retry_count = retry_count + 1 WHERE id = ?1", rusqlite::params![id]);
            log::warn!("Pending op {} ({}) failed for Outlook, will retry", id, op_type);
        }
    }
}

/// Process pending operations for an IMAP account before sync.
async fn process_pending_ops_imap(session: &mut imap::ImapSession, account_id: &str, db: &Database) {
    let ops: Vec<(i64, String, String, String)> = {
        let conn = db.lock_db();
        let mut stmt = match conn.prepare(
            "SELECT id, mail_id, op_type, payload FROM pending_ops WHERE account_id = ?1 AND retry_count < 10 ORDER BY created_at ASC"
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        stmt.query_map(rusqlite::params![account_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        }).unwrap().filter_map(|r| r.ok()).collect()
    };
    if ops.is_empty() { return; }

    log::info!("Processing {} pending ops for IMAP account {}", ops.len(), account_id);

    for (id, mail_id, op_type, payload) in &ops {
        let parsed: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => { delete_stale_op(db, *id); continue; }
        };

        let uid: Option<u32> = parsed["uid"].as_u64().map(|u| u as u32).or_else(|| {
            let conn = db.lock_db();
            conn.query_row(
                "SELECT uid FROM mails WHERE id = ?1 AND uid IS NOT NULL",
                rusqlite::params![mail_id],
                |row| row.get::<_, u32>(0),
            ).ok()
        });

        let folder_path = parsed["folder_path"].as_str().unwrap_or("").to_string();

        let result: Result<(), anyhow::Error> = match op_type.as_str() {
            "set_read" => {
                let fp = if folder_path.is_empty() {
                    // Look up folder path from DB (works even when uid is NULL)
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT f.path FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get::<_, String>(0),
                    ).unwrap_or_default()
                } else {
                    folder_path.clone()
                };
                if fp.is_empty() {
                    delete_stale_op(db, *id);
                    continue;
                }
                // Resolve the UID: prefer the cached value, otherwise search the
                // folder by Message-ID (api_id carries the RFC822 Message-ID for
                // IMAP). Without this fallback the read/unread push was dropped for
                // mails whose UID hadn't been re-synced yet (e.g. just moved).
                let resolved_uid = match uid {
                    Some(u) => Some(u),
                    None => {
                        let message_id = parsed["api_id"].as_str().unwrap_or("");
                        if message_id.is_empty() {
                            None
                        } else {
                            imap::search_uid_by_message_id(session, &fp, message_id).await.ok().flatten()
                        }
                    }
                };
                if let Some(uid) = resolved_uid {
                    let value = parsed["value"].as_bool().unwrap_or(true);
                    imap::set_seen_flag_on_server(session, &fp, uid, value).await
                        .map_err(|e| anyhow::anyhow!("{}", e))
                } else {
                    delete_stale_op(db, *id);
                    continue;
                }
            }
            "set_star" => {
                if let Some(uid) = uid {
                    let fp = if folder_path.is_empty() {
                        let conn = db.lock_db();
                        conn.query_row(
                            "SELECT f.path FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
                            rusqlite::params![mail_id],
                            |row| row.get::<_, String>(0),
                        ).unwrap_or_default()
                    } else {
                        folder_path.clone()
                    };
                    if fp.is_empty() {
                        delete_stale_op(db, *id);
                        continue;
                    }
                    let value = parsed["value"].as_bool().unwrap_or(true);
                    imap::set_flagged_on_server(session, &fp, uid, value).await
                        .map_err(|e| anyhow::anyhow!("{}", e))
                } else {
                    delete_stale_op(db, *id);
                    continue;
                }
            }
            "archive" | "trash" => {
                let source = parsed["source_folder"].as_str().unwrap_or("");
                let dest = parsed["dest_folder"].as_str().unwrap_or("");
                if source.is_empty() || dest.is_empty() {
                    delete_stale_op(db, *id);
                    continue;
                }
                if let Some(uid) = uid {
                    let is_gmail = parsed["is_gmail"].as_bool().unwrap_or(false);
                    let skip_copy = is_gmail && source.eq_ignore_ascii_case("INBOX") && op_type == "archive";
                    imap::move_mail_on_server(session, source, dest, uid, skip_copy, false).await
                        .map_err(|e| anyhow::anyhow!("{}", e))
                } else {
                    let message_id = parsed["message_id"].as_str().unwrap_or("");
                    if !message_id.is_empty() {
                        if let Ok(Some(resolved_uid)) = imap::search_uid_by_message_id(session, source, message_id).await {
                            let is_gmail = parsed["is_gmail"].as_bool().unwrap_or(false);
                            let skip_copy = is_gmail && source.eq_ignore_ascii_case("INBOX") && op_type == "archive";
                            imap::move_mail_on_server(session, source, dest, resolved_uid, skip_copy, false).await
                                .map_err(|e| anyhow::anyhow!("{}", e))
                        } else {
                            delete_stale_op(db, *id);
                            continue;
                        }
                    } else {
                        delete_stale_op(db, *id);
                        continue;
                    }
                }
            }
            "delete" => {
                // Permanent delete retried after a failed immediate attempt. The
                // local row is already gone, so everything is read from the payload.
                if folder_path.is_empty() {
                    delete_stale_op(db, *id);
                    continue;
                }
                let message_id = parsed["message_id"].as_str().unwrap_or("");
                let trash_folder_path = parsed["trash_folder_path"].as_str();
                let is_gmail = parsed["is_gmail"].as_bool().unwrap_or(false);
                imap::permanent_delete_on_server(session, &folder_path, uid, message_id, trash_folder_path, is_gmail).await
                    .map_err(|e| anyhow::anyhow!("{}", e))
            }
            "move" => {
                let source = parsed["source_folder"].as_str().unwrap_or("");
                let dest = parsed["dest_folder"].as_str().unwrap_or("");
                if source.is_empty() || dest.is_empty() {
                    delete_stale_op(db, *id);
                    continue;
                }
                let resolved_uid = match uid {
                    Some(u) => Some(u),
                    None => {
                        let message_id = parsed["message_id"].as_str().unwrap_or("");
                        if message_id.is_empty() {
                            None
                        } else {
                            imap::search_uid_by_message_id(session, source, message_id).await.ok().flatten()
                        }
                    }
                };
                if let Some(uid) = resolved_uid {
                    imap::move_mail_on_server(session, source, dest, uid, false, false).await
                        .map_err(|e| anyhow::anyhow!("{}", e))
                } else {
                    delete_stale_op(db, *id);
                    continue;
                }
            }
            _ => { delete_stale_op(db, *id); continue; }
        };

        let conn = db.lock_db();
        if result.is_ok() {
            let _ = conn.execute("DELETE FROM pending_ops WHERE id = ?1", rusqlite::params![id]);
            log::info!("Pending op {} ({}) succeeded for IMAP", id, op_type);
        } else {
            let _ = conn.execute("UPDATE pending_ops SET retry_count = retry_count + 1 WHERE id = ?1", rusqlite::params![id]);
            log::warn!("Pending op {} ({}) failed for IMAP: {:?}", id, op_type, result.err());
        }
    }
}

/// Delete a stale/invalid pending op (bad payload, missing data, etc.)
fn delete_stale_op(db: &Database, id: i64) {
    let conn = db.lock_db();
    let _ = conn.execute("DELETE FROM pending_ops WHERE id = ?1", rusqlite::params![id]);
}

/// Remove mails from the given archive folder (Gmail "All Mail") that already
/// exist in another folder (INBOX, Sent, etc.) for the same account — keeps
/// only mails that are truly archived (not present anywhere else). Also
/// prunes orphaned FTS rows and refreshes the folder's total_count. Returns
/// the number of mails deleted.
fn dedup_archive_folder(
    conn: &rusqlite::Connection,
    account_id: &str,
    archive_folder_id: &str,
) -> rusqlite::Result<usize> {
    // Delete mails whose message_id already exists in a non-archive folder
    let deleted = conn.execute(
        "DELETE FROM mails WHERE folder_id = ?1 AND message_id IS NOT NULL AND message_id != '' AND message_id IN (\
            SELECT m2.message_id FROM mails m2 \
            WHERE m2.account_id = ?2 AND m2.folder_id != ?1 \
              AND m2.message_id IS NOT NULL AND m2.message_id != ''\
        )",
        rusqlite::params![archive_folder_id, account_id],
    )?;

    if deleted > 0 {
        log::info!("Gmail dedup: Removed {} duplicate mails from archive folder", deleted);
        let _ = conn.execute(
            "DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)",
            [],
        );
    }

    // Update total_count to reflect actual deduplicated count
    let remaining: i32 = conn.query_row(
        "SELECT COUNT(*) FROM mails WHERE folder_id = ?1",
        rusqlite::params![archive_folder_id],
        |row| row.get(0),
    ).unwrap_or(0);
    let _ = conn.execute(
        "UPDATE folders SET total_count = ?1 WHERE id = ?2",
        rusqlite::params![remaining, archive_folder_id],
    );

    Ok(deleted)
}

/// Internal sync logic — runs inside a spawned background task.
/// Communicates all progress and errors via events (never returns errors to IPC).
async fn do_sync_account(app: AppHandle, account: Account, account_id: String, credential: String, auth_type: String) {
    // Atomic check-and-claim of the per-account sync lock.
    {
        let mut syncing = SYNCING_ACCOUNTS.lock().unwrap_or_else(|e| e.into_inner());
        if syncing.contains(&account_id) {
            emit_progress(&app, &SyncProgress {
                account_id: account_id.clone(),
                status: "skipped".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 0,
                new_mails: 0,
                message: "Sync already in progress".into(),
            });
            return;
        }
        syncing.insert(account_id.clone());
    }
    // Drop guard releases the lock on every exit path (success, error, abort).
    let _sync_guard = crate::cleanup_guard::SetGuard::new(&SYNCING_ACCOUNTS, account_id.clone());

    do_sync_account_inner(&app, account, &account_id, &credential, &auth_type).await;
}

async fn do_sync_account_inner(app: &AppHandle, account: Account, account_id: &str, credential: &str, auth_type: &str) {
    // Gmail REST API path — skip IMAP entirely for Google OAuth accounts
    if account.provider == "google" && auth_type == "oauth" {
        do_gmail_sync(app, &account, account_id, credential).await;
        return;
    }

    // Microsoft Graph API path — skip IMAP entirely for Microsoft OAuth accounts
    if account.provider == "microsoft" && auth_type == "oauth" {
        do_outlook_sync(app, &account, account_id, credential).await;
        return;
    }

    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "connecting".into(),
        folder_name: None,
        folder_index: 0,
        folder_count: 0,
        new_mails: 0,
        message: "Connecting...".into(),
    });

    let mut session = match imap::connect_with_auth(
        &account.imap_host,
        account.imap_port as u16,
        &account.email,
        auth_type,
        credential,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "error".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 0,
                new_mails: 0,
                message: format!("IMAP connection failed: {:#}", e),
            });
            return;
        }
    };

    let db = app.state::<Database>();

    // Check if this is first sync (no folders with uid_next yet)
    let is_first_sync = {
        let conn = db.lock_db();
        let max_uid_next: u32 = conn
            .query_row(
                "SELECT COALESCE(MAX(uid_next), 0) FROM folders WHERE account_id = ?1",
                rusqlite::params![account_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        max_uid_next == 0
    };

    // Always LIST folders from server to discover new/deleted folders.
    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "syncing_folders".into(),
        folder_name: None,
        folder_index: 0,
        folder_count: 0,
        new_mails: 0,
        message: "Syncing folders...".into(),
    });

    let folders = match imap::sync_folders(&mut session, account_id, &db).await {
        Ok(f) => f,
        Err(e) => {
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "error".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 0,
                new_mails: 0,
                message: format!("Folder sync failed: {}", e),
            });
            let _ = session.logout().await;
            return;
        }
    };

    process_pending_ops_imap(&mut session, account_id, &db).await;

    let folders_to_sync: Vec<&crate::models::Folder> = if is_first_sync {
        log::info!("First sync for account {} — syncing all {} folders", account_id, folders.len());
        folders.iter().collect()
    } else {
        // Periodic sync: all server folders (local-only folders have no IMAP path)
        let server_folders: Vec<&crate::models::Folder> = folders
            .iter()
            .filter(|f| !f.is_local)
            .collect();
        log::info!(
            "Periodic sync for account {} — syncing {} folder(s), skipping {} local",
            account_id,
            server_folders.len(),
            folders.len() - server_folders.len()
        );
        server_folders
    };

    // Gmail's "[Gmail]/All Mail" (folder_type "archive") contains every message
    // already present in INBOX/Sent, so syncing it on every pass re-fetches the
    // whole mailbox. Exclude it from routine sync and load it on demand via
    // sync_folder(). Only applies to Gmail (this IMAP branch = non-OAuth accounts).
    let folders_to_sync: Vec<&crate::models::Folder> = if account.provider == "google" {
        folders_to_sync
            .into_iter()
            .filter(|f| f.folder_type != "archive")
            .collect()
    } else {
        folders_to_sync
    };

    let folder_count = folders_to_sync.len() as u32;
    let mut total_new: u32 = 0;
    let sync_start = std::time::Instant::now();

    for (i, folder) in folders_to_sync.iter().enumerate() {
        emit_progress(app, &SyncProgress {
            account_id: account_id.to_string(),
            status: "syncing_mails".into(),
            folder_name: Some(folder.name.clone()),
            folder_index: i as u32,
            folder_count,
            new_mails: total_new,
            message: format!("Syncing {} ({}/{})...", folder.name, i + 1, folder_count),
        });

        match imap::sync_mails(&mut session, folder, account_id, &db, Some((app, i as u32, folder_count, total_new))).await {
            Ok(stats) => {
                total_new += stats.new_mails;
            }
            Err(e) => {
                log::warn!("Failed to sync folder {}: {}", folder.name, e);
                emit_progress(app, &SyncProgress {
                    account_id: account_id.to_string(),
                    status: "folder_error".into(),
                    folder_name: Some(folder.name.clone()),
                    folder_index: i as u32,
                    folder_count,
                    new_mails: total_new,
                    message: format!("Error syncing {}: {}", folder.name, e),
                });
            }
        }

        emit_progress(app, &SyncProgress {
            account_id: account_id.to_string(),
            status: "syncing_mails".into(),
            folder_name: Some(folder.name.clone()),
            folder_index: i as u32 + 1,
            folder_count,
            new_mails: total_new,
            message: format!("Synced {} ({}/{}) — {} mails total", folder.name, i + 1, folder_count, total_new),
        });
    }

    // Gmail dedup: Remove mails from archive folders (All Mail) that already
    // exist in other folders (INBOX, Sent, etc.) — keeps only archived mails.
    // Only run on first sync (when all folders are synced).
    if is_first_sync {
        let conn = db.lock_db();
        let archive_ids: Vec<String> = (|| -> Result<Vec<String>, rusqlite::Error> {
            let mut stmt = conn.prepare("SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'archive'")?;
            let rows = stmt.query_map(rusqlite::params![account_id], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })().unwrap_or_else(|e| { log::error!("Gmail dedup query failed: {}", e); Vec::new() });

        for archive_id in &archive_ids {
            if let Err(e) = dedup_archive_folder(&conn, account_id, archive_id) {
                log::error!("Gmail dedup failed for archive folder {}: {}", archive_id, e);
            }
        }

        // FTS5 optimize: collapse the many small segments accumulated during bulk
        // initial insert into a single segment for faster searches. Runs once here,
        // after ALL folders are done — never on incremental syncs.
        {
            let conn = db.lock_db();
            let _ = conn.execute_batch("INSERT INTO mails_fts(mails_fts) VALUES('optimize')");
        }
        log::info!("IMAP initial sync FTS5 optimize complete for account {}", account_id);
    }

    {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE accounts SET last_sync = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![account_id],
        );
    }

    // Auto-prefetch bodies for the latest mails in INBOX so opening them is instant.
    // Uses the already-connected sync session — no extra TLS/login overhead.
    let inbox_folder = folders.iter().find(|f| f.folder_type == "inbox");
    if let Some(inbox) = inbox_folder {
        let mails_to_prefetch: Vec<(String, u32)> = {
            let conn = db.lock_db();
            conn.prepare(
                "SELECT id, uid FROM mails WHERE folder_id = ?1 AND body_text = '' AND uid IS NOT NULL ORDER BY date DESC LIMIT 30"
            )
            .ok()
            .and_then(|mut stmt| {
                stmt.query_map(rusqlite::params![inbox.id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_default()
        };

        if !mails_to_prefetch.is_empty() {
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "prefetching".into(),
                folder_name: Some(inbox.name.clone()),
                folder_index: folder_count,
                folder_count,
                new_mails: total_new,
                message: format!("Prefetching {} recent emails...", mails_to_prefetch.len()),
            });

            match imap::backfill_folder_bodies(&mut session, &inbox.path, &mails_to_prefetch, &db, app, None).await {
                Ok(count) => log::info!("Prefetched {} INBOX bodies during sync", count),
                Err(e) => log::warn!("INBOX body prefetch failed (non-fatal): {}", e),
            }
        }
    }

    log::info!(
        "Sync complete for account {}: {} new mails across {} folders in {:?}",
        account_id, total_new, folder_count, sync_start.elapsed()
    );

    // Return session to pool with folder info for instant reuse.
    // After prefetch, session is in INBOX; otherwise unknown.
    let pool = app.state::<ImapPool>();
    let last_folder = folders.iter().find(|f| f.folder_type == "inbox").map(|f| f.path.clone());
    if let Some(folder) = last_folder {
        pool.return_session_in_folder(account_id, session, folder).await;
    } else {
        pool.return_session(account_id, session).await;
    }

    if total_new > 0 {
        crate::notifications::send_new_mail_notification(app, account_id, total_new, &db);
    }

    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "done".into(),
        folder_name: None,
        folder_index: folder_count,
        folder_count,
        new_mails: total_new,
        message: format!("Sync complete. {} new mails.", total_new),
    });

    // Start IDLE watcher on INBOX for real-time push notifications.
    // Uses a separate connection so the pool session stays free for operations.
    // API accounts (Gmail/Outlook) use polling instead — no IDLE needed.
    if !((account.provider == "google" || account.provider == "microsoft") && auth_type == "oauth") {
        crate::idle::start_idle(
            app.clone(),
            account_id.to_string(),
            account.imap_host.clone(),
            account.imap_port as u16,
            account.email.clone(),
            credential.to_string(),
            auth_type.to_string(),
        );
    }
}

/// Gmail REST API sync — uses batch HTTP requests instead of IMAP.
/// Two-phase approach:
///   1. Incremental sync (History API) — picks up recent changes (new mails, label changes, deletes)
///   2. Initial sync catch-up — idempotent, only fetches messages not yet in DB
/// Phase 2 always runs so that interrupted initial syncs are automatically resumed.
async fn do_gmail_sync(app: &AppHandle, _account: &Account, account_id: &str, credential: &str) {
    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "connecting".into(),
        folder_name: None,
        folder_index: 0,
        folder_count: 0,
        new_mails: 0,
        message: "Connecting to Gmail API...".into(),
    });

    let client = gmail::api::GmailClient::new(credential);
    let db = app.state::<Database>();

    process_pending_ops_gmail(&client, account_id, &db).await;

    // Whether this account already had a Gmail history cursor when the sync
    // started. Distinguishes an established account (safe to reconcile Trash/Spam
    // against the server) from a first-ever sync (folders are freshly populated,
    // nothing stale to remove). Captured before Phase 1, which clears the cursor
    // on history expiry.
    let had_history_at_entry: bool = {
        let conn = db.lock_db();
        let hid: String = conn.query_row(
            "SELECT COALESCE(gmail_history_id, '') FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| row.get(0),
        ).unwrap_or_default();
        !hid.is_empty()
    };

    // Phase 1: Incremental sync for recent changes (if history_id exists)
    {
        let history_id: String = {
            let conn = db.lock_db();
            conn.query_row(
                "SELECT COALESCE(gmail_history_id, '') FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| row.get(0),
            )
            .unwrap_or_default()
        };

        if !history_id.is_empty() {
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 1,
                new_mails: 0,
                message: "Checking for changes...".into(),
            });

            match gmail::sync::incremental_sync(&client, account_id, &db, app).await {
                Ok(changes) => {
                    log::info!("Gmail incremental sync: {} changes", changes);
                }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("history_expired") || msg.contains("no_history_id") {
                        log::info!("Gmail: history unavailable, clearing for re-sync");
                        let conn = db.lock_db();
                        let _ = conn.execute(
                            "UPDATE accounts SET gmail_history_id = '' WHERE id = ?1",
                            rusqlite::params![account_id],
                        );
                    } else {
                        log::error!("Gmail incremental sync failed: {}", e);
                        emit_progress(app, &SyncProgress {
                            account_id: account_id.to_string(),
                            status: "error".into(),
                            folder_name: None,
                            folder_index: 0,
                            folder_count: 0,
                            new_mails: 0,
                            message: format!("Gmail sync failed: {}", e),
                        });
                        return; // API is broken, don't continue
                    }
                }
            }
        }
    }

    // Phase 2: Sync labels + initial sync catch-up for ALL folders
    // This is idempotent — already-synced messages are filtered by existing_ids.
    // For a fully synced account this is cheap (just list_messages to get IDs, no batch fetches).
    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "syncing_folders".into(),
        folder_name: None,
        folder_index: 0,
        folder_count: 0,
        new_mails: 0,
        message: "Syncing labels...".into(),
    });

    let folders = match gmail::sync::sync_labels(&client, account_id, &db).await {
        Ok(f) => f,
        Err(e) => {
            let err_msg = e.to_string();
            let message = if err_msg.contains("403") || err_msg.contains("insufficient") {
                "PERMISSION_DENIED".to_string()
            } else {
                format!("Label sync failed: {}", err_msg)
            };
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "error".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 0,
                new_mails: 0,
                message,
            });
            return;
        }
    };

    // Sort folders so ALL_MAIL is synced last (needs to dedup against all other folders)
    let mut folders = folders;
    folders.sort_by_key(|f| if f.path == "ALL_MAIL" { 1 } else { 0 });

    // Phase 2 optimization: if history_id exists (all folders previously synced),
    // only run initial_sync for NEW folders (no messages in DB yet).
    // This avoids re-listing all messages in every folder on periodic syncs.
    let has_history = {
        let conn = db.lock_db();
        let hid: String = conn.query_row(
            "SELECT COALESCE(gmail_history_id, '') FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| row.get(0),
        ).unwrap_or_default();
        !hid.is_empty()
    };

    let folders_needing_sync: Vec<&crate::models::Folder> = if has_history {
        let conn = db.lock_db();
        folders.iter().filter(|f| {
            let count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM mails WHERE folder_id = ?1",
                rusqlite::params![f.id],
                |row| row.get(0),
            ).unwrap_or(0);
            count == 0 // only sync folders with no messages (newly discovered)
        }).collect()
    } else {
        folders.iter().collect()
    };

    let folder_count = folders_needing_sync.len() as u32;
    let mut total_new: u32 = 0;
    let sync_start = std::time::Instant::now();

    if has_history && folder_count == 0 {
        log::debug!("Gmail Phase 2: all folders already synced, skipping");
    } else {
        log::debug!("Gmail Phase 2: {} folders need initial sync (out of {} total)", folder_count, folders.len());
    }

    let mut latest_history_id: Option<String> = None;

    for (i, folder) in folders_needing_sync.iter().enumerate() {
        emit_progress(app, &SyncProgress {
            account_id: account_id.to_string(),
            status: "syncing_mails".into(),
            folder_name: Some(folder.name.clone()),
            folder_index: i as u32,
            folder_count,
            new_mails: total_new,
            message: format!("Syncing {} ({}/{})...", folder.name, i + 1, folder_count),
        });

        match gmail::sync::initial_sync_folder(&client, folder, account_id, &db, Some((app, i as u32, folder_count, total_new))).await {
            Ok((new, hid)) => {
                total_new += new;
                if hid.is_some() {
                    latest_history_id = hid;
                }
            }
            Err(e) => {
                log::warn!("Gmail: failed to sync folder {}: {}", folder.name, e);
            }
        }
    }

    // Reconcile Trash/Spam against the server so permanent deletions made on
    // another device propagate even when this device missed the History window
    // (expiry → add-only full re-sync). Only for established accounts — the
    // first-ever sync just populated these folders, so nothing is stale.
    // Cheap: one listing per folder, skipped entirely when the folder is empty
    // locally. Runs before the count aggregation below so counts reflect it.
    if had_history_at_entry {
        for folder in folders.iter().filter(|f| f.folder_type == "trash" || f.folder_type == "spam") {
            match gmail::sync::reconcile_folder(&client, folder, account_id, &db).await {
                Ok(n) if n > 0 => log::info!("Gmail: reconciled {} — removed {} stale mails", folder.name, n),
                Ok(_) => {}
                Err(e) => log::warn!("Gmail: reconcile '{}' failed: {}", folder.name, e),
            }
        }
    }

    // Update folder counts from actual DB data using a single aggregate query
    {
        let conn = db.lock_db();
        let _ = conn.execute_batch(
            "UPDATE folders SET
                total_count = COALESCE((SELECT sq.total FROM (SELECT folder_id, COUNT(*) as total FROM mails GROUP BY folder_id) sq WHERE sq.folder_id = folders.id), 0),
                unread_count = COALESCE((SELECT sq.unread FROM (SELECT folder_id, COUNT(*) as unread FROM mails WHERE is_read = 0 GROUP BY folder_id) sq WHERE sq.folder_id = folders.id), 0)"
        );
    }

    // FTS5 optimize: collapse segments built up during the initial bulk insert.
    // Runs once after ALL folders complete for the very first sync (!has_history means
    // no history_id was stored yet — this is the initial full sync, not an incremental).
    if !has_history && total_new > 0 {
        let conn = db.lock_db();
        let _ = conn.execute_batch("INSERT INTO mails_fts(mails_fts) VALUES('optimize')");
        log::info!("Gmail initial sync FTS5 optimize complete for account {}", account_id);
    }

    // Store history_id ONLY after ALL folders complete — if stored prematurely,
    // next sync would use incremental and miss unsynced messages from interrupted folders
    if let Some(hid) = latest_history_id {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE accounts SET gmail_history_id = ?1 WHERE id = ?2 AND (gmail_history_id IS NULL OR gmail_history_id = '' OR CAST(?1 AS INTEGER) > CAST(gmail_history_id AS INTEGER))",
            rusqlite::params![hid, account_id],
        );
    }

    {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE accounts SET last_sync = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![account_id],
        );
    }

    log::info!(
        "Gmail sync complete for account {}: {} new mails across {} folders in {:?}",
        account_id, total_new, folder_count, sync_start.elapsed()
    );

    if total_new > 0 {
        crate::notifications::send_new_mail_notification(app, account_id, total_new, &db);
    }

    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "done".into(),
        folder_name: None,
        folder_index: folder_count,
        folder_count,
        new_mails: total_new,
        message: format!("Sync complete. {} new mails.", total_new),
    });

    // No IDLE for Gmail API — uses polling via sync_interval_minutes
}

/// Microsoft Graph API sync — uses HTTP requests instead of IMAP.
/// Two-phase approach (same as Gmail):
///   1. Incremental sync (Delta API per folder) — picks up recent changes
///   2. Initial sync catch-up — idempotent, only fetches messages not yet in DB
/// Phase 2 always runs so that interrupted initial syncs are automatically resumed.
async fn do_outlook_sync(app: &AppHandle, _account: &Account, account_id: &str, credential: &str) {
    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "connecting".into(),
        folder_name: None,
        folder_index: 0,
        folder_count: 0,
        new_mails: 0,
        message: "Connecting to Outlook API...".into(),
    });

    let client = outlook::api::OutlookClient::new(credential);
    let db = app.state::<Database>();

    process_pending_ops_outlook(&client, account_id, &db).await;

    // Phase 1: Incremental sync for recent changes (if any folder has delta_link)
    {
        let has_delta: bool = {
            let conn = db.lock_db();
            let count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM folders WHERE account_id = ?1 AND delta_link != ''",
                rusqlite::params![account_id],
                |row| row.get(0),
            ).unwrap_or(0);
            count > 0
        };

        if has_delta {
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 1,
                new_mails: 0,
                message: "Checking for changes...".into(),
            });

            let delta_folders: Vec<crate::models::Folder> = {
                let conn = db.lock_db();
                (|| -> Result<Vec<crate::models::Folder>, rusqlite::Error> {
                    let mut stmt = conn.prepare(
                        "SELECT id, account_id, name, folder_type, path, unread_count, total_count, COALESCE(is_local, 0), COALESCE(color, '') FROM folders WHERE account_id = ?1 AND delta_link != ''"
                    )?;
                    let rows = stmt.query_map(rusqlite::params![account_id], |row| {
                        Ok(crate::models::Folder {
                            id: row.get(0)?,
                            account_id: row.get(1)?,
                            name: row.get(2)?,
                            folder_type: row.get(3)?,
                            path: row.get(4)?,
                            unread_count: row.get(5)?,
                            total_count: row.get(6)?,
                            is_local: row.get::<_, i32>(7)? != 0,
                            color: row.get(8)?,
                        })
                    })?;
                    Ok(rows.filter_map(|r| r.ok()).collect())
                })().unwrap_or_else(|e| { log::error!("Outlook delta folders query failed: {}", e); Vec::new() })
            };

            for folder in &delta_folders {
                match outlook::sync::incremental_sync_folder(&client, folder, account_id, &db).await {
                    Ok(changes) => {
                        log::debug!("Outlook incremental sync '{}': {} changes", folder.name, changes);
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        if msg.contains("delta_expired") {
                            log::info!("Outlook: delta expired for folder '{}', will catch up in phase 2", folder.name);
                        } else {
                            log::warn!("Outlook incremental sync failed for '{}': {}", folder.name, e);
                        }
                    }
                }
            }
        }
    }

    // Phase 2: Sync folders + initial sync catch-up for ALL folders
    // This is idempotent — already-synced messages are filtered by existing_ids.
    // For a fully synced account this is cheap (just list_messages to get IDs, no inserts).
    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "syncing_folders".into(),
        folder_name: None,
        folder_index: 0,
        folder_count: 0,
        new_mails: 0,
        message: "Syncing folders...".into(),
    });

    let folders = match outlook::sync::sync_folders(&client, account_id, &db).await {
        Ok(f) => f,
        Err(e) => {
            let err_msg = e.to_string();
            let message = if err_msg.contains("403") || err_msg.contains("insufficient") {
                "PERMISSION_DENIED".to_string()
            } else {
                format!("Folder sync failed: {}", err_msg)
            };
            emit_progress(app, &SyncProgress {
                account_id: account_id.to_string(),
                status: "error".into(),
                folder_name: None,
                folder_index: 0,
                folder_count: 0,
                new_mails: 0,
                message,
            });
            return;
        }
    };

    // Phase 2: initial sync for folders without a delta_link.
    // initial_sync_folder filters out existing message_ids, so it's safe to re-run
    // on folders that already have messages — it only inserts missing ones.
    let folders_needing_sync: Vec<&crate::models::Folder> = {
        let conn = db.lock_db();
        folders.iter().filter(|f| {
            let delta: String = conn.query_row(
                "SELECT COALESCE(delta_link, '') FROM folders WHERE id = ?1",
                rusqlite::params![f.id],
                |row| row.get(0),
            ).unwrap_or_default();
            delta.is_empty() // No delta_link → needs initial sync (idempotent)
        }).collect()
    };

    let folder_count = folders_needing_sync.len() as u32;
    let mut total_new: u32 = 0;
    let sync_start = std::time::Instant::now();

    if folder_count > 0 {
        let names: Vec<&str> = folders_needing_sync.iter().map(|f| f.name.as_str()).collect();
        log::debug!("Outlook Phase 2: {} folders need initial sync (out of {} total): {:?}", folder_count, folders.len(), names);
    } else {
        log::debug!("Outlook Phase 2: all {} folders already synced, skipping", folders.len());
    }

    for (i, folder) in folders_needing_sync.iter().enumerate() {
        emit_progress(app, &SyncProgress {
            account_id: account_id.to_string(),
            status: "syncing_mails".into(),
            folder_name: Some(folder.name.clone()),
            folder_index: i as u32,
            folder_count,
            new_mails: total_new,
            message: format!("Syncing {} ({}/{})...", folder.name, i + 1, folder_count),
        });

        match outlook::sync::initial_sync_folder(&client, folder, account_id, &db, Some((app, i as u32, folder_count, total_new))).await {
            Ok(new) => {
                total_new += new;
            }
            Err(e) => {
                log::warn!("Outlook: failed to sync folder {}: {}", folder.name, e);
            }
        }
    }

    // Spawn background tasks for folders still missing delta_link.
    // These paginate through ALL delta pages to acquire the final delta_link
    // without blocking sync. Large folders (10k+ messages) can take minutes.
    {
        let conn = db.lock_db();
        let missing_folders: Vec<(String, String, String)> = folders.iter().filter_map(|f| {
            let delta: String = conn.query_row(
                "SELECT COALESCE(delta_link, '') FROM folders WHERE id = ?1",
                rusqlite::params![f.id],
                |row| row.get(0),
            ).unwrap_or_default();
            if delta.is_empty() {
                Some((f.id.clone(), f.path.clone(), f.name.clone()))
            } else {
                None
            }
        }).collect();
        drop(conn);

        if !missing_folders.is_empty() {
            let names: Vec<&str> = missing_folders.iter().map(|(_, _, n)| n.as_str()).collect();
            log::debug!("Outlook: spawning background delta-link acquisition for {} folders: {:?}", missing_folders.len(), names);
            let token = credential.to_string();
            let app_bg = app.clone();
            let account_id_for_registry = account_id.to_string();
            crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                let bg_client = outlook::api::OutlookClient::new(&token);
                let bg_db = app_bg.state::<Database>();
                for (db_folder_id, graph_folder_id, folder_name) in &missing_folders {
                    outlook::sync::acquire_delta_link_full(
                        &bg_client,
                        graph_folder_id,
                        folder_name,
                        db_folder_id,
                        &bg_db,
                    ).await;
                }
            });
        }
    }

    // Update folder counts from actual DB data using a single aggregate query
    {
        let conn = db.lock_db();
        let _ = conn.execute_batch(
            "UPDATE folders SET
                total_count = COALESCE((SELECT sq.total FROM (SELECT folder_id, COUNT(*) as total FROM mails GROUP BY folder_id) sq WHERE sq.folder_id = folders.id), 0),
                unread_count = COALESCE((SELECT sq.unread FROM (SELECT folder_id, COUNT(*) as unread FROM mails WHERE is_read = 0 GROUP BY folder_id) sq WHERE sq.folder_id = folders.id), 0)"
        );
    }

    {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE accounts SET last_sync = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![account_id],
        );
    }

    log::info!(
        "Outlook sync complete for account {}: {} new mails across {} folders in {:?}",
        account_id, total_new, folder_count, sync_start.elapsed()
    );

    if total_new > 0 {
        crate::notifications::send_new_mail_notification(app, account_id, total_new, &db);
    }

    emit_progress(app, &SyncProgress {
        account_id: account_id.to_string(),
        status: "done".into(),
        folder_name: None,
        folder_index: folder_count,
        folder_count,
        new_mails: total_new,
        message: format!("Sync complete. {} new mails.", total_new),
    });

    // No IDLE for Outlook API — uses polling via sync_interval_minutes
}

#[tauri::command]
pub async fn sync_account(
    app: AppHandle,
    db: State<'_, Database>,
    account_id: String,
    password: Option<String>,
) -> Result<(), String> {
    let account: Account = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl') as smtp_security, auth_type, COALESCE(signature_html, '') as signature_html, COALESCE(signature_text, '') as signature_text, COALESCE(sync_interval_minutes, 0) as sync_interval_minutes, COALESCE(signature_on_compose, 1) as signature_on_compose, COALESCE(signature_on_reply, 1) as signature_on_reply, COALESCE(load_external_images, 'always') as load_external_images, created_at, updated_at FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| {
                Ok(Account {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    display_name: row.get(2)?,
                    provider: row.get(3)?,
                    color: row.get(4)?,
                    imap_host: row.get(5)?,
                    imap_port: row.get(6)?,
                    smtp_host: row.get(7)?,
                    smtp_port: row.get(8)?,
                    smtp_security: row.get(9)?,
                    auth_type: row.get(10)?,
                    signature_html: row.get(11)?,
                    signature_text: row.get(12)?,
                    sync_interval_minutes: row.get(13)?,
                    signature_on_compose: row.get(14)?,
                    signature_on_reply: row.get(15)?,
                    load_external_images: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )
        .map_err(|e| format!("Account not found: {}", e))?
    };

    let auth_type = account.auth_type.clone();
    let provider = account.provider.clone();
    let credential = if let Some(pw) = password {
        // When password is provided directly (e.g. from Account Wizard),
        // also store it in the keyring so other commands can access it later
        let _ = credentials::store_password(&account_id, &pw);
        pw
    } else {
        credentials::resolve_credential(&account_id, &auth_type, &provider)
            .await
            .map_err(|e| format!("Failed to retrieve credentials: {}", e))?
    };

    // Spawn background task — returns immediately, progress via events
    let app_clone = app.clone();
    let account_id_for_registry = account_id.clone();
    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
        do_sync_account(app_clone, account, account_id, credential, auth_type).await;
    });

    Ok(())
}

/// Sync a single folder on demand — used for Gmail's All Mail archive, which is
/// excluded from routine sync to avoid re-fetching the entire mailbox.
#[tauri::command]
pub async fn sync_folder(
    _app: AppHandle,
    db: State<'_, Database>,
    account_id: String,
    folder_id: String,
) -> Result<(), String> {
    let account: Account = {
        let conn = db.lock_db();
        conn.query_row(
            // Same columns as sync_account (sync.rs:1293).
            "SELECT id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl') as smtp_security, auth_type, COALESCE(signature_html, '') as signature_html, COALESCE(signature_text, '') as signature_text, COALESCE(sync_interval_minutes, 0) as sync_interval_minutes, COALESCE(signature_on_compose, 1) as signature_on_compose, COALESCE(signature_on_reply, 1) as signature_on_reply, COALESCE(load_external_images, 'always') as load_external_images, created_at, updated_at FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok(Account {
                id: row.get(0)?, email: row.get(1)?, display_name: row.get(2)?, provider: row.get(3)?,
                color: row.get(4)?, imap_host: row.get(5)?, imap_port: row.get(6)?, smtp_host: row.get(7)?,
                smtp_port: row.get(8)?, smtp_security: row.get(9)?, auth_type: row.get(10)?,
                signature_html: row.get(11)?, signature_text: row.get(12)?, sync_interval_minutes: row.get(13)?,
                signature_on_compose: row.get(14)?, signature_on_reply: row.get(15)?, load_external_images: row.get(16)?,
                created_at: row.get(17)?, updated_at: row.get(18)?,
            }),
        )
        .map_err(|e| format!("Account not found: {}", e))?
    };

    // OAuth accounts sync via the Gmail/Graph API path — no IMAP folder sync here.
    if account.auth_type == "oauth" {
        return Ok(());
    }

    let folder: crate::models::Folder = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT id, account_id, name, folder_type, path, COALESCE(unread_count,0), COALESCE(total_count,0), is_local, COALESCE(color,'') FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| Ok(crate::models::Folder {
                id: row.get(0)?, account_id: row.get(1)?, name: row.get(2)?, folder_type: row.get(3)?,
                path: row.get(4)?, unread_count: row.get(5)?, total_count: row.get(6)?,
                is_local: row.get(7)?, color: row.get(8)?,
            }),
        )
        .map_err(|e| format!("Folder not found: {}", e))?
    };

    let auth_type = account.auth_type.clone();
    let provider = account.provider.clone();
    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let mut session = imap::connect_with_auth(
        &account.imap_host, account.imap_port as u16, &account.email, &auth_type, &credential,
    )
    .await
    .map_err(|e| format!("IMAP connection failed: {:#}", e))?;

    let sync_result = imap::sync_mails(&mut session, &folder, &account_id, &db, None).await;

    // On-demand Gmail archive load bypasses the routine-sync dedup (that folder
    // is excluded from routine sync — see do_sync_account_inner), so dedup it
    // here instead, right after fetching the full All Mail contents.
    if sync_result.is_ok() && folder.folder_type == "archive" && account.provider == "google" {
        let conn = db.lock_db();
        if let Err(e) = dedup_archive_folder(&conn, &account_id, &folder.id) {
            log::error!("Gmail dedup failed for archive folder {}: {}", folder.id, e);
        }
    }

    let _ = session.logout().await;
    sync_result.map(|_| ()).map_err(|e| format!("Folder sync failed: {}", e))
}

#[tauri::command]
pub async fn sync_all_accounts(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<(), String> {
    let accounts: Vec<Account> = {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare("SELECT id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl') as smtp_security, auth_type, COALESCE(signature_html, '') as signature_html, COALESCE(signature_text, '') as signature_text, COALESCE(sync_interval_minutes, 0) as sync_interval_minutes, COALESCE(signature_on_compose, 1) as signature_on_compose, COALESCE(signature_on_reply, 1) as signature_on_reply, COALESCE(load_external_images, 'always') as load_external_images, created_at, updated_at FROM accounts ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_map([], |row| {
                Ok(Account {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    display_name: row.get(2)?,
                    provider: row.get(3)?,
                    color: row.get(4)?,
                    imap_host: row.get(5)?,
                    imap_port: row.get(6)?,
                    smtp_host: row.get(7)?,
                    smtp_port: row.get(8)?,
                    smtp_security: row.get(9)?,
                    auth_type: row.get(10)?,
                    signature_html: row.get(11)?,
                    signature_text: row.get(12)?,
                    sync_interval_minutes: row.get(13)?,
                    signature_on_compose: row.get(14)?,
                    signature_on_reply: row.get(15)?,
                    load_external_images: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        result
    };

    // Spawn each account sync as an independent task for parallel execution
    let app_clone = app.clone();
    for account in accounts {
        let app_handle = app_clone.clone();
        let account_id_for_registry = account.id.clone();
        crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
            let auth_type = account.auth_type.clone();
            let provider = account.provider.clone();
            let account_id = account.id.clone();
            match credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                Ok(cred) => {
                    do_sync_account(app_handle, account, account_id, cred, auth_type).await;
                }
                Err(e) => log::warn!("Skipping account {}: {}", account.email, e),
            }
        });
    }

    Ok(())
}

/// Per-account backfill lock — prevents concurrent backfills of the same account
static BACKFILLING_ACCOUNTS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

#[tauri::command]
pub async fn backfill_bodies(
    app: AppHandle,
    db: State<'_, Database>,
    account_id: String,
) -> Result<(), String> {
    // API accounts (Gmail/Outlook) don't use IMAP backfill — bodies are fetched on-demand via API
    {
        let conn = db.lock_db();
        let is_api: bool = conn.query_row(
            "SELECT ((provider = 'google' OR provider = 'microsoft') AND auth_type = 'oauth') FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| row.get(0),
        ).unwrap_or(false);
        if is_api {
            return Ok(());
        }
    }

    // Reset previously failed mails so they are retried
    {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE mails SET body_text = '' WHERE body_text = '[fetch-failed]' AND account_id = ?1",
            rusqlite::params![account_id],
        );
    }

    let mails_needing_body: Vec<(String, u32, String)> = {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.uid, f.path FROM mails m \
                 JOIN folders f ON m.folder_id = f.id \
                 WHERE m.body_text = '' AND m.uid IS NOT NULL AND m.account_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![account_id], |row| {
            Ok((
                row.get::<_, String>(0)?, // mail_id
                row.get::<_, u32>(1)?,    // uid
                row.get::<_, String>(2)?, // folder_path
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
        rows
    };

    if mails_needing_body.is_empty() {
        return Ok(());
    }

    let mut folder_groups: std::collections::HashMap<String, Vec<(String, u32)>> =
        std::collections::HashMap::new();
    for (mail_id, uid, folder_path) in &mails_needing_body {
        folder_groups
            .entry(folder_path.clone())
            .or_default()
            .push((mail_id.clone(), *uid));
    }

    let account: Account = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl') as smtp_security, auth_type, COALESCE(signature_html, '') as signature_html, COALESCE(signature_text, '') as signature_text, COALESCE(sync_interval_minutes, 0) as sync_interval_minutes, COALESCE(signature_on_compose, 1) as signature_on_compose, COALESCE(signature_on_reply, 1) as signature_on_reply, COALESCE(load_external_images, 'always') as load_external_images, created_at, updated_at FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| {
                Ok(Account {
                    id: row.get(0)?,
                    email: row.get(1)?,
                    display_name: row.get(2)?,
                    provider: row.get(3)?,
                    color: row.get(4)?,
                    imap_host: row.get(5)?,
                    imap_port: row.get(6)?,
                    smtp_host: row.get(7)?,
                    smtp_port: row.get(8)?,
                    smtp_security: row.get(9)?,
                    auth_type: row.get(10)?,
                    signature_html: row.get(11)?,
                    signature_text: row.get(12)?,
                    sync_interval_minutes: row.get(13)?,
                    signature_on_compose: row.get(14)?,
                    signature_on_reply: row.get(15)?,
                    load_external_images: row.get(16)?,
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )
        .map_err(|e| format!("Account not found: {}", e))?
    };

    let auth_type = account.auth_type.clone();
    let provider = account.provider.clone();
    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let app_clone = app.clone();
    let account_id_for_registry = account_id.clone();
    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
        // Atomic check-and-claim of the per-account backfill lock.
        {
            let mut backfilling = BACKFILLING_ACCOUNTS.lock().unwrap_or_else(|e| e.into_inner());
            if backfilling.contains(&account_id) {
                return;
            }
            backfilling.insert(account_id.clone());
        }
        // Drop guard releases the lock on every exit path (success, error, abort).
        let _backfill_guard = crate::cleanup_guard::SetGuard::new(&BACKFILLING_ACCOUNTS, account_id.clone());

        let result = do_backfill(&app_clone, &account, &credential, &auth_type, folder_groups).await;

        if let Err(e) = result {
            log::error!("Backfill error for {}: {}", account_id, e);
        }

        let _ = app_clone.emit("backfill-done", serde_json::json!({
            "account_id": account_id,
        }));
    });

    Ok(())
}

async fn do_backfill(
    app: &AppHandle,
    account: &Account,
    credential: &str,
    auth_type: &str,
    folder_groups: std::collections::HashMap<String, Vec<(String, u32)>>,
) -> anyhow::Result<()> {
    let pool = app.state::<ImapPool>();
    // Guarded variant: in_use slot auto-releases on cancellation. The guard
    // remains valid across the inner reconnect-on-error loop because it
    // checks current in_use state at drop time rather than tracking claims.
    let (mut session, _in_use_guard) = pool
        .get_session_guarded(&account.id, &account.imap_host, account.imap_port as u16, &account.email, credential, auth_type)
        .await?;

    let db = app.state::<Database>();

    let total: usize = folder_groups.values().map(|v| v.len()).sum();
    let mut cumulative: u32 = 0;

    let _ = app.emit("backfill-progress", serde_json::json!({
        "account_id": account.id,
        "processed": 0,
        "total": total,
    }));

    let mut session_ok = true;
    let mut consecutive_folder_errors: u32 = 0;
    for (folder_path, mails) in &folder_groups {
        match imap::backfill_folder_bodies(&mut session, folder_path, mails, &db, app, Some((&account.id, cumulative, total))).await {
            Ok(count) => {
                cumulative += count;
                consecutive_folder_errors = 0;
                log::info!("Backfilled {} bodies in {}", count, folder_path);
            }
            Err(e) => {
                log::error!("Backfill failed for folder {}: {}", folder_path, e);
                consecutive_folder_errors += 1;
                // Session may be broken — reconnect for next folder
                let _ = session.logout().await;
                pool.release(&account.id);
                match pool.get_session(&account.id, &account.imap_host, account.imap_port as u16, &account.email, credential, auth_type).await {
                    Ok(new_session) => session = new_session,
                    Err(e2) => {
                        log::error!("Failed to reconnect IMAP for backfill: {}", e2);
                        session_ok = false;
                        break;
                    }
                }
                // Give up after 3 consecutive folder errors (server likely has issues)
                if consecutive_folder_errors >= 3 {
                    log::error!("Backfill: 3 consecutive folder errors, aborting");
                    break;
                }
            }
        }
    }

    if session_ok {
        pool.return_session(&account.id, session).await;
    } else {
        // Session already released above
    }
    Ok(())
}

/// Sanitize user input for FTS5 MATCH: quote each word to prevent syntax errors
pub fn sanitize_fts_query(query: &str) -> String {
    let tokens: Vec<String> = query
        .split_whitespace()
        .map(|word| {
            let clean: String = word.chars().filter(|c| *c != '"').collect();
            if clean.is_empty() {
                return String::new();
            }
            format!("\"{}\"", clean)
        })
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    tokens.join(" ")
}

#[tauri::command]
pub fn search_mails(
    db: State<'_, Database>,
    query: String,
    account_id: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let safe_query = sanitize_fts_query(&query);
    if safe_query.is_empty() {
        return Ok(Vec::new());
    }

    let conn = db.lock_db();

    // FTS5 search — use snippet() for contextual excerpts with highlight markers
    let sql = if account_id.is_some() {
        "SELECT m.id, m.subject,
                COALESCE(NULLIF(snippet(mails_fts, 4, '[[hl]]', '[[/hl]]', '…', 48), ''), NULLIF(m.snippet, ''), NULLIF(snippet(mails_fts, 1, '[[hl]]', '[[/hl]]', '…', 48), ''), SUBSTR(m.body_text, 1, 300)) as snippet,
                m.from_name, m.from_email, m.date, m.folder_id,
                COALESCE(f.name, '') as folder_name,
                m.is_read, m.has_attachments, rank
         FROM mails_fts fts
         JOIN mails m ON m.id = fts.mail_id
         LEFT JOIN folders f ON f.id = m.folder_id
         WHERE mails_fts MATCH ?1 AND m.account_id = ?2
         ORDER BY m.date DESC
         LIMIT 50"
    } else {
        "SELECT m.id, m.subject,
                COALESCE(NULLIF(snippet(mails_fts, 4, '[[hl]]', '[[/hl]]', '…', 48), ''), NULLIF(m.snippet, ''), NULLIF(snippet(mails_fts, 1, '[[hl]]', '[[/hl]]', '…', 48), ''), SUBSTR(m.body_text, 1, 300)) as snippet,
                m.from_name, m.from_email, m.date, m.folder_id,
                COALESCE(f.name, '') as folder_name,
                m.is_read, m.has_attachments, rank
         FROM mails_fts fts
         JOIN mails m ON m.id = fts.mail_id
         LEFT JOIN folders f ON f.id = m.folder_id
         WHERE mails_fts MATCH ?1
         ORDER BY m.date DESC
         LIMIT 50"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<SearchResult> {
        Ok(SearchResult {
            mail_id: row.get(0)?,
            subject: row.get(1)?,
            snippet: row.get(2)?,
            from_name: row.get(3)?,
            from_email: row.get(4)?,
            date: row.get(5)?,
            folder_id: row.get(6)?,
            folder_name: row.get(7)?,
            is_read: row.get::<_, i32>(8)? != 0,
            has_attachments: row.get::<_, i32>(9)? != 0,
            rank: row.get(10)?,
        })
    };

    let results = if let Some(ref aid) = account_id {
        stmt.query_map(rusqlite::params![safe_query, aid], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(rusqlite::params![safe_query], map_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    Ok(results)
}

/// Force a full re-sync for an account by resetting UIDNEXT/UIDVALIDITY,
/// clearing all local mails, and triggering a fresh sync.
#[tauri::command]
pub async fn force_resync_account(
    app: AppHandle,
    db: State<'_, Database>,
    account_id: String,
) -> Result<(), String> {
    {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE folders SET uid_validity = 0, uid_next = 0 WHERE account_id = ?1",
            rusqlite::params![account_id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM mails WHERE account_id = ?1",
            rusqlite::params![account_id],
        ).map_err(|e| e.to_string())?;
        let _ = conn.execute(
            "DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)",
            [],
        );
        let _ = conn.execute(
            "UPDATE accounts SET gmail_history_id = '' WHERE id = ?1",
            rusqlite::params![account_id],
        );
        let _ = conn.execute(
            "UPDATE folders SET delta_link = '' WHERE account_id = ?1",
            rusqlite::params![account_id],
        );
    }

    log::info!("Force resync: cleared all data for account {}", account_id);

    // Trigger a normal sync which will now do a full initial sync
    sync_account(app, db, account_id, None).await
}
