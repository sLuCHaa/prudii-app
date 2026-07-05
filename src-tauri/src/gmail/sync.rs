//! Gmail label sync, initial sync, and incremental sync via History API.

use crate::db::Database;
use crate::gmail::api::{self, GmailClient, GmailMessage};
use crate::models::{Folder, SyncProgress};
use anyhow::Result;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

/// Map Gmail system label IDs to our folder_type.
fn label_to_folder_type(label_id: &str) -> Option<&'static str> {
    match label_id {
        "INBOX" => Some("inbox"),
        "SENT" => Some("sent"),
        "DRAFT" => Some("drafts"),
        "TRASH" => Some("trash"),
        "SPAM" => Some("spam"),
        _ => None,
    }
}

/// Labels we skip — virtual labels that don't map to real folders.
fn should_skip_label(label_id: &str) -> bool {
    matches!(label_id,
        "STARRED" | "IMPORTANT" | "UNREAD"
        | "CATEGORY_PERSONAL" | "CATEGORY_SOCIAL" | "CATEGORY_PROMOTIONS"
        | "CATEGORY_UPDATES" | "CATEGORY_FORUMS"
        | "CHAT"
    )
}

/// Sync Gmail labels into the folders table.
pub async fn sync_labels(client: &GmailClient, account_id: &str, db: &Database) -> Result<Vec<Folder>> {
    let labels = client.list_labels().await?;

    let conn = db.lock_db();
    let mut folders = Vec::new();

    for label in &labels {
        if should_skip_label(&label.id) {
            continue;
        }

        let folder_type = label_to_folder_type(&label.id)
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                // System labels we didn't map → skip
                if label.label_type.as_deref() == Some("system") {
                    return String::new();
                }
                "custom".to_string()
            });

        if folder_type.is_empty() {
            continue;
        }

        let total = label.messages_total.unwrap_or(0) as i32;
        let unread = label.messages_unread.unwrap_or(0) as i32;

        // Upsert folder — path = label.id for Gmail
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE account_id = ?1 AND path = ?2",
                rusqlite::params![account_id, label.id],
                |row| row.get(0),
            )
            .ok();

        let folder_id = if let Some(id) = existing {
            conn.execute(
                "UPDATE folders SET name = ?1, folder_type = ?2, total_count = ?3, unread_count = ?4 WHERE id = ?5",
                rusqlite::params![label.name, folder_type, total, unread, id],
            )?;
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO folders (id, account_id, name, folder_type, path, total_count, unread_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![id, account_id, label.name, folder_type, label.id, total, unread],
            )?;
            id
        };

        folders.push(Folder {
            id: folder_id,
            account_id: account_id.to_string(),
            name: label.name.clone(),
            folder_type,
            path: label.id.clone(),
            unread_count: unread,
            total_count: total,
            is_local: false,
            color: String::new(),
        });
    }

    // Ensure an "All Mail" / archive folder exists for Gmail
    // Gmail API doesn't expose "All Mail" as a label, but we need an archive-type folder
    // for the archive_mail command and UI display.
    let has_archive = folders.iter().any(|f| f.folder_type == "archive");
    if !has_archive {
        let existing_archive: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'archive'",
                rusqlite::params![account_id],
                |row| row.get(0),
            )
            .ok();

        let archive_id = if let Some(id) = existing_archive {
            id
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO folders (id, account_id, name, folder_type, path, total_count, unread_count) VALUES (?1, ?2, 'All Mail', 'archive', 'ALL_MAIL', 0, 0)",
                rusqlite::params![id, account_id],
            )?;
            id
        };

        folders.push(Folder {
            id: archive_id,
            account_id: account_id.to_string(),
            name: "All Mail".to_string(),
            folder_type: "archive".to_string(),
            path: "ALL_MAIL".to_string(),
            unread_count: 0,
            total_count: 0,
            is_local: false,
            color: String::new(),
        });
    }

    Ok(folders)
}

/// Reconcile a Gmail folder against the server by listing every message ID that
/// currently carries the folder's label and deleting any local mail in the
/// folder no longer present. Safety net for Trash/Spam: permanent deletions made
/// on another device emit a History `messageDeleted` event, but if this device
/// missed the history window (expiry → add-only full re-sync), those deletions
/// would otherwise never propagate. Returns the number of stale mails removed.
///
/// A successful empty listing is authoritative (the label is truly empty, e.g.
/// Trash was emptied elsewhere); API errors propagate via `?`, so local data is
/// never wiped on a transient failure. Mails with a queued pending op are left
/// alone so an in-flight local move isn't mistaken for a server-side deletion.
pub async fn reconcile_folder(
    client: &GmailClient,
    folder: &Folder,
    account_id: &str,
    db: &Database,
) -> Result<u32> {
    // ALL_MAIL has no label filter (would list the whole mailbox) — never here.
    if folder.path == "ALL_MAIL" || folder.path.is_empty() {
        return Ok(0);
    }

    // Nothing local to reconcile → skip the API call entirely.
    let local_count: i64 = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COUNT(*) FROM mails WHERE account_id = ?1 AND folder_id = ?2",
            rusqlite::params![account_id, folder.id],
            |row| row.get(0),
        ).unwrap_or(0)
    };
    if local_count == 0 {
        return Ok(0);
    }

    // Authoritative snapshot: every message ID currently under this label.
    let mut server_ids: HashSet<String> = HashSet::new();
    let mut page_token: Option<String> = None;
    loop {
        if page_token.is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        let resp = client.list_messages(&folder.path, page_token.as_deref(), 500).await?;
        if let Some(msgs) = resp.messages {
            for msg in msgs {
                server_ids.insert(msg.id);
            }
        }
        page_token = resp.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    // Local mails in this folder without an in-flight pending op.
    let local: Vec<(String, String)> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare(
            "SELECT id, message_id FROM mails \
             WHERE account_id = ?1 AND folder_id = ?2 \
               AND message_id IS NOT NULL AND message_id != '' \
               AND id NOT IN (SELECT mail_id FROM pending_ops WHERE account_id = ?1)"
        )?;
        let rows = stmt.query_map(rusqlite::params![account_id, folder.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let stale: Vec<String> = local.into_iter()
        .filter(|(_, mid)| !server_ids.contains(mid))
        .map(|(id, _)| id)
        .collect();

    if stale.is_empty() {
        return Ok(0);
    }

    {
        let conn = db.lock_db();
        for id in &stale {
            let _ = conn.execute("DELETE FROM mails WHERE id = ?1", rusqlite::params![id]);
        }
        let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)", []);
    }
    log::info!(
        "Gmail reconcile '{}': removed {} stale mails (no longer under label on server)",
        folder.name, stale.len()
    );
    Ok(stale.len() as u32)
}

/// Initial sync: list all messages in a folder, batch-fetch metadata, insert into DB.
/// Returns (new_count, latest_history_id). Caller stores history_id after ALL folders complete.
pub async fn initial_sync_folder(
    client: &GmailClient,
    folder: &Folder,
    account_id: &str,
    db: &Database,
    app: Option<(&AppHandle, u32, u32, u32)>,
) -> Result<(u32, Option<String>)> {
    let is_all_mail = folder.path == "ALL_MAIL";

    // 1. List all message IDs (paginated)
    // For ALL_MAIL: list all messages (no label filter)
    // For regular folders: list messages with that label
    let label_filter = if is_all_mail { "" } else { &folder.path };
    let mut all_ids: Vec<String> = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        // Throttle between pagination requests — each list_messages = 5 quota units
        if page_token.is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        let resp = client.list_messages(label_filter, page_token.as_deref(), 500).await?;

        if let Some(msgs) = resp.messages {
            for msg in msgs {
                all_ids.push(msg.id);
            }
        }

        // Emit pagination progress so the UI shows activity during listing
        if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
            let _ = app_handle.emit("sync-progress", &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: Some(folder.name.clone()),
                folder_index: folder_idx,
                folder_count,
                new_mails: base_new,
                message: format!("Fetching {} — {} messages found...", folder.name, all_ids.len()),
            });
        }

        page_token = resp.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    if all_ids.is_empty() {
        return Ok((0, None));
    }

    // 2. Filter out already-known message IDs
    // For ALL_MAIL: check across ALL folders (only insert messages not in any folder)
    // For regular folders: check only this folder
    let existing_ids: HashSet<String> = {
        let conn = db.lock_db();
        if is_all_mail {
            let mut stmt = conn.prepare(
                "SELECT message_id FROM mails WHERE account_id = ?1 AND message_id IS NOT NULL"
            )?;
            let result = stmt.query_map(rusqlite::params![account_id], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok()).collect();
            result
        } else {
            let mut stmt = conn.prepare(
                "SELECT message_id FROM mails WHERE account_id = ?1 AND folder_id = ?2 AND message_id IS NOT NULL"
            )?;
            let result = stmt.query_map(rusqlite::params![account_id, folder.id], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok()).collect();
            result
        }
    };

    let new_ids: Vec<&str> = all_ids.iter()
        .filter(|id| !existing_ids.contains(*id))
        .map(|s| s.as_str())
        .collect();

    if new_ids.is_empty() {
        return Ok((0, None));
    }

    log::info!("Gmail initial_sync_folder '{}': {} total, {} new", folder.name, all_ids.len(), new_ids.len());

    // Cool-down after list_messages pagination — quota needs time to recover
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // 3. Batch-fetch metadata in chunks of 15 with adaptive rate limiting.
    // Gmail has a per-batch concurrency limit of ~20 sub-requests — anything above gets 429'd
    // regardless of delay. 15/batch stays safely under this limit.
    // Adaptive delay: starts at 1500ms, +50% on 429s (max 8s), halves on clean (min 1s).
    let mut new_count: u32 = 0;
    let mut latest_history_id: Option<String> = None;
    let mut synced_ids: HashSet<String> = HashSet::new();
    let total_to_sync = new_ids.len();
    let mut batch_delay_ms: u64 = 1500;

    for (batch_idx, chunk) in new_ids.chunks(15).enumerate() {
        if batch_idx > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(batch_delay_ms)).await;
        }

        let batch_result = match client.batch_get_messages(chunk, "metadata").await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Gmail batch {} failed (chunk of {}): {}", batch_idx, chunk.len(), e);
                // Full batch failure — likely 429 on the whole request, slow down significantly
                batch_delay_ms = (batch_delay_ms * 2).min(8000);
                continue;
            }
        };

        if batch_result.rate_limited > 0 {
            batch_delay_ms = (batch_delay_ms * 3 / 2).min(8000); // +50%, max 8s
            log::info!("Gmail adaptive: {}/{} rate-limited, delay → {}ms", batch_result.rate_limited, chunk.len(), batch_delay_ms);
        } else {
            batch_delay_ms = (batch_delay_ms / 2).max(1000); // halve on clean, min 1s
        }

        let conn = db.lock_db();
        for msg in &batch_result.messages {
            synced_ids.insert(msg.id.clone());
            if insert_message_from_metadata(&conn, msg, folder, account_id)? {
                new_count += 1;
            }
            if let Some(ref hid) = msg.history_id {
                latest_history_id = Some(hid.clone());
            }
        }
        drop(conn);

        if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
            let _ = app_handle.emit("sync-progress", &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: Some(folder.name.clone()),
                folder_index: folder_idx,
                folder_count,
                new_mails: base_new + new_count,
                message: format!("Syncing {} — {} of {} messages...", folder.name, new_count, total_to_sync),
            });
        }
    }

    // Retry pass: collect failed IDs and retry with longer delays
    let mut missing_ids: Vec<&str> = new_ids.iter()
        .filter(|id| !synced_ids.contains(**id))
        .copied()
        .collect();

    for retry_round in 0u32..3 {
        if missing_ids.is_empty() {
            break;
        }
        let backoff_secs = 5 * 2u64.pow(retry_round); // 5s, 10s, 20s
        log::info!(
            "Gmail retry round {} for '{}': {} missing messages, waiting {}s...",
            retry_round + 1, folder.name, missing_ids.len(), backoff_secs
        );

        if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
            let _ = app_handle.emit("sync-progress", &SyncProgress {
                account_id: account_id.to_string(),
                status: "syncing_mails".into(),
                folder_name: Some(folder.name.clone()),
                folder_index: folder_idx,
                folder_count,
                new_mails: base_new + new_count,
                message: format!("Rate limited — retrying {} messages in {}s...", missing_ids.len(), backoff_secs),
            });
        }

        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;

        let mut still_missing: Vec<&str> = Vec::new();
        let mut retry_delay_ms: u64 = 3000; // start conservative for retries

        for chunk in missing_ids.chunks(10) {
            tokio::time::sleep(std::time::Duration::from_millis(retry_delay_ms)).await;

            match client.batch_get_messages(chunk, "metadata").await {
                Ok(batch_result) => {
                    let returned_ids: HashSet<&str> = batch_result.messages.iter().map(|m| m.id.as_str()).collect();

                    if batch_result.rate_limited > 0 {
                        retry_delay_ms = (retry_delay_ms * 3 / 2).min(10000);
                    } else {
                        retry_delay_ms = (retry_delay_ms * 3 / 4).max(2000);
                    }

                    let conn = db.lock_db();
                    for msg in &batch_result.messages {
                        synced_ids.insert(msg.id.clone());
                        if insert_message_from_metadata(&conn, msg, folder, account_id)? {
                            new_count += 1;
                        }
                        if let Some(ref hid) = msg.history_id {
                            latest_history_id = Some(hid.clone());
                        }
                    }
                    drop(conn);

                    for id in chunk {
                        if !returned_ids.contains(id) {
                            still_missing.push(id);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Gmail retry batch failed: {}", e);
                    still_missing.extend_from_slice(chunk);
                    retry_delay_ms = (retry_delay_ms * 2).min(10000);
                }
            }

            if let Some((app_handle, folder_idx, folder_count, base_new)) = app {
                let _ = app_handle.emit("sync-progress", &SyncProgress {
                    account_id: account_id.to_string(),
                    status: "syncing_mails".into(),
                    folder_name: Some(folder.name.clone()),
                    folder_index: folder_idx,
                    folder_count,
                    new_mails: base_new + new_count,
                    message: format!("Retrying — {} of {} messages...", new_count, total_to_sync),
                });
            }
        }

        missing_ids = still_missing;
    }

    if !missing_ids.is_empty() {
        log::warn!(
            "Gmail initial_sync_folder '{}': {} messages still missing after retries (synced {}/{})",
            folder.name, missing_ids.len(), new_count, total_to_sync
        );
    }

    // Apply mail rules to newly synced messages
    if new_count > 0 {
        let conn = db.lock_db();
        let mut newly_inserted: Vec<String> = Vec::new();
        for gmail_id in synced_ids.iter() {
            if !existing_ids.contains(gmail_id.as_str()) {
                if let Ok(local_id) = conn.query_row(
                    "SELECT id FROM mails WHERE account_id = ?1 AND folder_id = ?2 AND message_id = ?3",
                    rusqlite::params![account_id, folder.id, gmail_id],
                    |row| row.get::<_, String>(0),
                ) {
                    newly_inserted.push(local_id);
                }
            }
        }
        drop(conn);
        if !newly_inserted.is_empty() {
            crate::rules::apply_rules_to_mails(account_id, &newly_inserted, db);
        }
    }

    Ok((new_count, latest_history_id))
}

/// Insert a single Gmail message (metadata format) into the DB.
fn insert_message_from_metadata(
    conn: &rusqlite::Connection,
    msg: &GmailMessage,
    folder: &Folder,
    account_id: &str,
) -> Result<bool> {
    let payload = match &msg.payload {
        Some(p) => p,
        None => return Ok(false),
    };

    // Skip messages that have been trashed/spammed but still appear under their original label.
    // Gmail keeps the original labels (e.g. SENT) even after adding TRASH/SPAM, so
    // list_messages("SENT") still returns trashed messages. Without this check, Phase 2
    // would re-insert them into the original folder after incremental sync moved them out.
    let labels = msg.label_ids.as_deref().unwrap_or(&[]);
    let has_trash = labels.iter().any(|l| l == "TRASH");
    let has_spam = labels.iter().any(|l| l == "SPAM");
    if (has_trash && folder.path != "TRASH") || (has_spam && folder.path != "SPAM") {
        return Ok(false);
    }

    let subject = api::get_header(payload, "Subject")
        .filter(|s| !s.is_empty())
        .unwrap_or("(No Subject)");
    let from_raw = api::get_header(payload, "From").unwrap_or("");
    let to_raw = api::get_header(payload, "To").unwrap_or("");
    let cc_raw = api::get_header(payload, "Cc").unwrap_or("");
    let _date_raw = api::get_header(payload, "Date").unwrap_or("");
    let _rfc_message_id = api::get_header(payload, "Message-ID").or_else(|| api::get_header(payload, "Message-Id")).unwrap_or("");
    let in_reply_to = api::get_header(payload, "In-Reply-To");
    let references = api::get_header(payload, "References");

    let reply_to_raw = api::get_header(payload, "Reply-To").unwrap_or("");

    let (from_name, from_email) = parse_address(from_raw);
    let to_json = addresses_to_json(to_raw);
    let cc_json = addresses_to_json(cc_raw);
    let reply_to_json = addresses_to_json(reply_to_raw);

    let is_read = !labels.iter().any(|l| l == "UNREAD");
    let is_starred = labels.iter().any(|l| l == "STARRED");

    let content_type = api::get_header(payload, "Content-Type").unwrap_or("");
    let has_attachments = content_type.starts_with("multipart/mixed");

    let list_unsubscribe = api::get_header(payload, "List-Unsubscribe").unwrap_or("");

    // Parse date — Gmail internalDate is millis since epoch.
    // Format as RFC3339 UTC (with `T` and `Z`) so the frontend's parseISO treats it
    // as UTC and renders in the user's local timezone. A bare "YYYY-MM-DD HH:MM:SS"
    // string is interpreted as local time by parseISO and ends up showing UTC values
    // verbatim.
    let now_fallback = || chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let date = if let Some(ref internal_date) = msg.internal_date {
        if let Ok(millis) = internal_date.parse::<i64>() {
            chrono::DateTime::from_timestamp(millis / 1000, 0)
                .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                .unwrap_or_else(now_fallback)
        } else {
            now_fallback()
        }
    } else {
        now_fallback()
    };

    let snippet = msg.snippet.as_deref().unwrap_or("");
    let mail_id = uuid::Uuid::new_v4().to_string();
    let thread_id = msg.thread_id.as_deref();

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
        "INSERT OR IGNORE INTO mails (id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, has_attachments, thread_id, in_reply_to, \"references\", size_bytes, list_unsubscribe, reply_to_json)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, '', '', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        rusqlite::params![
            mail_id, account_id, folder.id, msg.id,
            subject, from_name, from_email, to_json, cc_json,
            date, snippet, is_read as i32, is_starred as i32,
            has_attachments as i32, thread_id, in_reply_to, references,
            msg.size_estimate, list_unsubscribe, reply_to_json,
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

/// Incremental sync via History API.
/// Returns the number of changes processed.
pub async fn incremental_sync(
    client: &GmailClient,
    account_id: &str,
    db: &Database,
    _app: &AppHandle,
) -> Result<u32> {
    let history_id: String = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COALESCE(gmail_history_id, '') FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };

    if history_id.is_empty() {
        bail!("no_history_id");
    }

    let mut changes: u32 = 0;
    let mut page_token: Option<String> = None;
    let mut latest_history_id = history_id.clone();

    let label_to_folder: std::collections::HashMap<String, String> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare(
            "SELECT path, id FROM folders WHERE account_id = ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![account_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    loop {
        let resp = match client.list_history(&history_id, page_token.as_deref()).await {
            Ok(r) => r,
            Err(e) if e.to_string().contains("history_expired") => {
                // History too old — clear history_id to trigger full re-sync
                let conn = db.lock_db();
                let _ = conn.execute(
                    "UPDATE accounts SET gmail_history_id = '' WHERE id = ?1",
                    rusqlite::params![account_id],
                );
                bail!("history_expired");
            }
            Err(e) => return Err(e),
        };

        if let Some(ref hid) = resp.history_id {
            latest_history_id = hid.clone();
        }

        if let Some(records) = resp.history {
            for record in records {
                if let Some(added) = record.messages_added {
                    let added_ids: Vec<String> = added.iter().map(|e| e.message.id.clone()).collect();
                    for chunk in added_ids.chunks(15) {
                        let refs: Vec<&str> = chunk.iter().map(|s| s.as_str()).collect();
                        let batch_result = match client.batch_get_messages(&refs, "metadata").await {
                            Ok(r) => r,
                            Err(e) => { log::warn!("Gmail incremental batch failed: {}", e); continue; }
                        };
                        for full_msg in &batch_result.messages {
                            let labels = full_msg.label_ids.as_deref().unwrap_or(&[]);
                            for label_id in labels {
                                if let Some(folder_id) = label_to_folder.get(label_id) {
                                    let folder = Folder {
                                        id: folder_id.clone(),
                                        account_id: account_id.to_string(),
                                        name: String::new(),
                                        folder_type: String::new(),
                                        path: label_id.clone(),
                                        unread_count: 0,
                                        total_count: 0,
                                        is_local: false,
                                        color: String::new(),
                                    };
                                    let conn = db.lock_db();
                                    if insert_message_from_metadata(&conn, full_msg, &folder, account_id)? {
                                        changes += 1;
                                    }
                                }
                            }
                            if let Some(ref hid) = full_msg.history_id {
                                latest_history_id = hid.clone();
                            }
                        }
                    }
                }

                if let Some(deleted) = record.messages_deleted {
                    let conn = db.lock_db();
                    for entry in deleted {
                        let gmail_id = &entry.message.id;
                        let deleted_count = conn.execute(
                            "DELETE FROM mails WHERE account_id = ?1 AND message_id = ?2",
                            rusqlite::params![account_id, gmail_id],
                        ).unwrap_or(0);
                        if deleted_count > 0 {
                            changes += 1;
                        }
                    }
                }

                if let Some(label_added) = record.labels_added {
                    let conn = db.lock_db();
                    for entry in label_added {
                        let gmail_id = &entry.message.id;
                        for label_id in &entry.label_ids {
                            if label_id == "UNREAD" {
                                let _ = conn.execute(
                                    "UPDATE mails SET is_read = 0 WHERE account_id = ?1 AND message_id = ?2",
                                    rusqlite::params![account_id, gmail_id],
                                );
                                changes += 1;
                            } else if label_id == "STARRED" {
                                let _ = conn.execute(
                                    "UPDATE mails SET is_starred = 1 WHERE account_id = ?1 AND message_id = ?2",
                                    rusqlite::params![account_id, gmail_id],
                                );
                                changes += 1;
                            } else if label_id == "TRASH" {
                                if let Some(trash_folder_id) = label_to_folder.get("TRASH") {
                                    let _ = conn.execute(
                                        "UPDATE mails SET folder_id = ?1 WHERE account_id = ?2 AND message_id = ?3",
                                        rusqlite::params![trash_folder_id, account_id, gmail_id],
                                    );
                                    changes += 1;
                                }
                            } else if let Some(folder_id) = label_to_folder.get(label_id.as_str()) {
                                // Message moved to a new folder — update folder_id
                                let _ = conn.execute(
                                    "UPDATE mails SET folder_id = ?1 WHERE account_id = ?2 AND message_id = ?3",
                                    rusqlite::params![folder_id, account_id, gmail_id],
                                );
                                changes += 1;
                            }
                        }
                    }
                }

                if let Some(label_removed) = record.labels_removed {
                    let conn = db.lock_db();
                    for entry in label_removed {
                        let gmail_id = &entry.message.id;
                        for label_id in &entry.label_ids {
                            if label_id == "UNREAD" {
                                let _ = conn.execute(
                                    "UPDATE mails SET is_read = 1 WHERE account_id = ?1 AND message_id = ?2",
                                    rusqlite::params![account_id, gmail_id],
                                );
                                changes += 1;
                            } else if label_id == "STARRED" {
                                let _ = conn.execute(
                                    "UPDATE mails SET is_starred = 0 WHERE account_id = ?1 AND message_id = ?2",
                                    rusqlite::params![account_id, gmail_id],
                                );
                                changes += 1;
                            } else if matches!(label_id.as_str(), "INBOX" | "TRASH" | "SPAM") {
                                // A system folder label was removed (e.g. restored from
                                // Trash/Spam, or archived). The message now lives in
                                // All Mail — unless a same-batch label-add already moved
                                // it elsewhere, which the `folder_id = ?4` guard detects
                                // (then this update affects 0 rows and we leave it).
                                if let (Some(removed_folder_id), Some(archive_id)) =
                                    (label_to_folder.get(label_id.as_str()), label_to_folder.get("ALL_MAIL"))
                                {
                                    let moved = conn.execute(
                                        "UPDATE mails SET folder_id = ?1 WHERE account_id = ?2 AND message_id = ?3 AND folder_id = ?4",
                                        rusqlite::params![archive_id, account_id, gmail_id, removed_folder_id],
                                    ).unwrap_or(0);
                                    if moved > 0 {
                                        changes += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        page_token = resp.next_page_token;
        if page_token.is_none() {
            break;
        }

        // Throttle between history pages
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE accounts SET gmail_history_id = ?1 WHERE id = ?2",
            rusqlite::params![latest_history_id, account_id],
        );
    }

    log::info!("Gmail incremental_sync: {} changes for account {}", changes, account_id);
    Ok(changes)
}

/// Public wrapper for parse_address, used by messages.rs for metadata backfill.
pub fn parse_address_public(raw: &str) -> (String, String) {
    parse_address(raw)
}

/// Parse "Display Name <email@example.com>" into (name, email).
fn parse_address(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (String::new(), String::new());
    }

    if let Some(lt) = raw.find('<') {
        if let Some(gt) = raw.find('>') {
            let name = raw[..lt].trim().trim_matches('"').to_string();
            let email = raw[lt + 1..gt].trim().to_string();
            return (name, email);
        }
    }

    // No angle brackets — treat whole thing as email
    (String::new(), raw.to_string())
}

/// Public wrapper for addresses_to_json, used by messages.rs for body-fetch backfill.
pub fn addresses_to_json_pub(raw: &str) -> String {
    addresses_to_json(raw)
}

/// Convert a comma-separated address list into JSON array of {name, email}.
fn addresses_to_json(raw: &str) -> String {
    if raw.trim().is_empty() {
        return "[]".to_string();
    }

    let mut addrs = Vec::new();
    for addr in raw.split(',') {
        let (name, email) = parse_address(addr);
        if !email.is_empty() {
            addrs.push(serde_json::json!({"name": name, "email": email}));
        }
    }

    serde_json::to_string(&addrs).unwrap_or_else(|_| "[]".to_string())
}

use anyhow::bail;
