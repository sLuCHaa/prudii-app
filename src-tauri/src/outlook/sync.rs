//! Microsoft Graph folder sync, initial sync, and incremental delta sync.

use crate::db::Database;
use crate::outlook::api::{GraphMessage, OutlookClient};
use crate::models::{Folder, SyncProgress};
use anyhow::{bail, Result};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Per-folder lock to prevent concurrent delta-link acquisition tasks.
static DELTA_LINK_TASKS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// Sync folders from Graph API into the folders table.
pub async fn sync_folders(client: &OutlookClient, account_id: &str, db: &Database) -> Result<Vec<Folder>> {
    let graph_folders = client.list_folders().await?;

    let conn = db.lock_db();
    let mut folders = Vec::new();

    for gf in &graph_folders {
        let folder_type = gf.folder_type();

        let total = gf.total_item_count.unwrap_or(0);
        let unread = gf.unread_item_count.unwrap_or(0);

        // Upsert folder — path = graph folder ID
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE account_id = ?1 AND path = ?2",
                rusqlite::params![account_id, gf.id],
                |row| row.get(0),
            )
            .ok();

        let folder_id = if let Some(id) = existing {
            conn.execute(
                "UPDATE folders SET name = ?1, folder_type = ?2, total_count = ?3, unread_count = ?4 WHERE id = ?5",
                rusqlite::params![gf.display_name, folder_type, total, unread, id],
            )?;
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO folders (id, account_id, name, folder_type, path, total_count, unread_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![id, account_id, gf.display_name, folder_type, gf.id, total, unread],
            )?;
            id
        };

        folders.push(Folder {
            id: folder_id,
            account_id: account_id.to_string(),
            name: gf.display_name.clone(),
            folder_type: folder_type.to_string(),
            path: gf.id.clone(),
            unread_count: unread,
            total_count: total,
            is_local: false,
            color: String::new(),
        });
    }

    Ok(folders)
}

/// Initial sync: list all messages in a folder, insert metadata into DB.
pub async fn initial_sync_folder(
    client: &OutlookClient,
    folder: &Folder,
    account_id: &str,
    db: &Database,
    app: Option<(&AppHandle, u32, u32, u32)>,
) -> Result<u32> {
    // 1. Paginate through all messages in the folder with adaptive pacing.
    // Uses @odata.nextLink for pagination (Microsoft's recommended approach).
    // Graph API supports up to $top=1000; 250 is a safe sweet spot.
    // Starts at 100ms delay. On retry (429): +50% (max 5s). On clean: halve (min 50ms).
    let mut all_messages: Vec<GraphMessage> = Vec::new();
    let page_size: u32 = 250;
    let mut page_errors: u32 = 0;
    let mut page_delay_ms: u64 = 100;
    let mut next_link: Option<String> = None;
    let mut page_num: u32 = 0;

    loop {
        if page_num > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(page_delay_ms)).await;
        }

        let (resp, had_retry) = match client.list_messages(&folder.path, next_link.as_deref(), page_size).await {
            Ok(r) => r,
            Err(e) => {
                page_errors += 1;
                page_delay_ms = (page_delay_ms * 2).min(5000); // slow down on errors
                log::warn!("Outlook list_messages page {} failed (error {}): {}", page_num, page_errors, e);
                if page_errors >= 5 {
                    log::error!("Outlook: too many page errors ({}), stopping folder sync for '{}'", page_errors, folder.name);
                    break;
                }
                // On error without a nextLink we can't continue
                if next_link.is_none() {
                    break;
                }
                continue;
            }
        };

        if had_retry {
            page_delay_ms = (page_delay_ms * 3 / 2).min(5000); // +50%, max 5s
            log::info!("Outlook adaptive: retry detected, page delay → {}ms", page_delay_ms);
        } else {
            page_delay_ms = (page_delay_ms / 2).max(50); // halve on clean, min 50ms
        }

        all_messages.extend(resp.value);
        page_num += 1;

        // Emit pagination progress so the UI shows activity.
        // Use "X of Y messages" format so the frontend progress bar regex picks it up.
        if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
            let _ = app_handle.emit("sync-progress", &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: Some(folder.name.clone()),
                folder_index: folder_idx,
                folder_count,
                new_mails: base_new,
                message: if folder.total_count > 0 {
                    format!("Fetching {} — {} of {} messages...", folder.name, all_messages.len(), folder.total_count)
                } else {
                    format!("Fetching {} — {} of {} messages...", folder.name, all_messages.len(), all_messages.len())
                },
            });
        }

        match resp.next_link {
            Some(link) if !link.is_empty() => next_link = Some(link),
            _ => break,
        }
    }

    // Even for empty folders or fully-synced folders, we need to store a delta_link
    // so that subsequent syncs can skip Phase 2 entirely and use incremental sync.
    if all_messages.is_empty() {
        store_delta_link_with_retry(client, folder, db).await;
        return Ok(0);
    }

    // 2. Filter out already-known message IDs
    let existing_ids: HashSet<String> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare(
            "SELECT message_id FROM mails WHERE account_id = ?1 AND folder_id = ?2 AND message_id IS NOT NULL"
        )?;
        let result = stmt.query_map(rusqlite::params![account_id, folder.id], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok()).collect();
        result
    };

    let new_messages: Vec<&GraphMessage> = all_messages.iter()
        .filter(|m| !existing_ids.contains(&m.id))
        .collect();

    if new_messages.is_empty() {
        // All messages already in DB — store delta_link so future syncs skip this folder
        log::info!("Outlook initial_sync_folder '{}': {} total, 0 new", folder.name, all_messages.len());
        // Small delay to avoid rate limiting after heavy pagination
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        store_delta_link_with_retry(client, folder, db).await;
        return Ok(0);
    }

    log::info!("Outlook initial_sync_folder '{}': {} total, {} new", folder.name, all_messages.len(), new_messages.len());

    // 3. Insert messages into DB in batches wrapped in transactions.
    // This ensures the frontend always sees a consistent snapshot (all or none of a batch),
    // preventing the "only 1 of N emails visible" bug when list_mails runs mid-sync.
    let mut new_count: u32 = 0;
    let batch_size = 50;

    for (batch_idx, batch) in new_messages.chunks(batch_size).enumerate() {
        let conn = db.lock_db();
        let tx = conn.unchecked_transaction().map_err(|e| anyhow::anyhow!(e))?;
        for msg in batch {
            if insert_message_from_graph(&tx, msg, folder, account_id)? {
                new_count += 1;
            }
        }
        tx.commit().map_err(|e| anyhow::anyhow!(e))?;
        drop(conn);

        if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
            let _ = app_handle.emit("sync-progress", &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: Some(folder.name.clone()),
                folder_index: folder_idx,
                folder_count,
                new_mails: base_new + new_count,
                message: format!("Syncing {} — {} of {} messages...", folder.name, (batch_idx + 1) * batch_size, new_messages.len()),
            });
        }
    }

    // Final progress emission for the tail (< 50 messages after last modulo-50 update)
    if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
        let _ = app_handle.emit("sync-progress", &SyncProgress {
            account_id: account_id.to_string(),
            status: "syncing_mails".into(),
            folder_name: Some(folder.name.clone()),
            folder_index: folder_idx,
            folder_count,
            new_mails: base_new + new_count,
            message: format!("Syncing {} — {} of {} messages...", folder.name, new_messages.len(), new_messages.len()),
        });
    }

    // Apply mail rules to newly synced messages
    if new_count > 0 {
        let conn = db.lock_db();
        let mut newly_inserted: Vec<String> = Vec::new();
        for msg in &new_messages {
            if let Ok(local_id) = conn.query_row(
                "SELECT id FROM mails WHERE account_id = ?1 AND folder_id = ?2 AND message_id = ?3",
                rusqlite::params![account_id, folder.id, msg.id],
                |row| row.get::<_, String>(0),
            ) {
                newly_inserted.push(local_id);
            }
        }
        drop(conn);
        if !newly_inserted.is_empty() {
            crate::rules::apply_rules_to_mails(account_id, &newly_inserted, db);
        }
    }

    // 4. Get initial delta link for future incremental syncs
    if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
        let _ = app_handle.emit("sync-progress", &SyncProgress {
            account_id: account_id.to_string(),
            status: "syncing_mails".into(),
            folder_name: Some(folder.name.clone()),
            folder_index: folder_idx,
            folder_count,
            new_mails: base_new + new_count,
            message: format!("Finalizing {}...", folder.name),
        });
    }
    store_delta_link_with_retry(client, folder, db).await;

    Ok(new_count)
}

/// Get the initial delta link using $deltaToken=latest.
/// This skips all current data and returns a baseline for future incremental syncs.
/// For small folders, the API returns a deltaLink on page 0 or 1.
/// Large folders (10k+ messages) paginate endlessly — bail after 3 pages to avoid blocking.
async fn get_initial_delta_link(client: &OutlookClient, folder_id: &str) -> Result<String> {
    // Must include $select — it gets baked into the resulting deltaLink, so future
    // incremental syncs will only receive these fields. Without it, new messages
    // arrive with empty subject/from/to.
    let select = "subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,hasAttachments,internetMessageId,conversationId,bodyPreview,importance,parentFolderId,internetMessageHeaders";
    let mut url = format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages/delta?$deltaToken=latest&$select={}",
        folder_id, select
    );
    for _page in 0..3 {
        let resp = client.get_delta(folder_id, Some(&url)).await?;
        if let Some(delta_link) = resp.delta_link {
            return Ok(delta_link);
        }
        if let Some(next) = resp.next_link {
            url = next;
        } else {
            break;
        }
    }
    bail!("$deltaToken=latest did not return deltaLink within 3 pages (large folder)")
}

/// Store delta_link with retry. If the first attempt fails (e.g. rate limiting after heavy
/// pagination), wait 3 seconds and retry once. Logs errors clearly instead of swallowing them.
async fn store_delta_link_with_retry(client: &OutlookClient, folder: &Folder, db: &Database) {
    match get_initial_delta_link(client, &folder.path).await {
        Ok(delta_link) => {
            let conn = db.lock_db();
            let _ = conn.execute(
                "UPDATE folders SET delta_link = ?1 WHERE id = ?2",
                rusqlite::params![delta_link, folder.id],
            );
            log::info!("Stored delta_link for folder '{}'", folder.name);
        }
        Err(e) => {
            log::warn!("Failed to get delta_link for '{}' (attempt 1): {} — retrying in 3s", folder.name, e);
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            match get_initial_delta_link(client, &folder.path).await {
                Ok(delta_link) => {
                    let conn = db.lock_db();
                    let _ = conn.execute(
                        "UPDATE folders SET delta_link = ?1 WHERE id = ?2",
                        rusqlite::params![delta_link, folder.id],
                    );
                    log::info!("Stored delta_link for folder '{}' (retry succeeded)", folder.name);
                }
                Err(e2) => {
                    log::error!("Failed to get delta_link for '{}' (attempt 2): {} — folder will be re-synced next time", folder.name, e2);
                }
            }
        }
    }
}

/// Incremental sync via Delta API for a single folder.
/// Returns the number of changes processed.
pub async fn incremental_sync_folder(
    client: &OutlookClient,
    folder: &Folder,
    account_id: &str,
    db: &Database,
) -> Result<u32> {
    let delta_link: String = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COALESCE(delta_link, '') FROM folders WHERE id = ?1",
            rusqlite::params![folder.id],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };

    if delta_link.is_empty() {
        bail!("no_delta_link");
    }

    // Reject the known broken pattern: delta_links acquired with $select=id
    // cause messages to arrive with empty subject/from/to. Clear and bail to
    // trigger full re-sync. Note: delta_links are opaque tokens, so we can only
    // match the specific broken pattern, not check for field name presence.
    if delta_link.contains("$select=id") || delta_link.contains("select=id&") {
        log::warn!("Outlook: delta_link for folder '{}' has broken $select=id, clearing", folder.name);
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE folders SET delta_link = '' WHERE id = ?1",
            rusqlite::params![folder.id],
        );
        bail!("no_delta_link");
    }

    let mut changes: u32 = 0;
    let mut new_mail_ids: Vec<String> = Vec::new();
    let mut current_link: Option<String> = Some(delta_link);
    let mut new_delta_link: Option<String> = None;

    loop {
        let resp = match client.get_delta(&folder.path, current_link.as_deref()).await {
            Ok(r) => r,
            Err(e) if e.to_string().contains("delta_expired") => {
                // Delta link expired — clear it to trigger full re-sync on next run
                let conn = db.lock_db();
                let _ = conn.execute(
                    "UPDATE folders SET delta_link = '' WHERE id = ?1",
                    rusqlite::params![folder.id],
                );
                bail!("delta_expired");
            }
            Err(e) => return Err(e),
        };

        for msg in &resp.value {
            if msg.removed.is_some() {
                let conn = db.lock_db();
                let deleted_count = conn.execute(
                    "DELETE FROM mails WHERE account_id = ?1 AND message_id = ?2",
                    rusqlite::params![account_id, msg.id],
                ).unwrap_or(0);
                if deleted_count > 0 {
                    let _ = conn.execute(
                        "DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)",
                        [],
                    );
                    changes += 1;
                }
                continue;
            }

            let conn = db.lock_db();
            let existing: Option<String> = conn.query_row(
                "SELECT id FROM mails WHERE account_id = ?1 AND message_id = ?2 AND folder_id = ?3",
                rusqlite::params![account_id, msg.id, folder.id],
                |row| row.get(0),
            ).ok();

            if let Some(local_id) = existing {
                // Update read/flag status + backfill empty metadata
                let is_read = msg.is_read.unwrap_or(false);
                let is_starred = msg.flag.as_ref()
                    .and_then(|f| f.flag_status.as_deref())
                    .map(|s| s == "flagged")
                    .unwrap_or(false);

                // Extract subject with header fallback (same logic as insert_message_from_graph)
                let subject = msg.subject.as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        msg.internet_message_headers.as_ref()
                            .and_then(|hdrs| hdrs.iter().find(|h| h.name.eq_ignore_ascii_case("Subject")))
                            .map(|h| h.value.as_str())
                            .filter(|s| !s.trim().is_empty())
                    })
                    .unwrap_or("");

                let (from_name, from_email) = msg.from.as_ref()
                    .map(|r| {
                        let name = r.email_address.name.as_deref().unwrap_or("");
                        let addr = r.email_address.address.as_deref().unwrap_or("");
                        (name.to_string(), addr.to_string())
                    })
                    .unwrap_or_default();

                let to_json = recipients_to_json(msg.to_recipients.as_deref().unwrap_or(&[]));
                let cc_json = recipients_to_json(msg.cc_recipients.as_deref().unwrap_or(&[]));

                let _ = conn.execute(
                    "UPDATE mails SET is_read = ?1, is_starred = ?2, \
                     subject = CASE WHEN (subject = '' OR subject = '(No Subject)') AND ?3 != '' THEN ?3 ELSE subject END, \
                     from_name = CASE WHEN from_name = '' AND ?4 != '' THEN ?4 ELSE from_name END, \
                     from_email = CASE WHEN from_email = '' AND ?5 != '' THEN ?5 ELSE from_email END, \
                     to_json = CASE WHEN to_json = '[]' AND ?6 != '[]' THEN ?6 ELSE to_json END, \
                     cc_json = CASE WHEN cc_json = '[]' AND ?7 != '[]' THEN ?7 ELSE cc_json END \
                     WHERE id = ?8",
                    rusqlite::params![is_read as i32, is_starred as i32, subject, from_name, from_email, to_json, cc_json, local_id],
                );
                changes += 1;
            } else {
                drop(conn);
                let conn = db.lock_db();
                if insert_message_from_graph(&conn, msg, folder, account_id)? {
                    // Track new mail ID for rule engine
                    if let Ok(local_id) = conn.query_row(
                        "SELECT id FROM mails WHERE account_id = ?1 AND folder_id = ?2 AND message_id = ?3",
                        rusqlite::params![account_id, folder.id, msg.id],
                        |row| row.get::<_, String>(0),
                    ) {
                        new_mail_ids.push(local_id);
                    }
                    changes += 1;
                }
            }
        }

        if let Some(dl) = resp.delta_link {
            new_delta_link = Some(dl);
            break;
        }

        match resp.next_link {
            Some(next) => {
                current_link = Some(next);
                // Throttle between delta pages
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            None => break,
        }
    }

    if !new_mail_ids.is_empty() {
        crate::rules::apply_rules_to_mails(account_id, &new_mail_ids, db);
    }

    if let Some(dl) = new_delta_link {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE folders SET delta_link = ?1 WHERE id = ?2",
            rusqlite::params![dl, folder.id],
        );
    }

    Ok(changes)
}

/// Insert a single Graph message into the DB.
fn insert_message_from_graph(
    conn: &rusqlite::Connection,
    msg: &GraphMessage,
    folder: &Folder,
    account_id: &str,
) -> Result<bool> {
    // Primary: msg.subject. Fallback: Subject from internetMessageHeaders (raw RFC headers).
    // Graph API sometimes returns subject=null for S/MIME, NDRs, or system messages
    // even though the raw header contains the subject.
    let subject = msg.subject.as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            msg.internet_message_headers.as_ref()
                .and_then(|hdrs| hdrs.iter().find(|h| h.name.eq_ignore_ascii_case("Subject")))
                .map(|h| h.value.as_str())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("(No Subject)");

    let (from_name, from_email) = msg.from.as_ref()
        .map(|r| {
            let name = r.email_address.name.as_deref().unwrap_or("");
            let addr = r.email_address.address.as_deref().unwrap_or("");
            (name.to_string(), addr.to_string())
        })
        .unwrap_or_default();

    let to_json = recipients_to_json(msg.to_recipients.as_deref().unwrap_or(&[]));
    let cc_json = recipients_to_json(msg.cc_recipients.as_deref().unwrap_or(&[]));

    let is_read = msg.is_read.unwrap_or(false);
    let is_starred = msg.flag.as_ref()
        .and_then(|f| f.flag_status.as_deref())
        .map(|s| s == "flagged")
        .unwrap_or(false);

    let has_attachments = msg.has_attachments.unwrap_or(false);

    let list_unsubscribe = msg.internet_message_headers.as_ref()
        .and_then(|h| h.iter().find(|hdr| hdr.name.eq_ignore_ascii_case("List-Unsubscribe")))
        .map(|h| h.value.clone()).unwrap_or_default();

    let reply_to_json = msg.internet_message_headers.as_ref()
        .and_then(|h| h.iter().find(|hdr| hdr.name.eq_ignore_ascii_case("Reply-To")))
        .map(|h| {
            // Reply-To header may contain comma-separated addresses like "Name <email>, ..."
            // Parse using the same pattern as Gmail sync
            let raw = &h.value;
            if raw.trim().is_empty() {
                "[]".to_string()
            } else {
                let mut addrs = Vec::new();
                for addr in raw.split(',') {
                    let addr = addr.trim();
                    if addr.is_empty() { continue; }
                    let (name, email) = if let Some(lt) = addr.find('<') {
                        if let Some(gt) = addr.find('>') {
                            (addr[..lt].trim().trim_matches('"').to_string(), addr[lt+1..gt].trim().to_string())
                        } else {
                            (String::new(), addr.to_string())
                        }
                    } else {
                        (String::new(), addr.to_string())
                    };
                    if !email.is_empty() {
                        addrs.push(serde_json::json!({"name": name, "email": email}));
                    }
                }
                serde_json::to_string(&addrs).unwrap_or_else(|_| "[]".to_string())
            }
        })
        .unwrap_or_else(|| "[]".to_string());

    // Parse date — Graph returns ISO 8601 (e.g. "2024-01-15T10:30:00Z").
    // Re-format as RFC3339 UTC (with `T` and `Z`) so the frontend's parseISO treats it
    // as UTC and renders in the user's local timezone. A bare "YYYY-MM-DD HH:MM:SS"
    // string is interpreted as local time by parseISO and ends up showing UTC values
    // verbatim.
    let date = msg.received_date_time.as_deref()
        .and_then(|dt| {
            chrono::DateTime::parse_from_rfc3339(dt)
                .ok()
                .map(|d| d.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
        })
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());

    let snippet = msg.body_preview.as_deref().unwrap_or("");
    let mail_id = uuid::Uuid::new_v4().to_string();
    let thread_id = msg.conversation_id.as_deref();
    let in_reply_to = msg.in_reply_to.as_deref();
    let internet_msg_id = msg.internet_message_id.as_deref();

    // Check for duplicate before inserting (partial unique index ON CONFLICT may not always fire)
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mails WHERE account_id = ?1 AND folder_id = ?2 AND message_id = ?3)",
        rusqlite::params![account_id, folder.id, msg.id],
        |row| row.get(0),
    ).unwrap_or(false);

    if exists {
        return Ok(false);
    }

    let result = conn.execute(
        "INSERT OR IGNORE INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, has_attachments, thread_id, in_reply_to, \"references\", list_unsubscribe, reply_to_json)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, '', '', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        rusqlite::params![
            mail_id, account_id, folder.id, msg.id,
            subject, from_name, from_email, to_json, cc_json,
            date, snippet, is_read as i32, is_starred as i32,
            has_attachments as i32, thread_id, in_reply_to, internet_msg_id,
            list_unsubscribe, reply_to_json,
        ],
    );

    match result {
        Ok(rows) if rows > 0 => {
            let _ = conn.execute(
                "INSERT INTO mails_fts (mail_id, subject, from_email, from_name, body_text) VALUES (?1, ?2, ?3, ?4, '')",
                rusqlite::params![mail_id, subject, from_email, from_name],
            );
            Ok(true)
        }
        Ok(_) => Ok(false), // Duplicate (caught by INSERT OR IGNORE)
        Err(e) => {
            if e.to_string().contains("UNIQUE") {
                Ok(false)
            } else {
                Err(e.into())
            }
        }
    }
}

/// Background task: paginate through all delta pages to acquire a delta_link for large folders
/// where `$deltaToken=latest` fails (e.g. Archive with 10k+ messages).
/// Ignores message data — only cares about the final delta_link.
pub async fn acquire_delta_link_full(
    client: &OutlookClient,
    folder_id: &str,
    folder_name: &str,
    db_folder_id: &str,
    db: &Database,
) {
    // Acquire per-folder lock
    {
        let mut tasks = DELTA_LINK_TASKS.lock().unwrap_or_else(|e| e.into_inner());
        if tasks.contains(db_folder_id) {
            log::info!("Background delta-link already running for '{}'", folder_name);
            return;
        }
        tasks.insert(db_folder_id.to_string());
    }

    log::info!("Background: acquiring delta_link for '{}' (full pagination)...", folder_name);

    // Must use the FULL field list here — the $select gets baked into the resulting
    // deltaLink, so future incremental syncs will only receive these fields.
    // Using just "id" caused new messages to arrive with empty subject/from/to.
    let select = "subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,hasAttachments,internetMessageId,conversationId,bodyPreview,importance,parentFolderId,internetMessageHeaders";
    let mut url = format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages/delta?$select={}&$top=250",
        folder_id, select
    );
    let mut page_num: u32 = 0;
    let mut delay_ms: u64 = 100;
    let max_pages: u32 = 1500;
    let mut errors: u32 = 0;

    loop {
        if page_num > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        if page_num >= max_pages {
            log::warn!("Background delta-link for '{}': hit {} page limit, aborting", folder_name, max_pages);
            break;
        }

        // Every 100 pages, check if delta_link was already set by another process
        if page_num > 0 && page_num % 100 == 0 {
            let existing: String = {
                let conn = db.lock_db();
                conn.query_row(
                    "SELECT COALESCE(delta_link, '') FROM folders WHERE id = ?1",
                    rusqlite::params![db_folder_id],
                    |row| row.get(0),
                ).unwrap_or_default()
            };
            if !existing.is_empty() {
                log::info!("Background delta-link for '{}': already set by another process after {} pages", folder_name, page_num);
                break;
            }
        }

        if page_num > 0 && page_num % 50 == 0 {
            log::info!("Background delta-link for '{}': page {} (delay={}ms)", folder_name, page_num, delay_ms);
        }

        let resp = match client.get_delta(folder_id, Some(&url)).await {
            Ok(r) => {
                // Clean page — reduce delay
                delay_ms = (delay_ms / 2).max(50);
                errors = 0;
                r
            }
            Err(e) => {
                errors += 1;
                delay_ms = (delay_ms * 3 / 2).min(5000);
                log::warn!("Background delta-link for '{}' page {} error ({}): {}", folder_name, page_num, errors, e);
                if errors >= 5 {
                    log::error!("Background delta-link for '{}': too many errors, aborting", folder_name);
                    break;
                }
                continue;
            }
        };

        page_num += 1;

        if let Some(delta_link) = resp.delta_link {
            let conn = db.lock_db();
            let _ = conn.execute(
                "UPDATE folders SET delta_link = ?1 WHERE id = ?2",
                rusqlite::params![delta_link, db_folder_id],
            );
            log::info!("Background: delta_link acquired for '{}' after {} pages", folder_name, page_num);
            break;
        }

        match resp.next_link {
            Some(next) if !next.is_empty() => url = next,
            _ => {
                log::warn!("Background delta-link for '{}': no nextLink or deltaLink after {} pages", folder_name, page_num);
                break;
            }
        }
    }

    // Release per-folder lock
    {
        let mut tasks = DELTA_LINK_TASKS.lock().unwrap_or_else(|e| e.into_inner());
        tasks.remove(db_folder_id);
    }
}

/// Convert Graph recipients to JSON array of {name, email}.
/// Public wrapper for use in body-fetch backfill.
pub fn recipients_to_json_pub(recipients: &[crate::outlook::api::GraphRecipient]) -> String {
    recipients_to_json(recipients)
}

/// Convert Graph recipients to JSON array of {name, email}.
fn recipients_to_json(recipients: &[crate::outlook::api::GraphRecipient]) -> String {
    if recipients.is_empty() {
        return "[]".to_string();
    }

    let addrs: Vec<serde_json::Value> = recipients.iter().map(|r| {
        serde_json::json!({
            "name": r.email_address.name.as_deref().unwrap_or(""),
            "email": r.email_address.address.as_deref().unwrap_or(""),
        })
    }).collect();

    serde_json::to_string(&addrs).unwrap_or_else(|_| "[]".to_string())
}
