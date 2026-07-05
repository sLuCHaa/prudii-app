use crate::credentials;
use crate::db::Database;
use crate::gmail;
use crate::imap;
use crate::outlook;
use crate::models::{Attachment, AttachmentWithContext, BulkSaveResult, Contact, Mail, MailAddress};
use super::sync::sanitize_fts_query;
use crate::pool::ImapPool;
use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Manager, State};

/// Deduplicate mails in two passes:
/// 1. By message_id (same account/folder duplicates)
/// 2. By subject+date+from (cross-account duplicates, e.g. same email in Gmail + IMAP)
fn dedup_mails(mails: Vec<Mail>) -> Vec<Mail> {
    let original_count = mails.len();

    // Pass 1: dedup by message_id (within same sync source)
    let mut seen_ids = HashSet::new();
    let pass1: Vec<Mail> = mails.into_iter().filter(|m| {
        let key = if m.message_id.is_empty() { &m.id } else { &m.message_id };
        seen_ids.insert(key.clone())
    }).collect();

    // Pass 2: dedup by subject+date+from_email (cross-account)
    // Skip dedup for mails with empty/placeholder subject OR empty from — these are
    // likely incomplete (e.g. Outlook delta sync returned only IDs) and would falsely
    // collapse multiple distinct mails into one.
    let mut seen_content = HashSet::new();
    let result: Vec<Mail> = pass1.into_iter().filter(|m| {
        if m.subject.is_empty() || m.subject == "(No Subject)" || m.from.email.is_empty() {
            return true; // never dedup mails with missing/incomplete metadata
        }
        let content_key = format!("{}|{}|{}", m.subject.to_lowercase().trim(), m.date, m.from.email.to_lowercase());
        seen_content.insert(content_key)
    }).collect();

    if result.len() < original_count {
        log::info!("dedup_mails: {} → {} ({} removed)", original_count, result.len(), original_count - result.len());
    }
    result
}

/// API type for an account — determines which backend to use.
enum ApiType {
    Gmail,
    Outlook,
    Imap,
}

/// Delete a pending operation from a background task using an ad-hoc DB connection.
/// Used by spawned tasks that don't have access to the main Database state.
fn delete_pending_op_bg(db_path: &std::path::Path, mail_id: &str, op_type: &str) {
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = conn.execute_batch("PRAGMA busy_timeout=5000;");
        let _ = conn.execute(
            "DELETE FROM pending_ops WHERE mail_id = ?1 AND op_type = ?2",
            rusqlite::params![mail_id, op_type],
        );
    }
}

/// Persist a message's new Graph ID after a server-side move.
/// Outlook Graph message IDs are mutable — every folder move assigns a new one,
/// so the stored ID must be refreshed or later body fetches / mail ops 404.
fn update_mail_message_id_bg(db_path: &std::path::Path, mail_id: &str, new_graph_id: &str) {
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = conn.execute_batch("PRAGMA busy_timeout=5000;");
        let _ = conn.execute(
            "UPDATE mails SET message_id = ?1 WHERE id = ?2",
            rusqlite::params![new_graph_id, mail_id],
        );
    }
}

/// internetMessageId of a mail (stored in the "references" column for API accounts),
/// JSON-escaped for embedding in a pending-op payload. Lets the pending-op processor
/// re-resolve a stale Outlook Graph ID even after the local mail row was replaced by
/// a sync. Empty string when unknown.
fn get_internet_id_escaped(db: &Database, mail_id: &str) -> String {
    let conn = db.lock_db();
    conn.query_row(
        "SELECT COALESCE(\"references\", '') FROM mails WHERE id = ?1",
        rusqlite::params![mail_id],
        |row| row.get::<_, String>(0),
    ).unwrap_or_default().replace('\\', "\\\\").replace('"', "\\\"")
}

/// Returns (ApiType, provider, auth_type).
fn get_api_type(db: &Database, account_id: &str) -> (ApiType, String, String) {
    let conn = db.lock_db();
    let result: Result<(String, String), _> = conn.query_row(
        "SELECT provider, auth_type FROM accounts WHERE id = ?1",
        rusqlite::params![account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match result {
        Ok((provider, auth_type)) => {
            let api = if provider == "google" && auth_type == "oauth" {
                ApiType::Gmail
            } else if provider == "microsoft" && auth_type == "oauth" {
                ApiType::Outlook
            } else {
                ApiType::Imap
            };
            (api, provider, auth_type)
        }
        Err(_) => (ApiType::Imap, String::new(), String::new()),
    }
}

/// Get the API message ID (stored in mails.message_id) for a local mail.
/// Used for both Gmail and Outlook API accounts.
fn get_api_message_id(db: &Database, mail_id: &str) -> Option<(String, String)> {
    let conn = db.lock_db();
    conn.query_row(
        "SELECT message_id, account_id FROM mails WHERE id = ?1",
        rusqlite::params![mail_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .ok()
}

/// Prevents duplicate IMAP fetches for the same mail when frontend calls
/// fetch_mail_body from multiple components simultaneously.
static FETCHING_BODIES: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn parse_addresses(json_str: &str) -> Vec<MailAddress> {
    serde_json::from_str(json_str).unwrap_or_default()
}

fn parse_flags(flags_str: &str) -> Vec<String> {
    if flags_str.is_empty() {
        Vec::new()
    } else {
        flags_str.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    }
}

/// Build optional SQL filter clause for folder-level filtering (unread/starred/attachments).
/// `prefix` is e.g. "m." for joined queries or "" for standalone queries.
fn filter_clause(filter: &Option<String>, prefix: &str) -> String {
    match filter.as_deref() {
        Some("unread") => format!(" AND {}is_read = 0", prefix),
        Some("starred") => format!(" AND {}is_starred = 1", prefix),
        Some("attachments") => format!(" AND {}has_attachments = 1", prefix),
        Some("pinned") => format!(" AND {}is_pinned = 1", prefix),
        _ => String::new(),
    }
}

#[tauri::command]
pub fn list_mails(db: State<'_, Database>, folder_id: String, limit: Option<u32>, offset: Option<u32>, folder_filter: Option<String>) -> Result<Vec<Mail>, String> {
    super::catch_panic(|| {
    let limit = limit.unwrap_or(500).min(2000);
    let offset = offset.unwrap_or(0);
    let extra = filter_clause(&folder_filter, "");
    let conn = db.lock_db();
    let sql = format!("SELECT id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, '' as body_text, '' as body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, '') as flags, COALESCE(list_unsubscribe, '') as list_unsubscribe, COALESCE(is_pinned, 0) as is_pinned, COALESCE(snoozed_until, '') as snoozed_until, COALESCE(reply_to_json, '[]') as reply_to_json, COALESCE(\"references\", '') FROM mails WHERE folder_id = ?1 AND (snoozed_until IS NULL OR snoozed_until = '' OR snoozed_until <= datetime('now')){} ORDER BY is_pinned DESC, date DESC LIMIT ?2 OFFSET ?3", extra);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;

    let mails = stmt
        .query_map(rusqlite::params![folder_id, limit, offset], |row| {
            let to_json: String = row.get(8)?;
            let cc_json: String = row.get(9)?;
            let bcc_json: String = row.get(10)?;
            let flags_str: String = row.get(24)?;
            let unsub_str: String = row.get(25)?;
            let snoozed_str: String = row.get(27)?;
            let reply_to_json: String = row.get(28)?;

            Ok(Mail {
                id: row.get(0)?,
                account_id: row.get(1)?,
                folder_id: row.get(2)?,
                message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                uid: row.get(4)?,
                subject: row.get(5)?,
                from: MailAddress {
                    name: row.get(6)?,
                    email: row.get(7)?,
                },
                to: parse_addresses(&to_json),
                cc: parse_addresses(&cc_json),
                bcc: parse_addresses(&bcc_json),
                date: row.get(11)?,
                snippet: row.get(12)?,
                body_text: row.get(13)?,
                body_html: row.get(14)?,
                is_read: row.get::<_, i32>(15)? != 0,
                is_starred: row.get::<_, i32>(16)? != 0,
                is_flagged: row.get::<_, i32>(17)? != 0,
                is_replied: row.get::<_, i32>(18)? != 0,
                is_forwarded: row.get::<_, i32>(19)? != 0,
                has_attachments: row.get::<_, i32>(20)? != 0,
                thread_id: row.get(21)?,
                in_reply_to: row.get(22)?,
                references: row.get::<_, String>(29).unwrap_or_default(),
                size_bytes: row.get(23)?,
                flags: parse_flags(&flags_str),
                list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                reply_to: parse_addresses(&reply_to_json),
                is_pinned: row.get::<_, i32>(26)? != 0,
                snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(dedup_mails(mails))
    })
}

#[tauri::command]
pub fn list_all_inbox_mails(db: State<'_, Database>, limit: Option<u32>, offset: Option<u32>, folder_filter: Option<String>) -> Result<Vec<Mail>, String> {
    super::catch_panic(|| {
    let limit = limit.unwrap_or(500).min(2000);
    let offset = offset.unwrap_or(0);
    let extra = filter_clause(&folder_filter, "m.");
    let conn = db.lock_db();
    let sql = format!("SELECT m.id, m.account_id, m.folder_id, m.message_id, m.uid, m.subject, m.from_name, m.from_email, m.to_json, m.cc_json, m.bcc_json, m.date, m.snippet, '' as body_text, '' as body_html, m.is_read, m.is_starred, m.is_flagged, m.is_replied, m.is_forwarded, m.has_attachments, m.thread_id, m.in_reply_to, m.size_bytes, COALESCE(m.flags, '') as flags, COALESCE(m.list_unsubscribe, '') as list_unsubscribe, COALESCE(m.is_pinned, 0) as is_pinned, COALESCE(m.snoozed_until, '') as snoozed_until, COALESCE(m.reply_to_json, '[]') as reply_to_json, COALESCE(m.\"references\", '')
             FROM mails m
             JOIN folders f ON m.folder_id = f.id
             WHERE f.folder_type = 'inbox' AND (m.snoozed_until IS NULL OR m.snoozed_until = '' OR m.snoozed_until <= datetime('now')){}
             ORDER BY m.is_pinned DESC, m.date DESC
             LIMIT ?1 OFFSET ?2", extra);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;

    let mails = stmt
        .query_map(rusqlite::params![limit, offset], |row| {
            let to_json: String = row.get(8)?;
            let cc_json: String = row.get(9)?;
            let bcc_json: String = row.get(10)?;
            let flags_str: String = row.get(24)?;
            let unsub_str: String = row.get(25)?;
            let snoozed_str: String = row.get(27)?;
            let reply_to_json: String = row.get(28)?;

            Ok(Mail {
                id: row.get(0)?,
                account_id: row.get(1)?,
                folder_id: row.get(2)?,
                message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                uid: row.get(4)?,
                subject: row.get(5)?,
                from: MailAddress {
                    name: row.get(6)?,
                    email: row.get(7)?,
                },
                to: parse_addresses(&to_json),
                cc: parse_addresses(&cc_json),
                bcc: parse_addresses(&bcc_json),
                date: row.get(11)?,
                snippet: row.get(12)?,
                body_text: row.get(13)?,
                body_html: row.get(14)?,
                is_read: row.get::<_, i32>(15)? != 0,
                is_starred: row.get::<_, i32>(16)? != 0,
                is_flagged: row.get::<_, i32>(17)? != 0,
                is_replied: row.get::<_, i32>(18)? != 0,
                is_forwarded: row.get::<_, i32>(19)? != 0,
                has_attachments: row.get::<_, i32>(20)? != 0,
                thread_id: row.get(21)?,
                in_reply_to: row.get(22)?,
                references: row.get::<_, String>(29).unwrap_or_default(),
                size_bytes: row.get(23)?,
                flags: parse_flags(&flags_str),
                list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                reply_to: parse_addresses(&reply_to_json),
                is_pinned: row.get::<_, i32>(26)? != 0,
                snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(dedup_mails(mails))
    })
}

#[tauri::command]
pub fn list_filtered_mails(
    db: State<'_, Database>,
    filter_type: String,
    account_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    folder_filter: Option<String>,
) -> Result<Vec<Mail>, String> {
    super::catch_panic(|| {
    let limit = limit.unwrap_or(500).min(2000);
    let offset = offset.unwrap_or(0);
    let extra = filter_clause(&folder_filter, "");
    let conn = db.lock_db();

    const BASE_SELECT: &str = "SELECT id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, '' as body_text, '' as body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, '') as flags, COALESCE(list_unsubscribe, '') as list_unsubscribe, COALESCE(is_pinned, 0) as is_pinned, COALESCE(snoozed_until, '') as snoozed_until, COALESCE(reply_to_json, '[]') as reply_to_json, COALESCE(\"references\", '') FROM mails";

    let row_mapper = |row: &rusqlite::Row| {
        let to_json: String = row.get(8)?;
        let cc_json: String = row.get(9)?;
        let bcc_json: String = row.get(10)?;
        let flags_str: String = row.get(24)?;
        let unsub_str: String = row.get(25)?;
        let snoozed_str: String = row.get(27)?;
        let reply_to_json: String = row.get(28)?;

        Ok(Mail {
            id: row.get(0)?,
            account_id: row.get(1)?,
            folder_id: row.get(2)?,
            message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            uid: row.get(4)?,
            subject: row.get(5)?,
            from: MailAddress {
                name: row.get(6)?,
                email: row.get(7)?,
            },
            to: parse_addresses(&to_json),
            cc: parse_addresses(&cc_json),
            bcc: parse_addresses(&bcc_json),
            date: row.get(11)?,
            snippet: row.get(12)?,
            body_text: row.get(13)?,
            body_html: row.get(14)?,
            is_read: row.get::<_, i32>(15)? != 0,
            is_starred: row.get::<_, i32>(16)? != 0,
            is_flagged: row.get::<_, i32>(17)? != 0,
            is_replied: row.get::<_, i32>(18)? != 0,
            is_forwarded: row.get::<_, i32>(19)? != 0,
            has_attachments: row.get::<_, i32>(20)? != 0,
            thread_id: row.get(21)?,
            in_reply_to: row.get(22)?,
            references: row.get::<_, String>(29).unwrap_or_default(),
            size_bytes: row.get(23)?,
            flags: parse_flags(&flags_str),
            list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
            reply_to: parse_addresses(&reply_to_json),
            is_pinned: row.get::<_, i32>(26)? != 0,
            snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
        })
    };

    // All queries use parameterized placeholders — no string interpolation
    let mails = match (filter_type.as_str(), &account_id) {
        ("starred", Some(acc_id)) => {
            let sql = format!("{} WHERE is_starred = 1 AND account_id = ?1{} ORDER BY date DESC LIMIT ?2 OFFSET ?3", BASE_SELECT, extra);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![acc_id, limit, offset], row_mapper)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
        ("starred", None) => {
            let sql = format!("{} WHERE is_starred = 1{} ORDER BY date DESC LIMIT ?1 OFFSET ?2", BASE_SELECT, extra);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(rusqlite::params![limit, offset], row_mapper)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
        (flag, Some(acc_id)) => {
            let sql = format!("{} WHERE flags LIKE ?1 ESCAPE '\\' AND account_id = ?2{} ORDER BY date DESC LIMIT ?3 OFFSET ?4", BASE_SELECT, extra);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            // Escape LIKE wildcards in flag value
            let safe_flag = flag.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            let like_param = format!("%{}%", safe_flag);
            let rows = stmt.query_map(rusqlite::params![like_param, acc_id, limit, offset], row_mapper)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
        (flag, None) => {
            let sql = format!("{} WHERE flags LIKE ?1 ESCAPE '\\'{} ORDER BY date DESC LIMIT ?2 OFFSET ?3", BASE_SELECT, extra);
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let safe_flag = flag.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            let like_param = format!("%{}%", safe_flag);
            let rows = stmt.query_map(rusqlite::params![like_param, limit, offset], row_mapper)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        }
    };

    Ok(dedup_mails(mails))
    })
}

fn get_mail_inner(db: &Database, mail_id: &str) -> Result<Option<Mail>, String> {
    let conn = db.lock_db();
    let result = conn
        .query_row(
            "SELECT id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, '') as flags, COALESCE(list_unsubscribe, '') as list_unsubscribe, COALESCE(is_pinned, 0) as is_pinned, COALESCE(snoozed_until, '') as snoozed_until, COALESCE(reply_to_json, '[]') as reply_to_json, COALESCE(\"references\", '') FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| {
                let to_json: String = row.get(8)?;
                let cc_json: String = row.get(9)?;
                let bcc_json: String = row.get(10)?;
                let flags_str: String = row.get(24)?;
                let unsub_str: String = row.get(25)?;
                let snoozed_str: String = row.get(27)?;
                let reply_to_json: String = row.get(28)?;

                Ok(Mail {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    folder_id: row.get(2)?,
                    message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    uid: row.get(4)?,
                    subject: row.get(5)?,
                    from: MailAddress {
                        name: row.get(6)?,
                        email: row.get(7)?,
                    },
                    to: parse_addresses(&to_json),
                    cc: parse_addresses(&cc_json),
                    bcc: parse_addresses(&bcc_json),
                    date: row.get(11)?,
                    snippet: row.get(12)?,
                    body_text: row.get(13)?,
                    body_html: row.get(14)?,
                    is_read: row.get::<_, i32>(15)? != 0,
                    is_starred: row.get::<_, i32>(16)? != 0,
                    is_flagged: row.get::<_, i32>(17)? != 0,
                    is_replied: row.get::<_, i32>(18)? != 0,
                    is_forwarded: row.get::<_, i32>(19)? != 0,
                    has_attachments: row.get::<_, i32>(20)? != 0,
                    thread_id: row.get(21)?,
                    in_reply_to: row.get(22)?,
                    references: row.get::<_, String>(29).unwrap_or_default(),
                    size_bytes: row.get(23)?,
                    flags: parse_flags(&flags_str),
                    list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                    reply_to: parse_addresses(&reply_to_json),
                    is_pinned: row.get::<_, i32>(26)? != 0,
                    snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
                })
            },
        );

    match result {
        Ok(mail) => Ok(Some(mail)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn get_mail(db: State<'_, Database>, mail_id: String) -> Result<Option<Mail>, String> {
    super::catch_panic(|| {
        get_mail_inner(&db, &mail_id)
    })
}

#[tauri::command]
pub fn list_attachments(
    db: State<'_, Database>,
    mail_id: String,
) -> Result<Vec<Attachment>, String> {
    super::catch_panic(|| {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, mail_id, filename, mime_type, size_bytes, content_id, is_inline, local_path FROM attachments WHERE mail_id = ?1 ORDER BY filename ASC",
        )
        .map_err(|e| e.to_string())?;

    let attachments = stmt
        .query_map(rusqlite::params![mail_id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                mail_id: row.get(1)?,
                filename: row.get(2)?,
                mime_type: row.get(3)?,
                size_bytes: row.get(4)?,
                content_id: row.get(5)?,
                is_inline: row.get::<_, i32>(6)? != 0,
                local_path: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(attachments)
    })
}

/// Read an attachment file and return its content as a base64 data URL
/// for reliable in-webview preview (bypasses asset protocol scope issues).
#[tauri::command]
pub fn get_attachment_preview(
    db: State<'_, Database>,
    attachment_id: String,
) -> Result<Option<String>, String> {
    let conn = db.lock_db();
    let (local_path, mime_type): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT local_path, mime_type FROM attachments WHERE id = ?1",
            rusqlite::params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Attachment not found: {}", e))?;

    let path = match local_path {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(None),
    };

    let file_path = std::path::Path::new(&path);
    if !file_path.exists() {
        return Ok(None);
    }

    // Cap preview at 50 MB to avoid memory issues
    let metadata = std::fs::metadata(file_path).map_err(|e| e.to_string())?;
    if metadata.len() > 50 * 1024 * 1024 {
        return Ok(None);
    }

    let data = std::fs::read(file_path).map_err(|e| e.to_string())?;
    let mime = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(Some(format!("data:{};base64,{}", mime, b64)))
}

#[tauri::command]
pub fn open_attachment(
    db: State<'_, Database>,
    attachment_id: String,
) -> Result<String, String> {
    let conn = db.lock_db();
    let path: String = conn
        .query_row(
            "SELECT local_path FROM attachments WHERE id = ?1",
            rusqlite::params![attachment_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Attachment not found: {}", e))?;

    // Path traversal protection: ensure path is within app data directory
    let canonical_path = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid attachment path: {}", e))?;
    let data_dir = db.data_dir.canonicalize()
        .map_err(|e| format!("Cannot resolve data dir: {}", e))?;
    if !canonical_path.starts_with(&data_dir) {
        return Err("Attachment path is outside app data directory".into());
    }

    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &canonical_path.to_string_lossy()])
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&canonical_path)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&canonical_path)
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(path)
}

#[tauri::command]
pub async fn save_attachment(
    db: State<'_, Database>,
    attachment_id: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::sync::mpsc;

    let (filename, local_path): (String, String) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT filename, local_path FROM attachments WHERE id = ?1",
            rusqlite::params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Attachment not found: {}", e))?
    };

    let (tx, rx) = mpsc::channel();
    let local_path_clone = local_path.clone();

    app.dialog()
        .file()
        .set_file_name(&filename)
        .save_file(move |file_path| {
            let result = match file_path {
                Some(path) => {
                    if let Some(dest_path) = path.as_path() {
                        match std::fs::copy(&local_path_clone, dest_path) {
                            Ok(_) => Ok(Some(dest_path.to_string_lossy().to_string())),
                            Err(e) => Err(format!("Failed to save file: {}", e)),
                        }
                    } else {
                        Err("Invalid file path".to_string())
                    }
                }
                None => Ok(None), // User cancelled
            };
            let _ = tx.send(result);
        });

    rx.recv()
        .map_err(|e| format!("Dialog error: {}", e))?
}

/// Fetch a single mail's body from IMAP on demand.
/// Called when the user opens a mail whose body hasn't been downloaded yet.
#[tauri::command]
pub async fn fetch_mail_body(
    db: State<'_, Database>,
    pool: State<'_, ImapPool>,
    mail_id: String,
) -> Result<Mail, String> {
    let t_start = std::time::Instant::now();

    // Check if body is already cached in DB — skip fetch if so.
    // Also verify that mails flagged with attachments actually have attachment records;
    // if not, re-fetch to populate them (handles mails cached before attachment fixes).
    let can_use_cache = {
        let conn = db.lock_db();
        let has_body: bool = conn.query_row(
            "SELECT (body_html != '' OR body_text != '') FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| row.get::<_, bool>(0),
        ).unwrap_or(false);

        if !has_body {
            false
        } else {
            let has_att_flag: bool = conn.query_row(
                "SELECT has_attachments FROM mails WHERE id = ?1",
                rusqlite::params![mail_id],
                |row| row.get::<_, i32>(0).map(|v| v != 0),
            ).unwrap_or(false);

            if has_att_flag {
                let att_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM attachments WHERE mail_id = ?1",
                    rusqlite::params![mail_id],
                    |row| row.get(0),
                ).unwrap_or(0);
                att_count > 0
            } else {
                true // no attachments expected, cache is valid
            }
        }
    };
    if can_use_cache {
        log::info!("fetch_mail_body: cache HIT for {} ({:?})", mail_id, t_start.elapsed());
        return get_mail_inner(&db, &mail_id)?
            .ok_or_else(|| "Mail not found".to_string());
    }

    // Dedup: if another task is already fetching this body, wait for it to finish
    // instead of making a duplicate IMAP connection + SELECT + FETCH.
    {
        let already_fetching = {
            let fetching = FETCHING_BODIES.lock().unwrap_or_else(|e| e.into_inner());
            fetching.contains(&mail_id)
        };
        if already_fetching {
            log::info!("fetch_mail_body: waiting for parallel fetch of {}", mail_id);
            // Poll the DB cache until the other task finishes (max ~30s)
            for _ in 0..60 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let done = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT (body_html != '' OR body_text != '') FROM mails WHERE id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
                };
                if done {
                    log::info!("fetch_mail_body: parallel fetch completed for {} ({:?})", mail_id, t_start.elapsed());
                    return get_mail_inner(&db, &mail_id)?
                        .ok_or_else(|| "Mail not found".to_string());
                }
                // Check if the other task gave up
                let still_fetching = {
                    let fetching = FETCHING_BODIES.lock().unwrap_or_else(|e| e.into_inner());
                    fetching.contains(&mail_id)
                };
                if !still_fetching {
                    break; // Other task finished/failed, we'll proceed
                }
            }
            // Fallback: check cache one more time
            let has_body = {
                let conn = db.lock_db();
                conn.query_row(
                    "SELECT (body_html != '' OR body_text != '') FROM mails WHERE id = ?1",
                    rusqlite::params![mail_id],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false)
            };
            if has_body {
                return get_mail_inner(&db, &mail_id)?
                    .ok_or_else(|| "Mail not found".to_string());
            }
            // Still no body — proceed with our own fetch
        }
    }

    {
        let mut fetching = FETCHING_BODIES.lock().unwrap_or_else(|e| e.into_inner());
        fetching.insert(mail_id.clone());
    }

    let api_info = get_api_message_id(&db, &mail_id);
    if let Some((ref api_msg_id, ref account_id)) = api_info {
        let (api_type, provider, auth_type) = get_api_type(&db, account_id);
        match api_type {
            ApiType::Gmail => {
                let result = async {
                    let credential = credentials::resolve_credential(account_id, &auth_type, &provider)
                        .await
                        .map_err(|e| format!("Credentials: {}", e))?;
                    let client = gmail::api::GmailClient::new(&credential);
                    gmail::messages::fetch_message_body(&client, api_msg_id, &mail_id, &db)
                        .await
                        .map_err(|e| format!("Gmail body fetch: {}", e))?;
                    log::info!("fetch_mail_body: Gmail API fetch took {:?} for {}", t_start.elapsed(), mail_id);
                    get_mail_inner(&db, &mail_id)?
                        .ok_or_else(|| "Mail not found after body fetch".to_string())
                }.await;

                let mut fetching = FETCHING_BODIES.lock().unwrap_or_else(|e| e.into_inner());
                fetching.remove(&mail_id);
                return result;
            }
            ApiType::Outlook => {
                let result = async {
                    let credential = credentials::resolve_credential(account_id, &auth_type, &provider)
                        .await
                        .map_err(|e| format!("Credentials: {}", e))?;
                    let client = outlook::api::OutlookClient::new(&credential);
                    outlook::messages::fetch_message_body(&client, api_msg_id, &mail_id, &db)
                        .await
                        .map_err(|e| format!("Outlook body fetch: {}", e))?;
                    log::info!("fetch_mail_body: Outlook API fetch took {:?} for {}", t_start.elapsed(), mail_id);
                    get_mail_inner(&db, &mail_id)?
                        .ok_or_else(|| "Mail not found after body fetch".to_string())
                }.await;

                let mut fetching = FETCHING_BODIES.lock().unwrap_or_else(|e| e.into_inner());
                fetching.remove(&mail_id);
                return result;
            }
            ApiType::Imap => {} // fall through to IMAP path below
        }
    }

    let result = fetch_mail_body_inner(&db, &pool, &mail_id, t_start).await;

    {
        let mut fetching = FETCHING_BODIES.lock().unwrap_or_else(|e| e.into_inner());
        fetching.remove(&mail_id);
    }

    result
}

async fn fetch_mail_body_inner(
    db: &State<'_, Database>,
    pool: &State<'_, ImapPool>,
    mail_id: &str,
    t_start: std::time::Instant,
) -> Result<Mail, String> {
    let (account_id, folder_path, uid, size_bytes, message_id): (String, String, u32, Option<i64>, Option<String>) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT m.account_id, f.path, m.uid, m.size_bytes, m.message_id FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, u32>(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Mail not found: {}", e))?
    };

    // Reject oversized mails (100MB) to prevent OOM
    const MAX_BODY_SIZE: i64 = 100 * 1024 * 1024;
    if let Some(size) = size_bytes {
        if size > MAX_BODY_SIZE {
            return Err(format!("Mail is too large to download ({:.1} MB)", size as f64 / 1024.0 / 1024.0));
        }
    }

    let (imap_host, imap_port, email, auth_type, provider): (String, i32, String, String, String) = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Account not found: {}", e))?
    };

    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let t_db = t_start.elapsed();

    // Get session from pool. Skip EXAMINE only if the session is *actually* already
    // selected on the target folder. We derive this from the session's own tracked
    // selected folder (ground truth) rather than a pool-side label, which could be a
    // stale guess (e.g. sync always labels the returned session "INBOX" even when the
    // connection is left selected on the last-synced folder). Trusting that guess made
    // UID FETCH hit the wrong folder and return a different mail's body.
    let (mut session, _pool_folder) = pool.get_session_with_folder(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type)
        .await
        .map_err(|e| format!("IMAP connection failed: {}", e))?;

    let skip_examine = session.selected_folder() == Some(folder_path.as_str());

    let t_pool = t_start.elapsed();
    log::info!("fetch_mail_body: DB={:?}, pool={:?}, folder='{}' size={:?} skip_examine={}",
        t_db, t_pool - t_db, folder_path, size_bytes, skip_examine);

    let result = imap::fetch_mail_body(&mut session, &folder_path, uid, mail_id, message_id.as_deref(), db, skip_examine).await;

    let t_imap = t_start.elapsed();

    match &result {
        Ok(_) => pool.return_session_in_folder(&account_id, session, folder_path.clone()).await,
        Err(_) => { let _ = session.logout().await; pool.release(&account_id); }
    }

    log::info!("fetch_mail_body: IMAP={:?}, TOTAL={:?} for mail {}",
        t_imap - t_pool, t_start.elapsed(), mail_id);

    result.map_err(|e| format!("Failed to fetch mail body: {}", e))?;

    get_mail_inner(db, mail_id)?
        .ok_or_else(|| "Mail not found after body fetch".to_string())
}

#[tauri::command]
pub async fn toggle_star(db: State<'_, Database>, pool: State<'_, ImapPool>, mail_id: String) -> Result<bool, String> {
    let new_val: bool = {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE mails SET is_starred = 1 - is_starred WHERE id = ?1",
            rusqlite::params![mail_id],
        )
        .map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT is_starred FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| Ok(row.get::<_, i32>(0)? != 0),
        )
        .map_err(|e| format!("Mail not found: {}", e))?
    };

    if let Some((api_msg_id, account_id)) = get_api_message_id(&db, &mail_id) {
        let (api_type, provider, auth_type) = get_api_type(&db, &account_id);
        match api_type {
            ApiType::Gmail => {
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = gmail::api::GmailClient::new(&credential);
                        if let Err(e) = gmail::messages::toggle_star(&client, &api_msg_id, !new_val).await {
                            log::warn!("Gmail toggle_star failed: {}", e);
                        }
                    }
                });
            }
            ApiType::Outlook => {
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = outlook::api::OutlookClient::new(&credential);
                        if let Err(e) = outlook::messages::toggle_star(&client, &api_msg_id, !new_val).await {
                            log::warn!("Outlook toggle_star failed: {}", e);
                        }
                    }
                });
            }
            ApiType::Imap => {
                let imap_info: Option<(String, u32, String, String, i32, String)> = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT m.account_id, m.uid, f.path, a.imap_host, a.imap_port, a.email \
                         FROM mails m JOIN folders f ON m.folder_id = f.id JOIN accounts a ON m.account_id = a.id \
                         WHERE m.id = ?1 AND m.uid IS NOT NULL",
                        rusqlite::params![mail_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                    ).ok()
                };
                if let Some((acct_id, uid, folder_path, imap_host, imap_port, email)) = imap_info {
                    if let Ok(credential) = credentials::resolve_credential(&acct_id, &auth_type, &provider).await {
                        if let Ok(mut session) = pool.get_session(&acct_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                            match imap::set_flagged_on_server(&mut session, &folder_path, uid, new_val).await {
                                Ok(_) => pool.return_session(&acct_id, session).await,
                                Err(e) => {
                                    log::warn!("IMAP toggle_star failed: {}", e);
                                    let _ = session.logout().await;
                                    pool.release(&acct_id);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(new_val)
}

#[tauri::command]
pub fn toggle_pin(db: State<'_, Database>, mail_id: String) -> Result<bool, String> {
    super::catch_panic(|| {
        let current: bool = {
            let conn = db.lock_db();
            conn.query_row(
                "SELECT COALESCE(is_pinned, 0) FROM mails WHERE id = ?1",
                rusqlite::params![mail_id],
                |row| Ok(row.get::<_, i32>(0)? != 0),
            )
            .map_err(|e| format!("Mail not found: {}", e))?
        };

        let new_val = !current;
        {
            let conn = db.lock_db();
            conn.execute(
                "UPDATE mails SET is_pinned = ?1 WHERE id = ?2",
                rusqlite::params![new_val as i32, mail_id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(new_val)
    })
}

#[tauri::command]
pub fn snooze_mail(db: State<'_, Database>, mail_id: String, until: String) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        // Snoozing marks the mail read (to hide it). If it was unread, keep the
        // folder's unread_count in step so the badge is right before the next sync.
        let info: Option<(String, bool)> = conn.query_row(
            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
        ).ok();
        conn.execute(
            "UPDATE mails SET snoozed_until = ?1, is_read = 1 WHERE id = ?2",
            rusqlite::params![until, mail_id],
        )
        .map_err(|e| e.to_string())?;
        if let Some((folder_id, was_read)) = info {
            if !was_read && !folder_id.is_empty() {
                let _ = conn.execute(
                    "UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1",
                    rusqlite::params![folder_id],
                );
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn unsnooze_mail(db: State<'_, Database>, mail_id: String) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        // Un-snoozing marks the mail unread again. If it was read, bump the
        // folder's unread_count so the badge matches before the next sync.
        let info: Option<(String, bool)> = conn.query_row(
            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
        ).ok();
        conn.execute(
            "UPDATE mails SET snoozed_until = '', is_read = 0 WHERE id = ?1",
            rusqlite::params![mail_id],
        )
        .map_err(|e| e.to_string())?;
        if let Some((folder_id, was_read)) = info {
            if was_read && !folder_id.is_empty() {
                let _ = conn.execute(
                    "UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1",
                    rusqlite::params![folder_id],
                );
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn list_snoozed_mails(db: State<'_, Database>, account_id: Option<String>) -> Result<Vec<Mail>, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(ref acc_id) = account_id {
            (
                "SELECT id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, '' as body_text, '' as body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, '') as flags, COALESCE(list_unsubscribe, '') as list_unsubscribe, COALESCE(is_pinned, 0) as is_pinned, COALESCE(snoozed_until, '') as snoozed_until, COALESCE(reply_to_json, '[]') as reply_to_json, COALESCE(\"references\", '') FROM mails WHERE snoozed_until != '' AND snoozed_until > datetime('now') AND account_id = ?1 ORDER BY snoozed_until ASC".to_string(),
                vec![Box::new(acc_id.clone()) as Box<dyn rusqlite::types::ToSql>],
            )
        } else {
            (
                "SELECT id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, '' as body_text, '' as body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, '') as flags, COALESCE(list_unsubscribe, '') as list_unsubscribe, COALESCE(is_pinned, 0) as is_pinned, COALESCE(snoozed_until, '') as snoozed_until, COALESCE(reply_to_json, '[]') as reply_to_json, COALESCE(\"references\", '') FROM mails WHERE snoozed_until != '' AND snoozed_until > datetime('now') ORDER BY snoozed_until ASC".to_string(),
                vec![],
            )
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let mails = stmt
            .query_map(param_refs.as_slice(), |row| {
                let to_json: String = row.get(8)?;
                let cc_json: String = row.get(9)?;
                let bcc_json: String = row.get(10)?;
                let flags_str: String = row.get(24)?;
                let unsub_str: String = row.get(25)?;
                let snoozed_str: String = row.get(27)?;
                let reply_to_json: String = row.get(28)?;

                Ok(Mail {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    folder_id: row.get(2)?,
                    message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    uid: row.get(4)?,
                    subject: row.get(5)?,
                    from: MailAddress {
                        name: row.get(6)?,
                        email: row.get(7)?,
                    },
                    to: parse_addresses(&to_json),
                    cc: parse_addresses(&cc_json),
                    bcc: parse_addresses(&bcc_json),
                    date: row.get(11)?,
                    snippet: row.get(12)?,
                    body_text: row.get(13)?,
                    body_html: row.get(14)?,
                    is_read: row.get::<_, i32>(15)? != 0,
                    is_starred: row.get::<_, i32>(16)? != 0,
                    is_flagged: row.get::<_, i32>(17)? != 0,
                    is_replied: row.get::<_, i32>(18)? != 0,
                    is_forwarded: row.get::<_, i32>(19)? != 0,
                    has_attachments: row.get::<_, i32>(20)? != 0,
                    thread_id: row.get(21)?,
                    in_reply_to: row.get(22)?,
                    references: row.get::<_, String>(29).unwrap_or_default(),
                    size_bytes: row.get(23)?,
                    flags: parse_flags(&flags_str),
                    list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                    reply_to: parse_addresses(&reply_to_json),
                    is_pinned: row.get::<_, i32>(26)? != 0,
                    snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(mails)
    })
}

#[tauri::command]
pub fn check_snoozed_mails(db: State<'_, Database>) -> Result<u32, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE mails SET snoozed_until = '', is_read = 0 WHERE snoozed_until != '' AND snoozed_until <= datetime('now')",
            [],
        )
        .map_err(|e| e.to_string())?;
        let count = conn.changes() as u32;
        Ok(count)
    })
}

#[tauri::command]
pub fn count_snoozed_mails(db: State<'_, Database>) -> Result<u32, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COUNT(*) FROM mails WHERE snoozed_until != '' AND snoozed_until > datetime('now')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub async fn toggle_read(db: State<'_, Database>, pool: State<'_, ImapPool>, mail_id: String) -> Result<bool, String> {
    let new_val: bool = {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE mails SET is_read = 1 - is_read WHERE id = ?1",
            rusqlite::params![mail_id],
        )
        .map_err(|e| e.to_string())?;
        let new_val = conn.query_row(
            "SELECT is_read FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| Ok(row.get::<_, i32>(0)? != 0),
        )
        .map_err(|e| format!("Mail not found: {}", e))?;

        let folder_id: Option<String> = conn.query_row(
            "SELECT folder_id FROM mails WHERE id = ?1", rusqlite::params![mail_id], |row| row.get(0)
        ).ok();
        if let Some(fid) = folder_id {
            if new_val {
                let _ = conn.execute(
                    "UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1",
                    rusqlite::params![fid],
                );
            } else {
                let _ = conn.execute(
                    "UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1",
                    rusqlite::params![fid],
                );
            }
        }
        new_val
    };

    // Sync to API in background (with pending_ops for reliability)
    if let Some((api_msg_id, account_id)) = get_api_message_id(&db, &mail_id) {
        let (api_type, provider, auth_type) = get_api_type(&db, &account_id);

        // Queue pending op before attempting server sync
        let payload = format!(
            r#"{{"value":{},"api_id":"{}","internet_id":"{}"}}"#,
            new_val, api_msg_id, get_internet_id_escaped(&db, &mail_id)
        );
        {
            let conn = db.lock_db();
            let _ = conn.execute(
                "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'set_read', ?3, 0)",
                rusqlite::params![account_id, mail_id, payload],
            );
        }
        let db_path = db.data_dir.join("prudii.db");
        let op_mail_id = mail_id.clone();

        match api_type {
            ApiType::Gmail => {
                let db_path = db_path.clone();
                let op_mail_id = op_mail_id.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = gmail::api::GmailClient::new(&credential);
                        match gmail::messages::toggle_read(&client, &api_msg_id, !new_val).await {
                            Ok(_) => delete_pending_op_bg(&db_path, &op_mail_id, "set_read"),
                            Err(e) => log::warn!("Gmail toggle_read failed (queued for retry): {}", e),
                        }
                    }
                });
            }
            ApiType::Outlook => {
                let db_path = db_path.clone();
                let op_mail_id = op_mail_id.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = outlook::api::OutlookClient::new(&credential);
                        match outlook::messages::toggle_read(&client, &api_msg_id, !new_val).await {
                            Ok(_) => delete_pending_op_bg(&db_path, &op_mail_id, "set_read"),
                            Err(e) => log::warn!("Outlook toggle_read failed (queued for retry): {}", e),
                        }
                    }
                });
            }
            ApiType::Imap => {
                let imap_info: Option<(String, u32, String, String, i32, String)> = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT m.account_id, m.uid, f.path, a.imap_host, a.imap_port, a.email \
                         FROM mails m JOIN folders f ON m.folder_id = f.id JOIN accounts a ON m.account_id = a.id \
                         WHERE m.id = ?1 AND m.uid IS NOT NULL",
                        rusqlite::params![mail_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                    ).ok()
                };
                if let Some((acct_id, uid, folder_path, imap_host, imap_port, email)) = imap_info {
                    if let Ok(credential) = credentials::resolve_credential(&acct_id, &auth_type, &provider).await {
                        if let Ok(mut session) = pool.get_session(&acct_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                            match imap::set_seen_flag_on_server(&mut session, &folder_path, uid, new_val).await {
                                Ok(_) => {
                                    pool.return_session(&acct_id, session).await;
                                    delete_pending_op_bg(&db_path, &op_mail_id, "set_read");
                                }
                                Err(e) => {
                                    log::warn!("IMAP toggle_read failed (queued for retry): {}", e);
                                    let _ = session.logout().await;
                                    pool.release(&acct_id);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(new_val)
}

#[tauri::command]
pub async fn mark_as_read(db: State<'_, Database>, pool: State<'_, ImapPool>, mail_id: String) -> Result<(), String> {
    if let Some((api_msg_id, account_id)) = get_api_message_id(&db, &mail_id) {
        let (api_type, provider, auth_type) = get_api_type(&db, &account_id);
        match api_type {
            ApiType::Gmail | ApiType::Outlook => {
                {
                    let conn = db.lock_db();
                    let was_unread: bool = conn.query_row(
                        "SELECT (is_read = 0) FROM mails WHERE id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get(0),
                    ).unwrap_or(false);

                    if !was_unread {
                        return Ok(());
                    }

                    let _ = conn.execute("UPDATE mails SET is_read = 1 WHERE id = ?1", rusqlite::params![mail_id]);
                    let folder_id: Option<String> = conn.query_row(
                        "SELECT folder_id FROM mails WHERE id = ?1", rusqlite::params![mail_id], |row| row.get(0)
                    ).ok();
                    if let Some(fid) = folder_id {
                        let _ = conn.execute(
                            "UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1",
                            rusqlite::params![fid],
                        );
                    }
                }

                // Queue pending op + sync to API in background
                let payload = format!(
                    r#"{{"value":true,"api_id":"{}","internet_id":"{}"}}"#,
                    api_msg_id, get_internet_id_escaped(&db, &mail_id)
                );
                {
                    let conn = db.lock_db();
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'set_read', ?3, 0)",
                        rusqlite::params![account_id, mail_id, payload],
                    );
                }
                let db_path = db.data_dir.join("prudii.db");
                let op_mail_id = mail_id.clone();
                let is_gmail = matches!(api_type, ApiType::Gmail);
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let ok = if is_gmail {
                            let client = gmail::api::GmailClient::new(&credential);
                            gmail::messages::mark_as_read(&client, &api_msg_id).await.is_ok()
                        } else {
                            let client = outlook::api::OutlookClient::new(&credential);
                            outlook::messages::mark_as_read(&client, &api_msg_id).await.is_ok()
                        };
                        if ok {
                            delete_pending_op_bg(&db_path, &op_mail_id, "set_read");
                        }
                    }
                });
                return Ok(());
            }
            ApiType::Imap => {}
        }
    }

    let update_info: Option<(String, String, u32, String, i32, String, String)> = {
        let conn = db.lock_db();

        let mail_info: Result<(bool, String, Option<u32>, String, String), _> = conn.query_row(
            "SELECT m.is_read, m.folder_id, m.uid, f.path, m.account_id FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get::<_, i32>(0)? != 0, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        );

        let (is_read, folder_id, uid_opt, folder_path, account_id) = mail_info
            .map_err(|e| format!("Mail not found: {}", e))?;

        if is_read {
            return Ok(());
        }

        conn.execute(
            "UPDATE mails SET is_read = 1 WHERE id = ?1",
            rusqlite::params![mail_id],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1",
            rusqlite::params![folder_id],
        )
        .map_err(|e| e.to_string())?;

        if let Some(uid) = uid_opt {
            let account: Result<(String, i32, String), _> = conn.query_row(
                "SELECT imap_host, imap_port, email FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            );
            if let Ok((imap_host, imap_port, email)) = account {
                Some((account_id, imap_host, uid, email, imap_port, folder_path, mail_id.clone()))
            } else {
                None
            }
        } else {
            None
        }
    };

    // Queue pending op + update on IMAP server
    if let Some((account_id, imap_host, uid, email, imap_port, folder_path, _)) = update_info {
        let payload = format!(r#"{{"value":true,"uid":{},"folder_path":"{}"}}"#, uid, folder_path.replace('\\', "\\\\").replace('"', "\\\""));
        {
            let conn = db.lock_db();
            let _ = conn.execute(
                "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'set_read', ?3, 0)",
                rusqlite::params![account_id, mail_id, payload],
            );
        }
        let db_path = db.data_dir.join("prudii.db");
        let op_mail_id = mail_id.clone();

        let account_auth: Option<(String, String)> = {
            let conn = db.lock_db();
            conn.query_row(
                "SELECT auth_type, provider FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok()
        };
        if let Some((auth_type, provider)) = account_auth {
            if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                if let Ok(mut session) = pool.get_session(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                    match imap::mark_as_read_on_server(&mut session, &folder_path, uid).await {
                        Ok(_) => {
                            pool.return_session(&account_id, session).await;
                            delete_pending_op_bg(&db_path, &op_mail_id, "set_read");
                        }
                        Err(_) => { let _ = session.logout().await; pool.release(&account_id); }
                    }
                }
            }
        }
    }

    Ok(())
}

enum TrashAction {
    MoveToTrash {
        account_id: String,
        imap_host: String,
        imap_port: i32,
        email: String,
        auth_type: String,
        provider: String,
        source_folder_path: String,
        trash_folder_id: String,
        trash_folder_path: String,
        uid: Option<u32>,
        is_gmail: bool,
        message_id: String,
    },
    PermanentDelete {
        account_id: String,
        imap_host: String,
        imap_port: i32,
        email: String,
        auth_type: String,
        provider: String,
        folder_path: String,
        trash_folder_path: Option<String>,
        uid: Option<u32>,
        message_id: String,
        mail_id: String,
    },
}

#[tauri::command]
pub async fn trash_mail(app: tauri::AppHandle, db: State<'_, Database>, mail_id: String) -> Result<(), String> {
    if let Some((api_msg_id, account_id)) = get_api_message_id(&db, &mail_id) {
        let (api_type, provider, auth_type) = get_api_type(&db, &account_id);
        match api_type {
            ApiType::Gmail => {
                // Check if already in trash → permanent delete
                let in_trash: bool = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT (f.folder_type = 'trash') FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get(0),
                    ).unwrap_or(false)
                };

                if in_trash {
                    let data_dir = db.data_dir.clone();
                    {
                        let conn = db.lock_db();
                        let (folder_id, is_read): (String, bool) = conn.query_row(
                            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                            rusqlite::params![mail_id],
                            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                        ).unwrap_or_default();
                        let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id = ?1", rusqlite::params![mail_id]);
                        let _ = conn.execute("DELETE FROM attachments WHERE mail_id = ?1", rusqlite::params![mail_id]);
                        let _ = conn.execute("DELETE FROM mails WHERE id = ?1", rusqlite::params![mail_id]);
                        if !folder_id.is_empty() {
                            let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![folder_id]);
                            if !is_read {
                                let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![folder_id]);
                            }
                        }
                    }
                    let mid = mail_id.clone();
                    tokio::spawn(async move { let _ = tokio::fs::remove_dir_all(data_dir.join("attachments").join(&mid)).await; });

                    // Retry-safe permanent delete: queue a pending op (the local row
                    // is already gone) and clear it once the server delete succeeds.
                    {
                        let conn = db.lock_db();
                        let payload = format!(r#"{{"api_id":"{}"}}"#, api_msg_id);
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'delete', ?3, 0)",
                            rusqlite::params![account_id, mail_id, payload],
                        );
                    }
                    let db_path = db.data_dir.join("prudii.db");
                    let op_mail_id = mail_id.clone();
                    let account_id_for_registry = account_id.clone();
                    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                        if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                            let client = gmail::api::GmailClient::new(&credential);
                            match gmail::messages::delete_message(&client, &api_msg_id).await {
                                Ok(_) => delete_pending_op_bg(&db_path, &op_mail_id, "delete"),
                                Err(e) => log::warn!("Gmail delete_message failed (queued for retry): {}", e),
                            }
                        }
                    });
                } else {
                    let trash_folder_id: Option<String> = {
                        let conn = db.lock_db();
                        conn.query_row(
                            "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'trash'",
                            rusqlite::params![account_id],
                            |row| row.get(0),
                        ).ok()
                    };
                    if let Some(trash_id) = trash_folder_id {
                        let conn = db.lock_db();
                        let (source_folder_id, is_read): (String, bool) = conn.query_row(
                            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                            rusqlite::params![mail_id],
                            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                        ).unwrap_or_default();
                        let _ = conn.execute(
                            "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                            rusqlite::params![trash_id, mail_id],
                        );
                        if !source_folder_id.is_empty() {
                            let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_folder_id]);
                            if !is_read {
                                let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_folder_id]);
                            }
                        }
                        let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![trash_id]);
                        if !is_read {
                            let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![trash_id]);
                        }
                    }

                    {
                        let conn = db.lock_db();
                        let payload = format!(r#"{{"api_id":"{}"}}"#, api_msg_id);
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'trash', ?3, 0)",
                            rusqlite::params![account_id, mail_id, payload],
                        );
                    }
                    let db_path = db.data_dir.join("prudii.db");
                    let op_mail_id = mail_id.clone();
                    let account_id_for_registry = account_id.clone();
                    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                        if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                            let client = gmail::api::GmailClient::new(&credential);
                            match gmail::messages::trash_message(&client, &api_msg_id).await {
                                Ok(_) => delete_pending_op_bg(&db_path, &op_mail_id, "trash"),
                                Err(e) => log::warn!("Gmail trash_message failed (queued for retry): {}", e),
                            }
                        }
                    });
                }
                return Ok(());
            }
            ApiType::Outlook => {
                let in_trash: bool = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT (f.folder_type = 'trash') FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get(0),
                    ).unwrap_or(false)
                };

                if in_trash {
                    let data_dir = db.data_dir.clone();
                    {
                        let conn = db.lock_db();
                        let (folder_id, is_read): (String, bool) = conn.query_row(
                            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                            rusqlite::params![mail_id],
                            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                        ).unwrap_or_default();
                        let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id = ?1", rusqlite::params![mail_id]);
                        let _ = conn.execute("DELETE FROM attachments WHERE mail_id = ?1", rusqlite::params![mail_id]);
                        let _ = conn.execute("DELETE FROM mails WHERE id = ?1", rusqlite::params![mail_id]);
                        if !folder_id.is_empty() {
                            let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![folder_id]);
                            if !is_read {
                                let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![folder_id]);
                            }
                        }
                    }
                    let mid = mail_id.clone();
                    tokio::spawn(async move { let _ = tokio::fs::remove_dir_all(data_dir.join("attachments").join(&mid)).await; });

                    // Retry-safe permanent delete: queue a pending op (the local row
                    // is already gone) and clear it once the server delete succeeds.
                    {
                        let conn = db.lock_db();
                        let payload = format!(r#"{{"api_id":"{}"}}"#, api_msg_id);
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'delete', ?3, 0)",
                            rusqlite::params![account_id, mail_id, payload],
                        );
                    }
                    let db_path = db.data_dir.join("prudii.db");
                    let op_mail_id = mail_id.clone();
                    let account_id_for_registry = account_id.clone();
                    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                        if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                            let client = outlook::api::OutlookClient::new(&credential);
                            match outlook::messages::delete_message(&client, &api_msg_id).await {
                                Ok(_) => delete_pending_op_bg(&db_path, &op_mail_id, "delete"),
                                Err(e) => log::warn!("Outlook delete_message failed (queued for retry): {}", e),
                            }
                        }
                    });
                } else {
                    let trash_folder_info: Option<(String, String)> = {
                        let conn = db.lock_db();
                        conn.query_row(
                            "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'trash'",
                            rusqlite::params![account_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        ).ok()
                    };

                    if let Some((trash_id, trash_path)) = trash_folder_info {
                        {
                            let conn = db.lock_db();
                            let (source_folder_id, is_read): (String, bool) = conn.query_row(
                                "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                                rusqlite::params![mail_id],
                                |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                            ).unwrap_or_default();
                            let _ = conn.execute(
                                "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                                rusqlite::params![trash_id, mail_id],
                            );
                            if !source_folder_id.is_empty() {
                                let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_folder_id]);
                                if !is_read {
                                    let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_folder_id]);
                                }
                            }
                            let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![trash_id]);
                            if !is_read {
                                let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![trash_id]);
                            }
                        }

                        {
                            let internet_id = get_internet_id_escaped(&db, &mail_id);
                            let conn = db.lock_db();
                            let payload = format!(
                                r#"{{"api_id":"{}","dest_folder":"{}","internet_id":"{}"}}"#,
                                api_msg_id, trash_path.replace('\\', "\\\\").replace('"', "\\\""), internet_id
                            );
                            let _ = conn.execute(
                                "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'trash', ?3, 0)",
                                rusqlite::params![account_id, mail_id, payload],
                            );
                        }
                        let db_path = db.data_dir.join("prudii.db");
                        let op_mail_id = mail_id.clone();
                        let account_id_for_registry = account_id.clone();
                        crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                            if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                                let client = outlook::api::OutlookClient::new(&credential);
                                match outlook::messages::trash_message(&client, &api_msg_id, &trash_path).await {
                                    Ok(new_id) => {
                                        // Graph IDs change on move — persist the new one
                                        update_mail_message_id_bg(&db_path, &op_mail_id, &new_id);
                                        delete_pending_op_bg(&db_path, &op_mail_id, "trash");
                                    }
                                    Err(e) => log::warn!("Outlook trash_message failed (queued for retry): {}", e),
                                }
                            }
                        });
                    }
                }
                return Ok(());
            }
            ApiType::Imap => {}
        }
    }

    // Gather all info needed in a scoped block (before any await)
    let action: Option<TrashAction> = {
        let conn = db.lock_db();

        // Find the mail info including UID (may be NULL after a previous move) and folder path
        let mail_info: Result<(String, String, Option<u32>, String, String), _> = conn.query_row(
            "SELECT m.account_id, m.folder_id, m.uid, f.path, COALESCE(m.message_id, '') FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<u32>>(2)?, row.get(3)?, row.get(4)?)),
        );

        let (account_id, current_folder_id, uid, source_folder_path, message_id) = mail_info
            .map_err(|e| format!("Mail not found: {}", e))?;

        let trash_info: Option<(String, String)> = conn
            .query_row(
                "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'trash'",
                rusqlite::params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        let already_in_trash = trash_info.as_ref().map(|(id, _)| id) == Some(&current_folder_id);

        let account: Result<(String, i32, String, String, String), _> = conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        );

        let (imap_host, imap_port, email, auth_type, provider) = account.map_err(|e| format!("Account not found: {}", e))?;

        log::info!(
            "trash_mail: mail_id={}, folder_id={}, uid={:?}, trash_info={:?}, already_in_trash={}",
            mail_id, current_folder_id, uid, trash_info, already_in_trash
        );

        if already_in_trash || trash_info.is_none() {
            let trash_path = trash_info.as_ref().map(|(_, p)| p.clone());
            Some(TrashAction::PermanentDelete {
                account_id,
                imap_host,
                imap_port,
                email,
                auth_type,
                provider,
                folder_path: source_folder_path,
                trash_folder_path: trash_path,
                uid,
                message_id,
                mail_id: mail_id.clone(),
            })
        } else if let Some((trash_folder_id, trash_folder_path)) = trash_info {
            let is_gmail = imap_host.contains("gmail.com") || imap_host.contains("googlemail.com");

            Some(TrashAction::MoveToTrash {
                account_id,
                imap_host,
                imap_port,
                email,
                auth_type,
                provider,
                source_folder_path,
                trash_folder_id,
                trash_folder_path,
                uid,
                is_gmail,
                message_id,
            })
        } else {
            None
        }
    };

    // Delete from local DB FIRST (instant), then sync to IMAP in background.
    // This ensures navigating away and back never shows stale data.
    match action {
        Some(TrashAction::MoveToTrash {
            account_id,
            imap_host,
            imap_port,
            email,
            auth_type,
            provider,
            source_folder_path,
            trash_folder_id,
            trash_folder_path,
            uid,
            is_gmail,
            message_id,
        }) => {
            // Move locally: update folder_id to trash and clear uid (new folder = new uid).
            // Mail disappears from inbox and appears in trash instantly.
            // When trash folder syncs later, the uid=NULL row is claimed via message_id dedup.
            {
                let conn = db.lock_db();
                let (source_folder_id, is_read): (String, bool) = conn.query_row(
                    "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                    rusqlite::params![mail_id],
                    |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                ).unwrap_or_default();
                conn.execute(
                    "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                    rusqlite::params![trash_folder_id, mail_id],
                ).map_err(|e| e.to_string())?;
                if !source_folder_id.is_empty() {
                    let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_folder_id]);
                    if !is_read {
                        let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_folder_id]);
                    }
                }
                let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![trash_folder_id]);
                if !is_read {
                    let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![trash_folder_id]);
                }
            }

            let payload = format!(
                r#"{{"uid":{},"source_folder":"{}","dest_folder":"{}","message_id":"{}","is_gmail":{}}}"#,
                uid.map(|u| u.to_string()).unwrap_or_else(|| "null".to_string()),
                source_folder_path.replace('\\', "\\\\").replace('"', "\\\""),
                trash_folder_path.replace('\\', "\\\\").replace('"', "\\\""),
                message_id.replace('\\', "\\\\").replace('"', "\\\""),
                is_gmail,
            );
            {
                let conn = db.lock_db();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'trash', ?3, 0)",
                    rusqlite::params![account_id, mail_id, payload],
                );
            }
            let db_path = db.data_dir.join("prudii.db");
            let op_mail_id = mail_id.clone();

            // IMAP operation in background — don't block the UI
            let app = app.clone();
            let account_id_for_registry = account_id.clone();
            crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                let pool = app.state::<ImapPool>();
                let credential = match credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                    Ok(p) => p,
                    Err(e) => { log::error!("MoveToTrash: no credentials: {}", e); return; }
                };

                let mut session = match pool.get_session(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                    Ok(s) => s,
                    Err(e) => { log::error!("MoveToTrash: IMAP connection failed: {}", e); return; }
                };

                // Resolve UID: use stored UID, or search by Message-ID if NULL/stale
                let resolved_uid = if let Some(u) = uid {
                    Some(u)
                } else if !message_id.is_empty() {
                    log::info!("MoveToTrash: uid=None, resolving via Message-ID in '{}'", source_folder_path);
                    imap::search_uid_by_message_id(&mut session, &source_folder_path, &message_id)
                        .await
                        .unwrap_or(None)
                } else {
                    None
                };

                log::info!(
                    "MoveToTrash: resolved_uid={:?}, source='{}', trash='{}'",
                    resolved_uid, source_folder_path, trash_folder_path
                );

                if let Some(real_uid) = resolved_uid {
                    let op_result = if is_gmail {
                        imap::gmail_trash_mail(&mut session, &source_folder_path, &trash_folder_path, real_uid, &message_id).await
                    } else {
                        imap::move_mail_on_server(&mut session, &source_folder_path, &trash_folder_path, real_uid, false, false).await
                    };

                    match op_result {
                        Ok(_) => {
                            pool.return_session(&account_id, session).await;
                            delete_pending_op_bg(&db_path, &op_mail_id, "trash");
                        }
                        Err(e) => {
                            log::error!("MoveToTrash: IMAP failed (queued for retry): {}", e);
                            let _ = session.logout().await;
                            pool.release(&account_id);
                        }
                    }
                } else {
                    log::warn!("MoveToTrash: Could not resolve UID for mail — server operation skipped");
                    pool.return_session(&account_id, session).await;
                }
            });
        }
        Some(TrashAction::PermanentDelete {
            account_id,
            imap_host,
            imap_port,
            email,
            auth_type,
            provider,
            folder_path,
            trash_folder_path,
            uid,
            message_id,
            mail_id,
        }) => {
            // Delete locally FIRST so DB queries never return stale data
            let data_dir = db.data_dir.clone();
            {
                let conn = db.lock_db();
                let (del_folder_id, del_is_read): (String, bool) = conn.query_row(
                    "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                    rusqlite::params![mail_id],
                    |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                ).unwrap_or_default();
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                let tx_result = (|| -> Result<(), rusqlite::Error> {
                    conn.execute("DELETE FROM mails_fts WHERE mail_id = ?1", rusqlite::params![mail_id])?;
                    conn.execute("DELETE FROM attachments WHERE mail_id = ?1", rusqlite::params![mail_id])?;
                    conn.execute("DELETE FROM mails WHERE id = ?1", rusqlite::params![mail_id])?;
                    if !del_folder_id.is_empty() {
                        conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![del_folder_id])?;
                        if !del_is_read {
                            conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![del_folder_id])?;
                        }
                    }
                    Ok(())
                })();
                match tx_result {
                    Ok(_) => {
                        let _ = conn.execute_batch("COMMIT");
                        let attach_dir = data_dir.join("attachments").join(&mail_id);
                        let _ = std::fs::remove_dir_all(&attach_dir);
                    }
                    Err(e) => {
                        log::error!("Failed to delete mail locally: {}", e);
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(format!("Failed to delete mail from local database: {}", e));
                    }
                }
            }

            // Queue a pending op so the server-side permanent delete is retried
            // if it fails. The local row is already gone, so everything the retry
            // needs is stashed in the payload.
            let is_gmail = imap_host.contains("gmail.com") || imap_host.contains("googlemail.com");
            {
                let conn = db.lock_db();
                let payload = serde_json::json!({
                    "uid": uid,
                    "folder_path": folder_path.clone(),
                    "message_id": message_id.clone(),
                    "trash_folder_path": trash_folder_path.clone(),
                    "is_gmail": is_gmail,
                }).to_string();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'delete', ?3, 0)",
                    rusqlite::params![account_id, mail_id, payload],
                );
            }

            let app = app.clone();
            let db_path = db.data_dir.join("prudii.db");
            let op_mail_id = mail_id.clone();
            let account_id_for_registry = account_id.clone();
            crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                let pool = app.state::<ImapPool>();
                let credential = match credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                    Ok(p) => p,
                    Err(e) => { log::error!("PermanentDelete: no credentials: {}", e); return; }
                };

                let mut session = match pool.get_session(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                    Ok(s) => s,
                    Err(e) => { log::error!("PermanentDelete: IMAP connection failed: {}", e); return; }
                };

                match imap::permanent_delete_on_server(
                    &mut session, &folder_path, uid, &message_id,
                    trash_folder_path.as_deref(), is_gmail,
                ).await {
                    Ok(_) => {
                        pool.return_session(&account_id, session).await;
                        delete_pending_op_bg(&db_path, &op_mail_id, "delete");
                    }
                    Err(e) => {
                        log::warn!("PermanentDelete server op failed (queued for retry): {}", e);
                        let _ = session.logout().await;
                        pool.release(&account_id);
                    }
                }
            });
        }
        None => {}
    }

    Ok(())
}

/// Move a mail to a different folder (both locally and on server).
/// IMAP operation runs first; local DB is only updated on success.
#[tauri::command]
pub async fn move_mail(
    db: State<'_, Database>,
    pool: State<'_, ImapPool>,
    mail_id: String,
    dest_folder_id: String,
) -> Result<(), String> {
    if let Some((api_msg_id, account_id)) = get_api_message_id(&db, &mail_id) {
        let (api_type, provider, auth_type) = get_api_type(&db, &account_id);
        match api_type {
            ApiType::Gmail => {
                let (source_label, dest_label) = {
                    let conn = db.lock_db();
                    let source: String = conn.query_row(
                        "SELECT f.path FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
                        rusqlite::params![mail_id],
                        |row| row.get(0),
                    ).map_err(|e| format!("Mail not found: {}", e))?;
                    let dest: String = conn.query_row(
                        "SELECT path FROM folders WHERE id = ?1",
                        rusqlite::params![dest_folder_id],
                        |row| row.get(0),
                    ).map_err(|e| format!("Folder not found: {}", e))?;
                    (source, dest)
                };

                {
                    let conn = db.lock_db();
                    let (source_fid, is_read): (String, bool) = conn.query_row(
                        "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                        rusqlite::params![mail_id],
                        |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                    ).unwrap_or_default();
                    let _ = conn.execute(
                        "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                        rusqlite::params![dest_folder_id, mail_id],
                    );
                    if !source_fid.is_empty() {
                        let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                        if !is_read {
                            let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                        }
                    }
                    let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![dest_folder_id]);
                    if !is_read {
                        let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![dest_folder_id]);
                    }
                }

                let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
                    .await
                    .map_err(|e| format!("Credentials: {}", e))?;
                let client = gmail::api::GmailClient::new(&credential);
                gmail::messages::move_message(&client, &api_msg_id, &dest_label, &source_label)
                    .await
                    .map_err(|e| format!("Gmail move failed: {}", e))?;

                return Ok(());
            }
            ApiType::Outlook => {
                let dest_path: String = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT path FROM folders WHERE id = ?1",
                        rusqlite::params![dest_folder_id],
                        |row| row.get(0),
                    ).map_err(|e| format!("Folder not found: {}", e))?
                };

                {
                    let conn = db.lock_db();
                    let (source_fid, is_read): (String, bool) = conn.query_row(
                        "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                        rusqlite::params![mail_id],
                        |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                    ).unwrap_or_default();
                    let _ = conn.execute(
                        "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                        rusqlite::params![dest_folder_id, mail_id],
                    );
                    if !source_fid.is_empty() {
                        let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                        if !is_read {
                            let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                        }
                    }
                    let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![dest_folder_id]);
                    if !is_read {
                        let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![dest_folder_id]);
                    }
                }

                let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
                    .await
                    .map_err(|e| format!("Credentials: {}", e))?;
                let client = outlook::api::OutlookClient::new(&credential);
                let new_graph_id = outlook::messages::move_message(&client, &api_msg_id, &dest_path)
                    .await
                    .map_err(|e| format!("Outlook move failed: {}", e))?;
                // Graph IDs change on move — persist the new one
                {
                    let conn = db.lock_db();
                    let _ = conn.execute(
                        "UPDATE mails SET message_id = ?1 WHERE id = ?2",
                        rusqlite::params![new_graph_id, mail_id],
                    );
                }

                return Ok(());
            }
            ApiType::Imap => {}
        }
    }

    // Gather info needed for the move (read-only DB access).
    // `uid` is Option<u32> because a prior move/archive may have cleared it locally
    // before the next sync re-learned the new UID. We fall back to a Message-ID
    // search on the server when missing.
    let (account_id, source_folder_path, dest_folder_path, uid_opt, message_id, imap_host, imap_port, email, auth_type, provider) = {
        let conn = db.lock_db();

        let (account_id, source_folder_path, uid_opt, message_id): (String, String, Option<u32>, String) = conn.query_row(
            "SELECT m.account_id, f.path, m.uid, COALESCE(m.message_id, '') FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<u32>>(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("Mail not found: {}", e))?;

        let dest_folder_path: String = conn
            .query_row(
                "SELECT path FROM folders WHERE id = ?1",
                rusqlite::params![dest_folder_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Destination folder not found: {}", e))?;

        let (imap_host, imap_port, email, auth_type, provider): (String, i32, String, String, String) = conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Account not found: {}", e))?;

        (account_id, source_folder_path, dest_folder_path, uid_opt, message_id, imap_host, imap_port, email, auth_type, provider)
    };

    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("No credentials: {}", e))?;

    let mut session = pool.get_session(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type)
        .await
        .map_err(|e| format!("IMAP connection failed: {}", e))?;

    // Resolve UID: prefer the cached value, otherwise search the source folder by Message-ID.
    let resolved_uid = match uid_opt {
        Some(u) => Some(u),
        None if !message_id.is_empty() => {
            match imap::search_uid_by_message_id(&mut session, &source_folder_path, &message_id).await {
                Ok(found) => found,
                Err(e) => {
                    log::warn!("move_mail: UID search by Message-ID failed: {}", e);
                    None
                }
            }
        }
        None => None,
    };

    let uid = match resolved_uid {
        Some(u) => u,
        None => {
            let _ = session.logout().await;
            pool.release(&account_id);
            return Err("Mail UID is not yet synced — please wait for the next sync to complete and try again.".to_string());
        }
    };

    let result = imap::move_mail_on_server(&mut session, &source_folder_path, &dest_folder_path, uid, false, false).await;

    match &result {
        Ok(_) => pool.return_session(&account_id, session).await,
        Err(_) => { let _ = session.logout().await; pool.release(&account_id); }
    }

    result.map_err(|e| format!("Failed to move mail on server: {}", e))?;

    // IMAP succeeded — delete local copy. Next sync re-inserts with correct UID.
    let conn = db.lock_db();
    let (source_fid, is_read): (String, bool) = conn.query_row(
        "SELECT folder_id, is_read FROM mails WHERE id = ?1",
        rusqlite::params![mail_id],
        |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
    ).unwrap_or_default();
    let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id = ?1", rusqlite::params![mail_id]);
    let _ = conn.execute("DELETE FROM attachments WHERE mail_id = ?1", rusqlite::params![mail_id]);
    conn.execute("DELETE FROM mails WHERE id = ?1", rusqlite::params![mail_id])
        .map_err(|e| e.to_string())?;
    // Update source folder counts (dest will be updated by next sync)
    if !source_fid.is_empty() {
        let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
        if !is_read {
            let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
        }
    }

    Ok(())
}

/// Get all mails in the same thread as the given mail.
/// Thread detection uses message_id, in_reply_to, and references headers.
#[tauri::command]
pub fn get_thread_mails(db: State<'_, Database>, mail_id: String) -> Result<Vec<Mail>, String> {
    let conn = db.lock_db();

    fn query_single_mail(conn: &rusqlite::Connection, mail_id: &str) -> Result<Mail, String> {
        conn.query_row(
            "SELECT id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, '') as flags, COALESCE(list_unsubscribe, '') as list_unsubscribe, COALESCE(is_pinned, 0) as is_pinned, COALESCE(snoozed_until, '') as snoozed_until, COALESCE(reply_to_json, '[]') as reply_to_json, COALESCE(\"references\", '') FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| {
                let to_json: String = row.get(8)?;
                let cc_json: String = row.get(9)?;
                let bcc_json: String = row.get(10)?;
                let flags_str: String = row.get(24)?;
                let unsub_str: String = row.get(25)?;
                let snoozed_str: String = row.get(27)?;
                let reply_to_json: String = row.get(28)?;

                Ok(Mail {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    folder_id: row.get(2)?,
                    message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    uid: row.get(4)?,
                    subject: row.get(5)?,
                    from: MailAddress {
                        name: row.get(6)?,
                        email: row.get(7)?,
                    },
                    to: parse_addresses(&to_json),
                    cc: parse_addresses(&cc_json),
                    bcc: parse_addresses(&bcc_json),
                    date: row.get(11)?,
                    snippet: row.get(12)?,
                    body_text: row.get(13)?,
                    body_html: row.get(14)?,
                    is_read: row.get::<_, i32>(15)? != 0,
                    is_starred: row.get::<_, i32>(16)? != 0,
                    is_flagged: row.get::<_, i32>(17)? != 0,
                    is_replied: row.get::<_, i32>(18)? != 0,
                    is_forwarded: row.get::<_, i32>(19)? != 0,
                    has_attachments: row.get::<_, i32>(20)? != 0,
                    thread_id: row.get(21)?,
                    in_reply_to: row.get(22)?,
                    references: row.get::<_, String>(29).unwrap_or_default(),
                    size_bytes: row.get(23)?,
                    flags: parse_flags(&flags_str),
                    list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                    reply_to: parse_addresses(&reply_to_json),
                    is_pinned: row.get::<_, i32>(26)? != 0,
                    snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
                })
            },
        )
        .map_err(|e| format!("Mail not found: {}", e))
    }

    let (message_id, in_reply_to, references, account_id): (Option<String>, Option<String>, Option<String>, String) = conn
        .query_row(
            "SELECT message_id, in_reply_to, thread_id, account_id FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("Mail not found: {}", e))?;

    // Build a list of all related message IDs (always strip angle brackets for consistency)
    let mut related_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut related_ids: Vec<String> = Vec::new();

    fn strip_brackets(s: &str) -> String {
        s.trim().trim_matches(|c| c == '<' || c == '>').to_string()
    }

    if let Some(ref mid) = message_id {
        let clean = strip_brackets(mid);
        if !clean.is_empty() && related_set.insert(clean.clone()) {
            related_ids.push(clean);
        }
    }
    if let Some(ref reply_to) = in_reply_to {
        let clean = strip_brackets(reply_to);
        if !clean.is_empty() && related_set.insert(clean.clone()) {
            related_ids.push(clean);
        }
    }
    // References/thread_id: may contain space-separated message IDs
    if let Some(ref refs) = references {
        for r in refs.split_whitespace() {
            let clean = strip_brackets(r);
            if !clean.is_empty() && related_set.insert(clean.clone()) {
                related_ids.push(clean);
            }
        }
    }

    if related_ids.is_empty() {
        return query_single_mail(&conn, &mail_id).map(|m| vec![m]);
    }

    let placeholders: Vec<String> = related_ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
    let placeholder_str = placeholders.join(", ");

    // Match message_id, in_reply_to, and thread_id within the same account.
    // Also match with angle brackets stripped (REPLACE) for cross-format compatibility.
    // Use GROUP BY with NULLIF to properly handle empty message_id strings.
    let account_param_idx = related_ids.len() + 1;
    let simple_query = format!(
        "SELECT m.id, m.account_id, m.folder_id, m.message_id, m.uid, m.subject, m.from_name, m.from_email, m.to_json, m.cc_json, m.bcc_json, m.date, m.snippet, m.body_text, m.body_html, m.is_read, m.is_starred, m.is_flagged, m.is_replied, m.is_forwarded, m.has_attachments, m.thread_id, m.in_reply_to, m.size_bytes, COALESCE(m.flags, '') as flags, COALESCE(m.list_unsubscribe, '') as list_unsubscribe, COALESCE(m.is_pinned, 0) as is_pinned, COALESCE(m.snoozed_until, '') as snoozed_until, COALESCE(m.reply_to_json, '[]') as reply_to_json, COALESCE(m.\"references\", '')
         FROM mails m
         WHERE m.account_id = ?{1}
           AND (REPLACE(REPLACE(m.message_id, '<', ''), '>', '') IN ({0})
            OR REPLACE(REPLACE(COALESCE(m.in_reply_to, ''), '<', ''), '>', '') IN ({0})
            OR REPLACE(REPLACE(COALESCE(m.thread_id, ''), '<', ''), '>', '') IN ({0}))
           AND m.rowid IN (SELECT MIN(rowid) FROM mails WHERE account_id = ?{1} GROUP BY COALESCE(NULLIF(message_id, ''), id))
         ORDER BY m.date ASC",
        placeholder_str, account_param_idx
    );

    let mut stmt = conn.prepare(&simple_query).map_err(|e| e.to_string())?;

    let mut params: Vec<&dyn rusqlite::ToSql> = related_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    params.push(&account_id);

    let mails = stmt
        .query_map(params.as_slice(), |row| {
            let to_json: String = row.get(8)?;
            let cc_json: String = row.get(9)?;
            let bcc_json: String = row.get(10)?;
            let flags_str: String = row.get(24)?;
            let unsub_str: String = row.get(25)?;
            let snoozed_str: String = row.get(27)?;
            let reply_to_json: String = row.get(28)?;

            Ok(Mail {
                id: row.get(0)?,
                account_id: row.get(1)?,
                folder_id: row.get(2)?,
                message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                uid: row.get(4)?,
                subject: row.get(5)?,
                from: MailAddress {
                    name: row.get(6)?,
                    email: row.get(7)?,
                },
                to: parse_addresses(&to_json),
                cc: parse_addresses(&cc_json),
                bcc: parse_addresses(&bcc_json),
                date: row.get(11)?,
                snippet: row.get(12)?,
                body_text: row.get(13)?,
                body_html: row.get(14)?,
                is_read: row.get::<_, i32>(15)? != 0,
                is_starred: row.get::<_, i32>(16)? != 0,
                is_flagged: row.get::<_, i32>(17)? != 0,
                is_replied: row.get::<_, i32>(18)? != 0,
                is_forwarded: row.get::<_, i32>(19)? != 0,
                has_attachments: row.get::<_, i32>(20)? != 0,
                thread_id: row.get(21)?,
                in_reply_to: row.get(22)?,
                references: row.get::<_, String>(29).unwrap_or_default(),
                size_bytes: row.get(23)?,
                flags: parse_flags(&flags_str),
                list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                reply_to: parse_addresses(&reply_to_json),
                is_pinned: row.get::<_, i32>(26)? != 0,
                snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // If we found no mails (shouldn't happen), return the single mail
    if mails.is_empty() {
        return query_single_mail(&conn, &mail_id).map(|m| vec![m]);
    }

    let mut result = dedup_mails(mails);

    // Safety net: ensure the clicked mail is always included in the thread
    if !result.iter().any(|m| m.id == mail_id) {
        if let Ok(clicked_mail) = query_single_mail(&conn, &mail_id) {
            result.push(clicked_mail);
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn archive_mail(app: tauri::AppHandle, db: State<'_, Database>, mail_id: String) -> Result<(), String> {
    if let Some((api_msg_id, account_id)) = get_api_message_id(&db, &mail_id) {
        let (api_type, provider, auth_type) = get_api_type(&db, &account_id);
        match api_type {
            ApiType::Gmail => {
                let archive_folder_id: Option<String> = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'archive'",
                        rusqlite::params![account_id],
                        |row| row.get(0),
                    ).ok()
                };
                if let Some(ref archive_id) = archive_folder_id {
                    let conn = db.lock_db();
                    let (source_fid, is_read): (String, bool) = conn.query_row(
                        "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                        rusqlite::params![mail_id],
                        |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                    ).unwrap_or_default();
                    let _ = conn.execute(
                        "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                        rusqlite::params![archive_id, mail_id],
                    );
                    if !source_fid.is_empty() {
                        let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                        if !is_read {
                            let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                        }
                    }
                    let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![archive_id]);
                    if !is_read {
                        let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![archive_id]);
                    }
                }

                {
                    let conn = db.lock_db();
                    let payload = format!(r#"{{"api_id":"{}"}}"#, api_msg_id);
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'archive', ?3, 0)",
                        rusqlite::params![account_id, mail_id, payload],
                    );
                }
                let db_path = db.data_dir.join("prudii.db");
                let op_mail_id = mail_id.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = gmail::api::GmailClient::new(&credential);
                        match gmail::messages::archive_message(&client, &api_msg_id).await {
                            Ok(_) => delete_pending_op_bg(&db_path, &op_mail_id, "archive"),
                            Err(e) => log::warn!("Gmail archive failed (queued for retry): {}", e),
                        }
                    }
                });
                return Ok(());
            }
            ApiType::Outlook => {
                let archive_info: Option<(String, String)> = {
                    let conn = db.lock_db();
                    conn.query_row(
                        "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'archive'",
                        rusqlite::params![account_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    ).ok()
                };

                if let Some((archive_id, archive_path)) = archive_info {
                    {
                        let conn = db.lock_db();
                        let (source_fid, is_read): (String, bool) = conn.query_row(
                            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
                            rusqlite::params![mail_id],
                            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
                        ).unwrap_or_default();
                        let _ = conn.execute(
                            "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
                            rusqlite::params![archive_id, mail_id],
                        );
                        if !source_fid.is_empty() {
                            let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                            if !is_read {
                                let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
                            }
                        }
                        let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![archive_id]);
                        if !is_read {
                            let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![archive_id]);
                        }
                    }

                    {
                        let internet_id = get_internet_id_escaped(&db, &mail_id);
                        let conn = db.lock_db();
                        let payload = format!(
                            r#"{{"api_id":"{}","dest_folder":"{}","internet_id":"{}"}}"#,
                            api_msg_id, archive_path.replace('\\', "\\\\").replace('"', "\\\""), internet_id
                        );
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'archive', ?3, 0)",
                            rusqlite::params![account_id, mail_id, payload],
                        );
                    }
                    let db_path = db.data_dir.join("prudii.db");
                    let op_mail_id = mail_id.clone();
                    let account_id_for_registry = account_id.clone();
                    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                        if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                            let client = outlook::api::OutlookClient::new(&credential);
                            match outlook::messages::archive_message(&client, &api_msg_id, &archive_path).await {
                                Ok(new_id) => {
                                    // Graph IDs change on move — persist the new one
                                    update_mail_message_id_bg(&db_path, &op_mail_id, &new_id);
                                    delete_pending_op_bg(&db_path, &op_mail_id, "archive");
                                }
                                Err(e) => log::warn!("Outlook archive failed (queued for retry): {}", e),
                            }
                        }
                    });
                }
                return Ok(());
            }
            ApiType::Imap => {}
        }
    }

    // Read all info needed from DB.
    // `uid` may be NULL locally if a previous move cleared it before the next sync
    // re-learned the new UID — keep it optional and resolve via Message-ID later.
    let (account_id, source_folder_path, archive_folder_id, archive_folder_path, uid_opt, message_id, imap_host, imap_port, email, auth_type, provider) = {
        let conn = db.lock_db();

        let (account_id, source_folder_path, uid_opt, message_id): (String, String, Option<u32>, String) = conn.query_row(
            "SELECT m.account_id, f.path, m.uid, COALESCE(m.message_id, '') FROM mails m JOIN folders f ON m.folder_id = f.id WHERE m.id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Option<u32>>(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("Mail not found: {}", e))?;

        let (archive_folder_id, archive_folder_path): (String, String) = conn
            .query_row(
                "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'archive'",
                rusqlite::params![account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "No archive folder found for this account".to_string())?;

        let (imap_host, imap_port, email, auth_type, provider): (String, i32, String, String, String) = conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Account not found: {}", e))?;

        (account_id, source_folder_path, archive_folder_id, archive_folder_path, uid_opt, message_id, imap_host, imap_port, email, auth_type, provider)
    };

    // If the local UID is missing (cleared by a previous move that hasn't fully synced),
    // refuse early so we don't queue a pending op without a usable UID. The user can
    // retry once the next sync has populated the row.
    let uid = match uid_opt {
        Some(u) => u,
        None => {
            if !message_id.is_empty() {
                log::info!("archive_mail: uid is NULL for mail {} (message_id={}) — waiting for sync", mail_id, message_id);
            }
            return Err("Mail UID is not yet synced — please wait for the next sync to complete and try again.".to_string());
        }
    };

    {
        let conn = db.lock_db();
        let (source_fid, is_read): (String, bool) = conn.query_row(
            "SELECT folder_id, is_read FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
        ).unwrap_or_default();
        conn.execute(
            "UPDATE mails SET folder_id = ?1, uid = NULL WHERE id = ?2",
            rusqlite::params![archive_folder_id, mail_id],
        ).map_err(|e| e.to_string())?;
        if !source_fid.is_empty() {
            let _ = conn.execute("UPDATE folders SET total_count = MAX(0, total_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
            if !is_read {
                let _ = conn.execute("UPDATE folders SET unread_count = MAX(0, unread_count - 1) WHERE id = ?1", rusqlite::params![source_fid]);
            }
        }
        let _ = conn.execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![archive_folder_id]);
        if !is_read {
            let _ = conn.execute("UPDATE folders SET unread_count = unread_count + 1 WHERE id = ?1", rusqlite::params![archive_folder_id]);
        }
    }

    {
        let is_gmail_imap = imap_host.contains("gmail.com") || imap_host.contains("googlemail.com");
        let payload = format!(
            r#"{{"uid":{},"source_folder":"{}","dest_folder":"{}","is_gmail":{}}}"#,
            uid,
            source_folder_path.replace('\\', "\\\\").replace('"', "\\\""),
            archive_folder_path.replace('\\', "\\\\").replace('"', "\\\""),
            is_gmail_imap,
        );
        let conn = db.lock_db();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'archive', ?3, 0)",
            rusqlite::params![account_id, mail_id, payload],
        );
    }
    let db_path = db.data_dir.join("prudii.db");
    let op_mail_id = mail_id.clone();

    let app = app.clone();
    let account_id_for_registry = account_id.clone();
    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
        let pool = app.state::<ImapPool>();
        let credential = match credentials::resolve_credential(&account_id, &auth_type, &provider).await {
            Ok(p) => p,
            Err(e) => { log::error!("Archive: no credentials: {}", e); return; }
        };

        let mut session = match pool.get_session(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
            Ok(s) => s,
            Err(e) => { log::error!("Archive: IMAP connection failed: {}", e); return; }
        };

        // Gmail: mails are already in All Mail, so archiving = just remove from Inbox (skip copy)
        let is_gmail = imap_host.contains("gmail.com") || imap_host.contains("googlemail.com");
        let skip_copy = is_gmail && source_folder_path.eq_ignore_ascii_case("INBOX");

        let result = imap::move_mail_on_server(&mut session, &source_folder_path, &archive_folder_path, uid, skip_copy, false).await;

        match &result {
            Ok(_) => {
                pool.return_session(&account_id, session).await;
                delete_pending_op_bg(&db_path, &op_mail_id, "archive");
            }
            Err(e) => {
                log::error!("Archive: IMAP failed (queued for retry): {}", e);
                let _ = session.logout().await;
                pool.release(&account_id);
            }
        }
    });

    Ok(())
}

/// Set color flags on a mail. flags is a list of color names (e.g., ["red", "blue"])
#[tauri::command]
pub fn set_mail_flags(db: State<'_, Database>, mail_id: String, flags: Vec<String>) -> Result<Vec<String>, String> {
    let conn = db.lock_db();
    let flags_str = flags.join(",");

    conn.execute(
        "UPDATE mails SET flags = ?1 WHERE id = ?2",
        rusqlite::params![flags_str, mail_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(flags)
}

#[tauri::command]
pub fn toggle_mail_flag(db: State<'_, Database>, mail_id: String, flag: String) -> Result<Vec<String>, String> {
    let conn = db.lock_db();

    let current_flags: String = conn
        .query_row(
            "SELECT COALESCE(flags, '') FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Mail not found: {}", e))?;

    let mut flags: Vec<String> = parse_flags(&current_flags);

    if flags.contains(&flag) {
        flags.retain(|f| f != &flag);
    } else {
        flags.push(flag);
    }

    let flags_str = flags.join(",");
    conn.execute(
        "UPDATE mails SET flags = ?1 WHERE id = ?2",
        rusqlite::params![flags_str, mail_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(flags)
}

/// List all mails across all accounts for a given folder type (inbox, sent, trash, etc.)
#[tauri::command]
pub fn list_combined_folder_mails(db: State<'_, Database>, folder_type: String, limit: Option<u32>, offset: Option<u32>, folder_filter: Option<String>) -> Result<Vec<Mail>, String> {
    super::catch_panic(|| {
    let limit = limit.unwrap_or(500).min(2000);
    let offset = offset.unwrap_or(0);
    let extra = filter_clause(&folder_filter, "m.");
    let conn = db.lock_db();
    let sql = format!("SELECT m.id, m.account_id, m.folder_id, m.message_id, m.uid, m.subject, m.from_name, m.from_email, m.to_json, m.cc_json, m.bcc_json, m.date, m.snippet, '' as body_text, '' as body_html, m.is_read, m.is_starred, m.is_flagged, m.is_replied, m.is_forwarded, m.has_attachments, m.thread_id, m.in_reply_to, m.size_bytes, COALESCE(m.flags, '') as flags, COALESCE(m.list_unsubscribe, '') as list_unsubscribe, COALESCE(m.is_pinned, 0) as is_pinned, COALESCE(m.snoozed_until, '') as snoozed_until, COALESCE(m.reply_to_json, '[]') as reply_to_json, COALESCE(m.\"references\", '')
             FROM mails m
             JOIN folders f ON m.folder_id = f.id
             WHERE f.folder_type = ?1 AND (m.snoozed_until IS NULL OR m.snoozed_until = '' OR m.snoozed_until <= datetime('now')){}
             ORDER BY m.is_pinned DESC, m.date DESC
             LIMIT ?2 OFFSET ?3", extra);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;

    let mails = stmt
        .query_map(rusqlite::params![folder_type, limit, offset], |row| {
            let to_json: String = row.get(8)?;
            let cc_json: String = row.get(9)?;
            let bcc_json: String = row.get(10)?;
            let flags_str: String = row.get(24)?;
            let unsub_str: String = row.get(25)?;
            let snoozed_str: String = row.get(27)?;
            let reply_to_json: String = row.get(28)?;

            Ok(Mail {
                id: row.get(0)?,
                account_id: row.get(1)?,
                folder_id: row.get(2)?,
                message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                uid: row.get(4)?,
                subject: row.get(5)?,
                from: MailAddress {
                    name: row.get(6)?,
                    email: row.get(7)?,
                },
                to: parse_addresses(&to_json),
                cc: parse_addresses(&cc_json),
                bcc: parse_addresses(&bcc_json),
                date: row.get(11)?,
                snippet: row.get(12)?,
                body_text: row.get(13)?,
                body_html: row.get(14)?,
                is_read: row.get::<_, i32>(15)? != 0,
                is_starred: row.get::<_, i32>(16)? != 0,
                is_flagged: row.get::<_, i32>(17)? != 0,
                is_replied: row.get::<_, i32>(18)? != 0,
                is_forwarded: row.get::<_, i32>(19)? != 0,
                has_attachments: row.get::<_, i32>(20)? != 0,
                thread_id: row.get(21)?,
                in_reply_to: row.get(22)?,
                references: row.get::<_, String>(29).unwrap_or_default(),
                size_bytes: row.get(23)?,
                flags: parse_flags(&flags_str),
                list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
                reply_to: parse_addresses(&reply_to_json),
                is_pinned: row.get::<_, i32>(26)? != 0,
                snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(dedup_mails(mails))
    })
}

/// Count mails in a specific folder (from DB, not metadata)
#[tauri::command]
pub fn count_folder_mails(db: State<'_, Database>, folder_id: String) -> Result<u32, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM mails WHERE folder_id = ?1",
                rusqlite::params![folder_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count)
    })
}

/// Total number of locally indexed mails (optionally scoped to one account).
/// Used by the search empty state to show how many mails were searched.
#[tauri::command]
pub fn count_searchable_mails(db: State<'_, Database>, account_id: Option<String>) -> Result<u32, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let count: u32 = match account_id {
            Some(aid) => conn.query_row(
                "SELECT COUNT(*) FROM mails WHERE account_id = ?1",
                rusqlite::params![aid],
                |row| row.get(0),
            ),
            None => conn.query_row("SELECT COUNT(*) FROM mails", [], |row| row.get(0)),
        }
        .map_err(|e| e.to_string())?;
        Ok(count)
    })
}

/// Empty trash folder - permanently delete all mails in trash (local + server)
#[tauri::command]
pub async fn empty_trash(app: tauri::AppHandle, db: State<'_, Database>, account_id: String) -> Result<u32, String> {
    empty_folder_by_type(app, db, account_id, "trash").await
}

/// Empty spam folder - permanently delete all mails in spam (local + server)
#[tauri::command]
pub async fn empty_spam(app: tauri::AppHandle, db: State<'_, Database>, account_id: String) -> Result<u32, String> {
    empty_folder_by_type(app, db, account_id, "spam").await
}

/// Count mails across all accounts for a given folder type (trash, spam, etc.)
#[tauri::command]
pub fn count_combined_folder_mails(db: State<'_, Database>, folder_type: String) -> Result<u32, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let count: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM mails m JOIN folders f ON m.folder_id = f.id WHERE f.folder_type = ?1",
                rusqlite::params![folder_type],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count)
    })
}

#[tauri::command]
pub async fn empty_all_trash(app: tauri::AppHandle, db: State<'_, Database>) -> Result<u32, String> {
    empty_all_by_type(app, db, "trash").await
}

#[tauri::command]
pub async fn empty_all_spam(app: tauri::AppHandle, db: State<'_, Database>) -> Result<u32, String> {
    empty_all_by_type(app, db, "spam").await
}

async fn empty_all_by_type(app: tauri::AppHandle, db: State<'_, Database>, folder_type: &str) -> Result<u32, String> {
    use tauri::Manager;
    let account_ids: Vec<String> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare("SELECT id FROM accounts").map_err(|e| e.to_string())?;
        let ids = stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        ids
    };

    let mut total = 0u32;
    for account_id in account_ids {
        let db_state: State<'_, Database> = app.state();
        match empty_folder_by_type(app.clone(), db_state, account_id, folder_type).await {
            Ok(count) => total += count,
            Err(e) => log::warn!("empty_all_{} skipped account: {}", folder_type, e),
        }
    }
    Ok(total)
}

/// Search contacts by name or email from previously seen senders/recipients.
/// Returns up to 8 matches sorted by frequency.
#[tauri::command]
pub fn search_contacts(
    db: State<'_, Database>,
    query: String,
    account_id: Option<String>,
) -> Result<Vec<Contact>, String> {
    if query.len() < 2 || query.len() > 100 {
        return Ok(Vec::new());
    }

    let conn = db.lock_db();

    let sql = if account_id.is_some() {
        "SELECT email, name, SUM(freq) as total_freq FROM (
            SELECT from_email as email, from_name as name, COUNT(*) as freq
            FROM mails
            WHERE (from_email LIKE '%' || ?1 || '%' OR from_name LIKE '%' || ?1 || '%')
              AND account_id = ?2
            GROUP BY from_email

            UNION ALL

            SELECT json_extract(j.value, '$.email') as email,
                   json_extract(j.value, '$.name') as name, COUNT(*) as freq
            FROM mails, json_each(mails.to_json) as j
            WHERE (json_extract(j.value, '$.email') LIKE '%' || ?1 || '%'
                OR json_extract(j.value, '$.name') LIKE '%' || ?1 || '%')
              AND mails.account_id = ?2
            GROUP BY email

            UNION ALL

            SELECT json_extract(j.value, '$.email') as email,
                   json_extract(j.value, '$.name') as name, COUNT(*) as freq
            FROM mails, json_each(mails.cc_json) as j
            WHERE (json_extract(j.value, '$.email') LIKE '%' || ?1 || '%'
                OR json_extract(j.value, '$.name') LIKE '%' || ?1 || '%')
              AND mails.account_id = ?2
            GROUP BY email
        )
        WHERE email != '' AND email IS NOT NULL
        GROUP BY email
        ORDER BY total_freq DESC
        LIMIT 8"
    } else {
        "SELECT email, name, SUM(freq) as total_freq FROM (
            SELECT from_email as email, from_name as name, COUNT(*) as freq
            FROM mails
            WHERE (from_email LIKE '%' || ?1 || '%' OR from_name LIKE '%' || ?1 || '%')
            GROUP BY from_email

            UNION ALL

            SELECT json_extract(j.value, '$.email') as email,
                   json_extract(j.value, '$.name') as name, COUNT(*) as freq
            FROM mails, json_each(mails.to_json) as j
            WHERE (json_extract(j.value, '$.email') LIKE '%' || ?1 || '%'
                OR json_extract(j.value, '$.name') LIKE '%' || ?1 || '%')
            GROUP BY email

            UNION ALL

            SELECT json_extract(j.value, '$.email') as email,
                   json_extract(j.value, '$.name') as name, COUNT(*) as freq
            FROM mails, json_each(mails.cc_json) as j
            WHERE (json_extract(j.value, '$.email') LIKE '%' || ?1 || '%'
                OR json_extract(j.value, '$.name') LIKE '%' || ?1 || '%')
            GROUP BY email
        )
        WHERE email != '' AND email IS NOT NULL
        GROUP BY email
        ORDER BY total_freq DESC
        LIMIT 8"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let contacts = if let Some(ref acc_id) = account_id {
        stmt.query_map(rusqlite::params![query, acc_id], |row| {
            Ok(Contact {
                email: row.get(0)?,
                name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                frequency: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(rusqlite::params![query], |row| {
            Ok(Contact {
                email: row.get(0)?,
                name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                frequency: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
    };

    Ok(contacts)
}

async fn empty_folder_by_type(app: tauri::AppHandle, db: State<'_, Database>, account_id: String, folder_type: &str) -> Result<u32, String> {
    let (api_type, provider, auth_type) = get_api_type(&db, &account_id);
    match api_type {
        ApiType::Gmail | ApiType::Outlook => {
            let folder_info: Option<String> = {
                let conn = db.lock_db();
                conn.query_row(
                    "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = ?2",
                    rusqlite::params![account_id, folder_type],
                    |row| row.get(0),
                ).ok()
            };

            let folder_id = folder_info.ok_or_else(|| format!("No {} folder found", folder_type))?;

            let mails: Vec<(String, String)> = {
                let conn = db.lock_db();
                let mut stmt = conn.prepare("SELECT id, COALESCE(message_id, '') FROM mails WHERE folder_id = ?1")
                    .map_err(|e| e.to_string())?;
                let result: Vec<(String, String)> = stmt.query_map(rusqlite::params![folder_id], |row| Ok((row.get(0)?, row.get(1)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                result
            };

            if mails.is_empty() {
                return Ok(0);
            }

            let count = mails.len() as u32;

            let data_dir = db.data_dir.clone();
            {
                let conn = db.lock_db();
                let _ = conn.execute_batch("BEGIN");
                let _ = conn.execute("DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)", rusqlite::params![folder_id]);
                let _ = conn.execute("DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)", rusqlite::params![folder_id]);
                let _ = conn.execute("DELETE FROM mails WHERE folder_id = ?1", rusqlite::params![folder_id]);
                let _ = conn.execute("UPDATE folders SET unread_count = 0, total_count = 0 WHERE id = ?1", rusqlite::params![folder_id]);
                let _ = conn.execute_batch("COMMIT");
            }

            let mail_ids: Vec<String> = mails.iter().map(|(id, _)| id.clone()).collect();
            tokio::spawn(async move {
                for mid in &mail_ids {
                    let _ = tokio::fs::remove_dir_all(data_dir.join("attachments").join(mid)).await;
                }
            });

            let api_ids: Vec<String> = mails.into_iter()
                .filter(|(_, gid)| !gid.is_empty())
                .map(|(_, gid)| gid)
                .collect();
            let account_id_clone = account_id.clone();
            let is_gmail = matches!(api_type, ApiType::Gmail);
            let account_id_for_registry = account_id.clone();
            crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                if let Ok(credential) = credentials::resolve_credential(&account_id_clone, &auth_type, &provider).await {
                    if is_gmail {
                        let client = gmail::api::GmailClient::new(&credential);
                        for msg_id in &api_ids {
                            if let Err(e) = client.delete_message(msg_id).await {
                                log::warn!("Gmail delete {} failed: {}", msg_id, e);
                            }
                        }
                    } else {
                        let client = outlook::api::OutlookClient::new(&credential);
                        for msg_id in &api_ids {
                            if let Err(e) = client.delete_message(msg_id).await {
                                log::warn!("Outlook delete {} failed: {}", msg_id, e);
                            }
                        }
                    }
                }
            });

            return Ok(count);
        }
        ApiType::Imap => {}
    }

    let folder_info: Option<(String, String)> = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = ?2",
            rusqlite::params![account_id, folder_type],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok()
    };

    let (folder_id, folder_path) = folder_info
        .ok_or_else(|| format!("No {} folder found", folder_type))?;

    // Collect mail IDs for attachment file cleanup
    let mail_ids: Vec<String> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare("SELECT id FROM mails WHERE folder_id = ?1")
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = stmt.query_map(rusqlite::params![folder_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        ids
    };

    if mail_ids.is_empty() {
        return Ok(0);
    }

    // Delete locally FIRST in a transaction (FTS + attachments + mails)
    let deleted_count: usize = {
        let conn = db.lock_db();
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

        let result = (|| -> Result<usize, rusqlite::Error> {
            conn.execute(
                "DELETE FROM mails_fts WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)",
                rusqlite::params![folder_id],
            )?;
            conn.execute(
                "DELETE FROM attachments WHERE mail_id IN (SELECT id FROM mails WHERE folder_id = ?1)",
                rusqlite::params![folder_id],
            )?;
            let count = conn.execute(
                "DELETE FROM mails WHERE folder_id = ?1",
                rusqlite::params![folder_id],
            )?;
            conn.execute(
                "UPDATE folders SET unread_count = 0, total_count = 0 WHERE id = ?1",
                rusqlite::params![folder_id],
            )?;
            Ok(count)
        })();

        match result {
            Ok(count) => {
                let _ = conn.execute_batch("COMMIT");
                let data_dir = db.data_dir.clone();
                let mail_ids_clone = mail_ids;
                tokio::spawn(async move {
                    for mid in &mail_ids_clone {
                        let _ = tokio::fs::remove_dir_all(data_dir.join("attachments").join(mid)).await;
                    }
                });
                count
            }
            Err(e) => {
                log::error!("Failed to empty folder locally: {}", e);
                let _ = conn.execute_batch("ROLLBACK");
                return Err(format!("Failed to delete locally: {}", e));
            }
        }
    };

    let account_info: Option<(String, i32, String, String, String)> = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).ok()
    };

    if let Some((imap_host, imap_port, email, auth_type, provider)) = account_info {
        let app = app.clone();
        let account_id_for_registry = account_id.clone();
        crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
            let credential = match crate::credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                Ok(c) => c,
                Err(e) => { log::error!("EmptyFolder: no credentials: {}", e); return; }
            };
            let pool = app.state::<ImapPool>();
            let (mut session, _in_use_guard) = match pool.get_session_guarded(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                Ok(s) => s,
                Err(e) => { log::error!("EmptyFolder: IMAP connection failed: {}", e); return; }
            };

            let result = crate::imap::empty_folder_on_server(&mut session, &folder_path).await;
            match &result {
                Ok(_) => {
                    log::info!("EmptyFolder: server folder '{}' emptied", folder_path);
                    pool.return_session(&account_id, session).await;
                }
                Err(e) => {
                    log::error!("EmptyFolder: IMAP failed: {}", e);
                    let _ = session.logout().await;
                    pool.release(&account_id);
                }
            }
        });
    }

    Ok(deleted_count as u32)
}

/// Prevents duplicate folder prefetches
static PREFETCHING_FOLDERS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

/// Background-prefetch bodies for the most recent mails in a folder.
/// Called by frontend when user navigates to a folder — fire-and-forget.
/// Bodies are cached in DB so subsequent clicks load instantly.
#[tauri::command]
pub async fn prefetch_folder(
    app: tauri::AppHandle,
    folder_id: String,
) -> Result<(), String> {
    // Atomic check-and-claim of the per-folder prefetch lock.
    {
        let mut prefetching = PREFETCHING_FOLDERS.lock().unwrap_or_else(|e| e.into_inner());
        if prefetching.contains(&folder_id) {
            return Ok(());
        }
        prefetching.insert(folder_id.clone());
    }

    // Look up folder path + account_id once, before spawning.
    let folder_info: Option<(String, String)> = {
        use tauri::Manager;
        let db = app.state::<Database>();
        let conn = db.lock_db();
        conn.query_row(
            "SELECT path, account_id FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()
    };

    let Some((folder_path, account_id_for_registry)) = folder_info else {
        // Folder vanished — release the claim and bail.
        let mut p = PREFETCHING_FOLDERS.lock().unwrap_or_else(|e| e.into_inner());
        p.remove(&folder_id);
        return Ok(());
    };

    let account_id_for_spawn = account_id_for_registry.clone();
    // Construct guard outside the future so it fires even if the future is
    // dropped before its first poll (immediate abort_account race).
    let prefetch_guard = crate::cleanup_guard::SetGuard::new(&PREFETCHING_FOLDERS, folder_id.clone());
    crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
        let _prefetch_guard = prefetch_guard;
        use tauri::Manager;

        let db = app.state::<Database>();
        let pool = app.state::<ImapPool>();
        let account_id = account_id_for_spawn;

        // API accounts (Gmail/Outlook) don't use IMAP prefetch — bodies fetched on-demand
        {
            let (api_type, _, _) = get_api_type(&db, &account_id);
            if matches!(api_type, ApiType::Gmail | ApiType::Outlook) {
                return;
            }
        }

        let mails_to_prefetch: Vec<(String, u32)> = {
            let conn = db.lock_db();
            conn.prepare(
                "SELECT id, uid FROM mails WHERE folder_id = ?1 AND body_text = '' AND body_html = '' AND uid IS NOT NULL ORDER BY date DESC LIMIT 100",
            )
            .ok()
            .and_then(|mut stmt| {
                stmt.query_map(rusqlite::params![folder_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_default()
        };

        if mails_to_prefetch.is_empty() {
            log::info!("prefetch_folder '{}': all bodies cached, nothing to do", folder_path);
            return;
        }

        let creds: Option<(String, i32, String, String, String)> = {
            let conn = db.lock_db();
            conn.query_row(
                "SELECT imap_host, imap_port, email, auth_type, provider FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
            )
            .ok()
        };

        let Some((imap_host, imap_port, email, auth_type, provider)) = creds else {
            return;
        };

        let credential = match crate::credentials::resolve_credential(&account_id, &auth_type, &provider).await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("prefetch_folder: credential resolution failed: {}", e);
                return;
            }
        };

        log::info!(
            "prefetch_folder '{}': starting background fetch for {} mails",
            folder_path,
            mails_to_prefetch.len()
        );

        // Guarded variant: in_use slot auto-releases on cancellation.
        let session_result = pool
            .get_session_with_folder_guarded(
                &account_id,
                &imap_host,
                imap_port as u16,
                &email,
                &credential,
                &auth_type,
            )
            .await;

        let (mut session, _pool_folder, _in_use_guard) = match session_result {
            Ok(r) => r,
            Err(e) => {
                log::warn!("prefetch_folder: connection failed: {}", e);
                return;
            }
        };

        match imap::backfill_folder_bodies(
            &mut session,
            &folder_path,
            &mails_to_prefetch,
            &db,
            &app,
            None,
        )
        .await
        {
            Ok(count) => {
                log::info!("prefetch_folder '{}': {} bodies fetched", folder_path, count);
                pool.return_session_in_folder(&account_id, session, folder_path)
                    .await;
            }
            Err(e) => {
                log::warn!("prefetch_folder '{}': failed: {}", folder_path, e);
                let _ = session.logout().await;
                pool.release(&account_id);
            }
        }
    });

    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnsubscribeResult {
    pub method: String,
    pub success: bool,
    pub url: String,
}

/// Parse List-Unsubscribe header value and attempt to unsubscribe.
/// RFC 2369 format: `<https://example.com/unsub>, <mailto:unsub@example.com>`
#[tauri::command]
pub async fn unsubscribe_mail(db: State<'_, Database>, mail_id: String) -> Result<UnsubscribeResult, String> {
    let list_unsub: String = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COALESCE(list_unsubscribe, '') FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Mail not found: {}", e))?
    };

    if list_unsub.is_empty() {
        return Err("No List-Unsubscribe header".into());
    }

    // Parse URLs from the header: extract <...> entries
    let mut https_url: Option<String> = None;
    let mut mailto_url: Option<String> = None;

    for part in list_unsub.split(',') {
        let trimmed = part.trim();
        if let (Some(start), Some(end)) = (trimmed.find('<'), trimmed.rfind('>')) {
            let url = trimmed[start + 1..end].trim().to_string();
            if url.starts_with("https://") || url.starts_with("http://") {
                if https_url.is_none() {
                    https_url = Some(url);
                }
            } else if url.starts_with("mailto:") {
                if mailto_url.is_none() {
                    mailto_url = Some(url);
                }
            }
        }
    }

    // Try One-Click Unsubscribe (RFC 8058) via HTTPS POST
    if let Some(ref url) = https_url {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;

        match client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body("List-Unsubscribe=One-Click")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 302 => {
                return Ok(UnsubscribeResult {
                    method: "one_click".into(),
                    success: true,
                    url: url.clone(),
                });
            }
            _ => {
                // One-Click failed, fallback to opening in browser
                return Ok(UnsubscribeResult {
                    method: "browser".into(),
                    success: false,
                    url: url.clone(),
                });
            }
        }
    }

    // Fallback: mailto
    if let Some(url) = mailto_url {
        return Ok(UnsubscribeResult {
            method: "mailto".into(),
            success: false,
            url,
        });
    }

    Err("No usable unsubscribe URL found".into())
}

/// Batch update multiple mails at once.
/// Actions: "trash", "archive", "mark_read", "mark_unread", "star", "unstar"
/// Local DB is updated first, then server sync happens in background.
/// Gmail: single batchModify API call per account (avoids 429 rate limiting).
/// Outlook: serialized calls with 200ms delay between each.
#[tauri::command]
pub async fn batch_update_mails(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    mail_ids: Vec<String>,
    action: String,
) -> Result<(), String> {
    if mail_ids.is_empty() {
        return Ok(());
    }

    log::info!("batch_update_mails: action={}, count={}", action, mail_ids.len());

    match action.as_str() {
        "mark_read" | "mark_unread" => {
            let is_read = action == "mark_read";
            {
                let conn = db.lock_db();
                let _ = conn.execute_batch("BEGIN");
                for mail_id in &mail_ids {
                    let _ = conn.execute(
                        "UPDATE mails SET is_read = ?1 WHERE id = ?2",
                        rusqlite::params![is_read as i32, mail_id],
                    );
                }
                // Recalculate unread counts for affected folders
                let folder_ids: HashSet<String> = mail_ids.iter().filter_map(|mid| {
                    conn.query_row(
                        "SELECT folder_id FROM mails WHERE id = ?1",
                        rusqlite::params![mid],
                        |row| row.get::<_, String>(0),
                    ).ok()
                }).collect();
                for folder_id in &folder_ids {
                    let _ = conn.execute(
                        "UPDATE folders SET unread_count = (SELECT COUNT(*) FROM mails WHERE folder_id = ?1 AND is_read = 0) WHERE id = ?1",
                        rusqlite::params![folder_id],
                    );
                }
                let _ = conn.execute_batch("COMMIT");
            }
            // Queue pending ops + group by account for batched server sync
            let mut gmail_batches: HashMap<String, (String, String, Vec<String>)> = HashMap::new();
            let mut outlook_batches: HashMap<String, (String, String, Vec<String>)> = HashMap::new();

            for mail_id in &mail_ids {
                if let Some((api_msg_id, account_id)) = get_api_message_id(&db, mail_id) {
                    let (api_type, provider, auth_type) = get_api_type(&db, &account_id);

                    // Queue pending op for every mail (including IMAP)
                    let payload = format!(
                        r#"{{"value":{},"api_id":"{}","internet_id":"{}"}}"#,
                        is_read, api_msg_id, get_internet_id_escaped(&db, mail_id)
                    );
                    {
                        let conn = db.lock_db();
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'set_read', ?3, 0)",
                            rusqlite::params![account_id, mail_id, payload],
                        );
                    }

                    match api_type {
                        ApiType::Gmail => {
                            gmail_batches.entry(account_id).or_insert_with(|| (provider, auth_type, Vec::new())).2.push(api_msg_id);
                        }
                        ApiType::Outlook => {
                            outlook_batches.entry(account_id).or_insert_with(|| (provider, auth_type, Vec::new())).2.push(api_msg_id);
                        }
                        ApiType::Imap => {
                            // IMAP pending ops will be processed at next sync
                        }
                    }
                }
            }

            let db_path = db.data_dir.join("prudii.db");

            // Gmail: single batchModify call per account
            for (account_id, (provider, auth_type, msg_ids)) in gmail_batches {
                let db_path = db_path.clone();
                let mail_ids_clone: Vec<String> = mail_ids.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = gmail::api::GmailClient::new(&credential);
                        let refs: Vec<&str> = msg_ids.iter().map(|s| s.as_str()).collect();
                        if gmail::messages::batch_set_read(&client, &refs, is_read).await.is_ok() {
                            for mid in &mail_ids_clone {
                                delete_pending_op_bg(&db_path, mid, "set_read");
                            }
                        }
                    }
                });
            }

            // Outlook: serialized calls with delay
            for (account_id, (provider, auth_type, msg_ids)) in outlook_batches {
                let db_path = db_path.clone();
                let mail_ids_clone: Vec<String> = mail_ids.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = outlook::api::OutlookClient::new(&credential);
                        let mut all_ok = true;
                        for msg_id in &msg_ids {
                            if outlook::messages::toggle_read(&client, msg_id, !is_read).await.is_err() {
                                all_ok = false;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                        if all_ok {
                            for mid in &mail_ids_clone {
                                delete_pending_op_bg(&db_path, mid, "set_read");
                            }
                        }
                    }
                });
            }
        }
        "star" | "unstar" => {
            let starred = action == "star";
            {
                let conn = db.lock_db();
                let _ = conn.execute_batch("BEGIN");
                for mail_id in &mail_ids {
                    let _ = conn.execute(
                        "UPDATE mails SET is_starred = ?1 WHERE id = ?2",
                        rusqlite::params![starred as i32, mail_id],
                    );
                }
                let _ = conn.execute_batch("COMMIT");
            }
            // Queue pending ops + group by account for batched server sync
            let mut gmail_batches: HashMap<String, (String, String, Vec<String>)> = HashMap::new();
            let mut outlook_batches: HashMap<String, (String, String, Vec<String>)> = HashMap::new();

            for mail_id in &mail_ids {
                if let Some((api_msg_id, account_id)) = get_api_message_id(&db, mail_id) {
                    let (api_type, provider, auth_type) = get_api_type(&db, &account_id);

                    let payload = format!(
                        r#"{{"value":{},"api_id":"{}","internet_id":"{}"}}"#,
                        starred, api_msg_id, get_internet_id_escaped(&db, mail_id)
                    );
                    {
                        let conn = db.lock_db();
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, 'set_star', ?3, 0)",
                            rusqlite::params![account_id, mail_id, payload],
                        );
                    }

                    match api_type {
                        ApiType::Gmail => {
                            gmail_batches.entry(account_id).or_insert_with(|| (provider, auth_type, Vec::new())).2.push(api_msg_id);
                        }
                        ApiType::Outlook => {
                            outlook_batches.entry(account_id).or_insert_with(|| (provider, auth_type, Vec::new())).2.push(api_msg_id);
                        }
                        ApiType::Imap => {
                            // IMAP pending ops will be processed at next sync
                        }
                    }
                }
            }

            let db_path = db.data_dir.join("prudii.db");

            // Gmail: single batchModify call per account
            for (account_id, (provider, auth_type, msg_ids)) in gmail_batches {
                let db_path = db_path.clone();
                let mail_ids_clone: Vec<String> = mail_ids.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = gmail::api::GmailClient::new(&credential);
                        let refs: Vec<&str> = msg_ids.iter().map(|s| s.as_str()).collect();
                        if gmail::messages::batch_set_star(&client, &refs, starred).await.is_ok() {
                            for mid in &mail_ids_clone {
                                delete_pending_op_bg(&db_path, mid, "set_star");
                            }
                        }
                    }
                });
            }

            // Outlook: serialized calls with delay
            for (account_id, (provider, auth_type, msg_ids)) in outlook_batches {
                let db_path = db_path.clone();
                let mail_ids_clone: Vec<String> = mail_ids.clone();
                let account_id_for_registry = account_id.clone();
                crate::task_registry::spawn_for_account(&account_id_for_registry, async move {
                    if let Ok(credential) = credentials::resolve_credential(&account_id, &auth_type, &provider).await {
                        let client = outlook::api::OutlookClient::new(&credential);
                        let mut all_ok = true;
                        for msg_id in &msg_ids {
                            if outlook::messages::toggle_star(&client, msg_id, !starred).await.is_err() {
                                all_ok = false;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                        if all_ok {
                            for mid in &mail_ids_clone {
                                delete_pending_op_bg(&db_path, mid, "set_star");
                            }
                        }
                    }
                });
            }
        }
        "trash" => {
            // Delegate to existing trash_mail per-item (it handles all edge cases)
            for mail_id in mail_ids {
                let app_clone = app.clone();
                let db_ref = app.state::<Database>();
                if let Err(e) = trash_mail(app_clone, db_ref, mail_id.clone()).await {
                    log::warn!("batch trash_mail failed for {}: {}", mail_id, e);
                }
            }
        }
        "archive" => {
            // Delegate to existing archive_mail per-item
            for mail_id in mail_ids {
                let app_clone = app.clone();
                let db_ref = app.state::<Database>();
                if let Err(e) = archive_mail(app_clone, db_ref, mail_id.clone()).await {
                    log::warn!("batch archive_mail failed for {}: {}", mail_id, e);
                }
            }
        }
        _ => {
            return Err(format!("Unknown batch action: {}", action));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn classify_unclassified_mails(db: State<'_, Database>) -> Result<i32, String> {
    let conn = db.lock_db();
    Ok(crate::classify::classify_unclassified(&conn))
}

use crate::models::{InboxSplit, SplitConditions};

#[tauri::command]
pub fn list_inbox_splits(db: State<'_, Database>) -> Result<Vec<InboxSplit>, String> {
    let conn = db.lock_db();
    let mut stmt = conn.prepare(
        "SELECT id, name, position, icon, conditions, is_default FROM inbox_splits ORDER BY position ASC"
    ).map_err(|e| e.to_string())?;

    let rows: Vec<InboxSplit> = stmt.query_map([], |row| {
        Ok(InboxSplit {
            id: row.get(0)?,
            name: row.get(1)?,
            position: row.get(2)?,
            icon: row.get(3)?,
            conditions: row.get(4)?,
            is_default: row.get::<_, i32>(5)? != 0,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(rows)
}

#[tauri::command]
pub fn create_inbox_split(
    db: State<'_, Database>,
    name: String,
    icon: String,
    conditions: String,
) -> Result<InboxSplit, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock_db();

    let max_pos: i32 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) FROM inbox_splits", [], |r| r.get(0)
    ).unwrap_or(-1);

    conn.execute(
        "INSERT INTO inbox_splits (id, name, position, icon, conditions, is_default) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        rusqlite::params![id, name, max_pos + 1, icon, conditions],
    ).map_err(|e| format!("Failed to create split: {}", e))?;

    Ok(InboxSplit { id, name, position: max_pos + 1, icon, conditions, is_default: false })
}

#[tauri::command]
pub fn update_inbox_split(
    db: State<'_, Database>,
    id: String,
    name: String,
    icon: String,
    conditions: String,
    position: i32,
) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute(
        "UPDATE inbox_splits SET name = ?1, icon = ?2, conditions = ?3, position = ?4 WHERE id = ?5",
        rusqlite::params![name, icon, conditions, position, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_inbox_split(db: State<'_, Database>, id: String) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute("DELETE FROM inbox_splits WHERE id = ?1 AND is_default = 0", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_split_inbox_mails(
    db: State<'_, Database>,
    split_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Mail>, String> {
    let conn = db.lock_db();

    let conditions_json: String = conn.query_row(
        "SELECT conditions FROM inbox_splits WHERE id = ?1",
        rusqlite::params![split_id],
        |row| row.get(0),
    ).map_err(|e| format!("Split not found: {}", e))?;

    let mut folder_stmt = conn.prepare(
        "SELECT id FROM folders WHERE folder_type = 'inbox'"
    ).map_err(|e| e.to_string())?;
    let inbox_ids: Vec<String> = folder_stmt.query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if inbox_ids.is_empty() {
        return Ok(vec![]);
    }

    let placeholders: String = inbox_ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect::<Vec<_>>().join(",");
    let lim = limit.unwrap_or(50);
    let off = offset.unwrap_or(0);

    // For "primary" split with empty conditions: show all inbox mails NOT matching any other split
    if conditions_json == "{}" || conditions_json.is_empty() {
        let mut other_stmt = conn.prepare(
            "SELECT conditions FROM inbox_splits WHERE id != ?1"
        ).map_err(|e| e.to_string())?;
        let other_conditions: Vec<String> = other_stmt.query_map(rusqlite::params![split_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut where_parts: Vec<String> = vec![format!("folder_id IN ({})", placeholders)];
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = inbox_ids.iter().map(|id| Box::new(id.clone()) as Box<dyn rusqlite::types::ToSql>).collect();

        for cond_json in &other_conditions {
            if let Ok(cond) = serde_json::from_str::<SplitConditions>(cond_json) {
                let clause = build_split_where(&cond, &mut params);
                if !clause.is_empty() {
                    where_parts.push(format!("NOT ({})", clause));
                }
            }
        }

        let sql = format!(
            "SELECT {} FROM mails WHERE {} ORDER BY date DESC LIMIT {} OFFSET {}",
            MAIL_SELECT_COLUMNS, where_parts.join(" AND "), lim, off
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows: Vec<Mail> = stmt.query_map(param_refs.as_slice(), map_mail_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        return Ok(rows);
    }

    // Normal split: apply conditions
    let conditions: SplitConditions = serde_json::from_str(&conditions_json)
        .map_err(|e| format!("Invalid conditions: {}", e))?;

    let mut where_parts: Vec<String> = vec![format!("folder_id IN ({})", placeholders)];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = inbox_ids.iter().map(|id| Box::new(id.clone()) as Box<dyn rusqlite::types::ToSql>).collect();

    let clause = build_split_where(&conditions, &mut params);
    if !clause.is_empty() {
        where_parts.push(format!("({})", clause));
    }

    let sql = format!(
        "SELECT {} FROM mails WHERE {} ORDER BY date DESC LIMIT {} OFFSET {}",
        MAIL_SELECT_COLUMNS, where_parts.join(" AND "), lim, off
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows: Vec<Mail> = stmt.query_map(param_refs.as_slice(), map_mail_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

const MAIL_SELECT_COLUMNS: &str = "id, account_id, folder_id, message_id, uid, subject, from_name, from_email, to_json, cc_json, bcc_json, date, snippet, body_text, body_html, is_read, is_starred, is_flagged, is_replied, is_forwarded, has_attachments, thread_id, in_reply_to, size_bytes, COALESCE(flags, ''), COALESCE(list_unsubscribe, ''), COALESCE(is_pinned, 0), COALESCE(snoozed_until, ''), COALESCE(reply_to_json, '[]'), COALESCE(auto_labels, ''), COALESCE(\"references\", '')";

fn map_mail_row(row: &rusqlite::Row) -> rusqlite::Result<Mail> {
    let to_json: String = row.get(8)?;
    let cc_json: String = row.get(9)?;
    let bcc_json: String = row.get(10)?;
    let flags_str: String = row.get(24)?;
    let unsub_str: String = row.get(25)?;
    let snoozed_str: String = row.get(27)?;
    let reply_to_json: String = row.get(28)?;

    Ok(Mail {
        id: row.get(0)?,
        account_id: row.get(1)?,
        folder_id: row.get(2)?,
        message_id: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        uid: row.get(4)?,
        subject: row.get(5)?,
        from: MailAddress {
            name: row.get(6)?,
            email: row.get(7)?,
        },
        to: parse_addresses(&to_json),
        cc: parse_addresses(&cc_json),
        bcc: parse_addresses(&bcc_json),
        date: row.get(11)?,
        snippet: row.get(12)?,
        body_text: row.get(13)?,
        body_html: row.get(14)?,
        is_read: row.get::<_, i32>(15)? != 0,
        is_starred: row.get::<_, i32>(16)? != 0,
        is_flagged: row.get::<_, i32>(17)? != 0,
        is_replied: row.get::<_, i32>(18)? != 0,
        is_forwarded: row.get::<_, i32>(19)? != 0,
        has_attachments: row.get::<_, i32>(20)? != 0,
        thread_id: row.get(21)?,
        in_reply_to: row.get(22)?,
        references: row.get::<_, String>(30).unwrap_or_default(),
        size_bytes: row.get(23)?,
        flags: parse_flags(&flags_str),
        list_unsubscribe: if unsub_str.is_empty() { None } else { Some(unsub_str) },
        reply_to: parse_addresses(&reply_to_json),
        is_pinned: row.get::<_, i32>(26)? != 0,
        snoozed_until: if snoozed_str.is_empty() { None } else { Some(snoozed_str) },
    })
}

fn build_split_where(cond: &SplitConditions, params: &mut Vec<Box<dyn rusqlite::types::ToSql>>) -> String {
    let mut parts: Vec<String> = Vec::new();

    for domain in &cond.from_domain {
        let idx = params.len() + 1;
        params.push(Box::new(format!("%@{}%", domain)));
        parts.push(format!("from_email LIKE ?{}", idx));
    }

    for pattern in &cond.from_contains {
        let idx = params.len() + 1;
        params.push(Box::new(format!("%{}%", pattern)));
        parts.push(format!("from_email LIKE ?{}", idx));
    }

    for keyword in &cond.subject_contains {
        let idx = params.len() + 1;
        params.push(Box::new(format!("%{}%", keyword)));
        parts.push(format!("subject LIKE ?{}", idx));
    }

    for label in &cond.has_auto_label {
        let idx = params.len() + 1;
        params.push(Box::new(format!("%\"{}%", label)));
        parts.push(format!("auto_labels LIKE ?{}", idx));
    }

    if parts.is_empty() {
        return String::new();
    }

    parts.join(" OR ")
}

#[tauri::command]
pub fn search_attachments(
    db: State<'_, Database>,
    query: String,
    account_ids: Option<Vec<String>>,
    folder_id: Option<String>,
    file_extensions: Option<Vec<String>>,
    exclude_extensions: Option<Vec<String>>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<AttachmentWithContext>, String> {
    let conn = db.lock_db();
    let lim = limit.unwrap_or(50);
    let off = offset.unwrap_or(0);
    let order = match sort_order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    let sort_col = match sort_by.as_deref() {
        Some("filename") => format!("a.filename {}", order),
        Some("size") => format!("a.size_bytes {}", order),
        _ => format!("m.date {}", order),
    };

    let safe_query = sanitize_fts_query(&query);
    let has_query = !safe_query.is_empty();

    let mut conditions = vec!["a.is_inline = 0".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref aids) = account_ids {
        let filtered: Vec<&String> = aids.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            let placeholders: Vec<String> = filtered.iter().map(|_| {
                let p = format!("?{}", param_idx);
                param_idx += 1;
                p
            }).collect();
            conditions.push(format!("m.account_id IN ({})", placeholders.join(", ")));
            for aid in filtered {
                params.push(Box::new(aid.clone()));
            }
        }
    }
    if let Some(ref fid) = folder_id {
        conditions.push(format!("m.folder_id = ?{}", param_idx));
        params.push(Box::new(fid.clone()));
        param_idx += 1;
    }
    if let Some(ref exts) = file_extensions {
        let filtered: Vec<&String> = exts.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            let like_clauses: Vec<String> = filtered.iter().map(|_| {
                let p = format!("LOWER(a.filename) LIKE ?{}", param_idx);
                param_idx += 1;
                p
            }).collect();
            conditions.push(format!("({})", like_clauses.join(" OR ")));
            for ext in filtered {
                params.push(Box::new(format!("%.{}", ext.to_lowercase())));
            }
        }
    }
    if let Some(ref exts) = exclude_extensions {
        let filtered: Vec<&String> = exts.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            for ext in filtered {
                conditions.push(format!("LOWER(a.filename) NOT LIKE ?{}", param_idx));
                params.push(Box::new(format!("%.{}", ext.to_lowercase())));
                param_idx += 1;
            }
        }
    }

    let where_clause = conditions.join(" AND ");

    let sql = if has_query {
        let fts_param = param_idx;
        params.push(Box::new(safe_query.clone()));
        param_idx += 1;
        let like_param = param_idx;
        params.push(Box::new(format!("%{}%", query.trim())));
        param_idx += 1;
        let lim_param = param_idx;
        params.push(Box::new(lim));
        param_idx += 1;
        let off_param = param_idx;
        params.push(Box::new(off));

        format!(
            "SELECT DISTINCT a.id, a.mail_id, a.filename, a.mime_type, a.size_bytes, a.local_path,
                    m.subject, m.from_name, m.from_email, m.date, m.folder_id,
                    COALESCE(f.name, '') as folder_name, m.account_id
             FROM attachments a
             JOIN mails m ON m.id = a.mail_id
             LEFT JOIN folders f ON f.id = m.folder_id
             WHERE {where_clause}
               AND (a.mail_id IN (SELECT mail_id FROM mails_fts WHERE mails_fts MATCH ?{fts_param})
                    OR a.filename LIKE ?{like_param})
             ORDER BY {sort_col}
             LIMIT ?{lim_param} OFFSET ?{off_param}"
        )
    } else {
        let lim_param = param_idx;
        params.push(Box::new(lim));
        param_idx += 1;
        let off_param = param_idx;
        params.push(Box::new(off));

        format!(
            "SELECT a.id, a.mail_id, a.filename, a.mime_type, a.size_bytes, a.local_path,
                    m.subject, m.from_name, m.from_email, m.date, m.folder_id,
                    COALESCE(f.name, '') as folder_name, m.account_id
             FROM attachments a
             JOIN mails m ON m.id = a.mail_id
             LEFT JOIN folders f ON f.id = m.folder_id
             WHERE {where_clause}
             ORDER BY {sort_col}
             LIMIT ?{lim_param} OFFSET ?{off_param}"
        )
    };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let results = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(AttachmentWithContext {
                id: row.get(0)?,
                mail_id: row.get(1)?,
                filename: row.get(2)?,
                mime_type: row.get(3)?,
                size_bytes: row.get(4)?,
                local_path: row.get(5)?,
                mail_subject: row.get(6)?,
                mail_from_name: row.get(7)?,
                mail_from_email: row.get(8)?,
                mail_date: row.get(9)?,
                mail_folder_id: row.get(10)?,
                folder_name: row.get(11)?,
                account_id: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(results)
}

#[tauri::command]
pub fn count_attachments(
    db: State<'_, Database>,
    query: String,
    account_ids: Option<Vec<String>>,
    folder_id: Option<String>,
    file_extensions: Option<Vec<String>>,
    exclude_extensions: Option<Vec<String>>,
) -> Result<u32, String> {
    let conn = db.lock_db();

    let safe_query = sanitize_fts_query(&query);
    let has_query = !safe_query.is_empty();

    let mut conditions = vec!["a.is_inline = 0".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref aids) = account_ids {
        let filtered: Vec<&String> = aids.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            let placeholders: Vec<String> = filtered.iter().map(|_| {
                let p = format!("?{}", param_idx);
                param_idx += 1;
                p
            }).collect();
            conditions.push(format!("m.account_id IN ({})", placeholders.join(", ")));
            for aid in filtered {
                params.push(Box::new(aid.clone()));
            }
        }
    }
    if let Some(ref fid) = folder_id {
        conditions.push(format!("m.folder_id = ?{}", param_idx));
        params.push(Box::new(fid.clone()));
        param_idx += 1;
    }
    if let Some(ref exts) = file_extensions {
        let filtered: Vec<&String> = exts.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            let like_clauses: Vec<String> = filtered.iter().map(|_| {
                let p = format!("LOWER(a.filename) LIKE ?{}", param_idx);
                param_idx += 1;
                p
            }).collect();
            conditions.push(format!("({})", like_clauses.join(" OR ")));
            for ext in filtered {
                params.push(Box::new(format!("%.{}", ext.to_lowercase())));
            }
        }
    }
    if let Some(ref exts) = exclude_extensions {
        let filtered: Vec<&String> = exts.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            for ext in filtered {
                conditions.push(format!("LOWER(a.filename) NOT LIKE ?{}", param_idx));
                params.push(Box::new(format!("%.{}", ext.to_lowercase())));
                param_idx += 1;
            }
        }
    }

    let where_clause = conditions.join(" AND ");

    let sql = if has_query {
        let fts_param = param_idx;
        params.push(Box::new(safe_query.clone()));
        param_idx += 1;
        let like_param = param_idx;
        params.push(Box::new(format!("%{}%", query.trim())));

        format!(
            "SELECT COUNT(DISTINCT a.id)
             FROM attachments a
             JOIN mails m ON m.id = a.mail_id
             WHERE {where_clause}
               AND (a.mail_id IN (SELECT mail_id FROM mails_fts WHERE mails_fts MATCH ?{fts_param})
                    OR a.filename LIKE ?{like_param})"
        )
    } else {
        format!(
            "SELECT COUNT(*)
             FROM attachments a
             JOIN mails m ON m.id = a.mail_id
             WHERE {where_clause}"
        )
    };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let count: u32 = conn
        .query_row(&sql, param_refs.as_slice(), |row| row.get(0))
        .map_err(|e| e.to_string())?;

    Ok(count)
}

#[tauri::command]
pub async fn bulk_save_attachments(
    db: State<'_, Database>,
    attachment_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<BulkSaveResult, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::sync::mpsc;
    use zip::write::SimpleFileOptions;

    if attachment_ids.is_empty() {
        return Err("No attachments selected".to_string());
    }

    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .set_file_name("attachments.zip")
        .add_filter("ZIP Archive", &["zip"])
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let dest_file = rx
        .recv()
        .map_err(|e| format!("Dialog error: {}", e))?
        .ok_or_else(|| "Cancelled".to_string())?;

    let dest_path = dest_file
        .as_path()
        .ok_or_else(|| "Invalid file path".to_string())?;

    let dest_path = if dest_path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
        dest_path.to_path_buf()
    } else {
        dest_path.with_extension("zip")
    };

    let attachments: Vec<(String, String)> = {
        let conn = db.lock_db();
        let placeholders: Vec<String> = (0..attachment_ids.len()).map(|i| format!("?{}", i + 1)).collect();
        let sql = format!(
            "SELECT filename, local_path FROM attachments WHERE id IN ({}) AND local_path IS NOT NULL",
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::types::ToSql> = attachment_ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
        let results = stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
        results
    };

    let zip_file = std::fs::File::create(&dest_path).map_err(|e| e.to_string())?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut saved = 0u32;
    let mut failed = 0u32;
    let mut used_names = std::collections::HashSet::new();

    for (filename, local_path) in &attachments {
        let source = std::path::Path::new(local_path);
        if !source.exists() {
            failed += 1;
            continue;
        }

        // Handle duplicate filenames inside the ZIP
        let mut zip_name = filename.clone();
        if used_names.contains(&zip_name) {
            let stem = std::path::Path::new(filename)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| filename.clone());
            let ext = std::path::Path::new(filename)
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
                .unwrap_or_default();
            let mut counter = 1u32;
            loop {
                zip_name = format!("{} ({}){}", stem, counter, ext);
                if !used_names.contains(&zip_name) {
                    break;
                }
                counter += 1;
            }
        }
        used_names.insert(zip_name.clone());

        match (|| -> Result<(), String> {
            let data = std::fs::read(source).map_err(|e| e.to_string())?;
            zip_writer.start_file(&zip_name, options).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut zip_writer, &data).map_err(|e| e.to_string())?;
            Ok(())
        })() {
            Ok(_) => saved += 1,
            Err(_) => failed += 1,
        }
    }

    zip_writer.finish().map_err(|e| e.to_string())?;

    Ok(BulkSaveResult {
        saved,
        failed,
        dest_path: dest_path.to_string_lossy().to_string(),
    })
}
