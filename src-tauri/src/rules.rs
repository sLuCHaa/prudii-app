//! Rule engine: applies mail rules to messages.
//! Each action updates the local DB and queues a matching `pending_ops` row,
//! so rule actions sync to the server exactly like manual user actions.

use crate::db::Database;

/// Load enabled rules for an account, sorted by priority DESC, and apply them
/// to each mail_id. First matching rule wins (stop processing after match).
pub fn apply_rules_to_mails(account_id: &str, mail_ids: &[String], db: &Database) -> u32 {
    if mail_ids.is_empty() {
        return 0;
    }

    let conn = db.lock_db();

    let mut stmt = match conn.prepare(
        "SELECT id, from_contains, to_contains, subject_contains, has_attachments, action_move_to_folder, action_mark_read, action_star, action_trash, action_archive FROM mail_rules WHERE account_id = ?1 AND enabled = 1 ORDER BY priority DESC",
    ) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("Failed to load rules for {}: {}", account_id, e);
            return 0;
        }
    };

    let rules: Vec<Rule> = match stmt.query_map(rusqlite::params![account_id], |row| {
        Ok(Rule {
            id: row.get(0)?,
            from_contains: row.get(1)?,
            to_contains: row.get(2)?,
            subject_contains: row.get(3)?,
            has_attachments: row.get::<_, Option<i32>>(4)?.map(|v| v != 0),
            action_move_to_folder: row.get(5)?,
            action_mark_read: row.get::<_, Option<i32>>(6)?.map(|v| v != 0),
            action_star: row.get::<_, Option<i32>>(7)?.map(|v| v != 0),
            action_trash: row.get::<_, Option<i32>>(8)?.map(|v| v != 0),
            action_archive: row.get::<_, Option<i32>>(9)?.map(|v| v != 0),
        })
    }) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return 0,
    };

    if rules.is_empty() {
        return 0;
    }

    // Bulk-load metadata for all mail_ids in one query (avoids N+1 query_row).
    let placeholders = std::iter::repeat_n("?", mail_ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT m.id, m.from_name, m.from_email, m.to_json, m.subject, m.has_attachments, m.folder_id, COALESCE(m.message_id, ''), COALESCE(f.path, '') FROM mails m LEFT JOIN folders f ON m.folder_id = f.id WHERE m.id IN ({})",
        placeholders
    );
    let params: Vec<&dyn rusqlite::ToSql> = mail_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let metas: Vec<(String, MailMeta)> = match conn.prepare(&sql).and_then(|mut stmt| {
        stmt.query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                MailMeta {
                    from_name: row.get(1)?,
                    from_email: row.get(2)?,
                    to_json: row.get(3)?,
                    subject: row.get(4)?,
                    has_attachments: row.get::<_, i32>(5)? != 0,
                    folder_id: row.get(6)?,
                    message_id: row.get(7)?,
                    source_folder_path: row.get(8)?,
                },
            ))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
    }) {
        Ok(v) => v,
        Err(e) => { log::warn!("Rules bulk-load failed for {}: {}", account_id, e); return 0; }
    };

    let is_gmail = {
        let provider: String = conn
            .query_row(
                "SELECT provider FROM accounts WHERE id = ?1",
                rusqlite::params![account_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        provider == "google"
    };

    let mut applied_count = 0u32;
    let tx = conn.unchecked_transaction();
    for (mail_id, mail) in &metas {
        for rule in &rules {
            if matches_rule(rule, mail) {
                apply_actions(&conn, rule, mail_id, mail, account_id, is_gmail);
                applied_count += 1;
                break; // first match wins
            }
        }
    }
    if let Ok(tx) = tx { let _ = tx.commit(); }

    if applied_count > 0 {
        log::info!("Rules: applied to {}/{} mails for account {}", applied_count, mail_ids.len(), account_id);
    }
    applied_count
}

struct Rule {
    id: String,
    from_contains: Option<String>,
    to_contains: Option<String>,
    subject_contains: Option<String>,
    has_attachments: Option<bool>,
    action_move_to_folder: Option<String>,
    action_mark_read: Option<bool>,
    action_star: Option<bool>,
    action_trash: Option<bool>,
    action_archive: Option<bool>,
}

struct MailMeta {
    from_name: String,
    from_email: String,
    to_json: String,
    subject: String,
    has_attachments: bool,
    folder_id: String,
    message_id: String,
    source_folder_path: String,
}

/// Check if all non-empty conditions match (AND logic).
fn matches_rule(rule: &Rule, mail: &MailMeta) -> bool {
    if let Some(ref pattern) = rule.from_contains {
        if !pattern.is_empty() {
            let pattern_lower = pattern.to_lowercase();
            let from_combined = format!("{} {}", mail.from_name, mail.from_email).to_lowercase();
            if !from_combined.contains(&pattern_lower) {
                return false;
            }
        }
    }

    // to_contains: parse the recipient JSON ([{name,email},...]) and match the
    // pattern (case-insensitive) against each "name email" string. Fall back to
    // the raw JSON only if parsing fails.
    if let Some(ref pattern) = rule.to_contains {
        if !pattern.is_empty() {
            let pattern_lower = pattern.to_lowercase();
            let matched = match serde_json::from_str::<Vec<serde_json::Value>>(&mail.to_json) {
                Ok(arr) => arr.iter().any(|r| {
                    let name = r["name"].as_str().unwrap_or("");
                    let email = r["email"].as_str().unwrap_or("");
                    format!("{} {}", name, email).to_lowercase().contains(&pattern_lower)
                }),
                Err(_) => mail.to_json.to_lowercase().contains(&pattern_lower),
            };
            if !matched {
                return false;
            }
        }
    }

    if let Some(ref pattern) = rule.subject_contains {
        if !pattern.is_empty() {
            let pattern_lower = pattern.to_lowercase();
            let subject_lower = mail.subject.to_lowercase();
            if !subject_lower.contains(&pattern_lower) {
                return false;
            }
        }
    }

    if let Some(expected) = rule.has_attachments {
        if mail.has_attachments != expected {
            return false;
        }
    }

    true
}

/// Apply rule actions to a mail: update the local DB AND queue a matching
/// `pending_ops` row so the action syncs to the server on the next sync.
fn apply_actions(
    conn: &rusqlite::Connection,
    rule: &Rule,
    mail_id: &str,
    mail: &MailMeta,
    account_id: &str,
    is_gmail: bool,
) {
    if rule.action_mark_read == Some(true) {
        if let Err(e) = conn.execute(
            "UPDATE mails SET is_read = 1 WHERE id = ?1",
            rusqlite::params![mail_id],
        ) {
            log::warn!("rule {}: failed to mark mail {} as read: {}", rule.id, mail_id, e);
        } else {
            let payload = serde_json::json!({ "value": true, "api_id": mail.message_id }).to_string();
            enqueue_op(conn, account_id, mail_id, "set_read", &payload);
        }
    }

    if rule.action_star == Some(true) {
        if let Err(e) = conn.execute(
            "UPDATE mails SET is_starred = 1 WHERE id = ?1",
            rusqlite::params![mail_id],
        ) {
            log::warn!("rule {}: failed to star mail {}: {}", rule.id, mail_id, e);
        } else {
            let payload = serde_json::json!({ "value": true, "api_id": mail.message_id }).to_string();
            enqueue_op(conn, account_id, mail_id, "set_star", &payload);
        }
    }

    if rule.action_trash == Some(true) {
        if let Some((trash_id, trash_path)) = folder_of_type(conn, account_id, "trash") {
            if let Err(e) = conn.execute(
                "UPDATE mails SET folder_id = ?1 WHERE id = ?2",
                rusqlite::params![trash_id, mail_id],
            ) {
                log::warn!("rule {}: failed to trash mail {}: {}", rule.id, mail_id, e);
            } else {
                let payload = serde_json::json!({
                    "api_id": mail.message_id,
                    "message_id": mail.message_id,
                    "source_folder": mail.source_folder_path,
                    "dest_folder": trash_path,
                    "is_gmail": is_gmail,
                }).to_string();
                enqueue_op(conn, account_id, mail_id, "trash", &payload);
            }
            return; // Don't apply move/archive after trash
        }
    }

    if rule.action_archive == Some(true) {
        if let Some((archive_id, archive_path)) = folder_of_type(conn, account_id, "archive") {
            if let Err(e) = conn.execute(
                "UPDATE mails SET folder_id = ?1 WHERE id = ?2",
                rusqlite::params![archive_id, mail_id],
            ) {
                log::warn!("rule {}: failed to archive mail {}: {}", rule.id, mail_id, e);
            } else {
                let payload = serde_json::json!({
                    "api_id": mail.message_id,
                    "message_id": mail.message_id,
                    "source_folder": mail.source_folder_path,
                    "dest_folder": archive_path,
                    "is_gmail": is_gmail,
                }).to_string();
                enqueue_op(conn, account_id, mail_id, "archive", &payload);
            }
            return; // Don't apply move after archive
        }
    }

    if let Some(ref dest_folder_id) = rule.action_move_to_folder {
        if !dest_folder_id.is_empty() && *dest_folder_id != mail.folder_id {
            // Verify the destination folder still exists; if it was deleted, skip
            // the move and log (other actions of this rule already ran).
            let dest_path: Option<String> = conn
                .query_row(
                    "SELECT path FROM folders WHERE id = ?1",
                    rusqlite::params![dest_folder_id],
                    |row| row.get(0),
                )
                .ok();
            let Some(dest_path) = dest_path else {
                log::warn!("rule {}: move target folder {} no longer exists; skipping move of mail {}", rule.id, dest_folder_id, mail_id);
                return;
            };
            if let Err(e) = conn.execute(
                "UPDATE mails SET folder_id = ?1 WHERE id = ?2",
                rusqlite::params![dest_folder_id, mail_id],
            ) {
                log::warn!("rule {}: failed to move mail {} to folder {}: {}", rule.id, mail_id, dest_folder_id, e);
            } else {
                let payload = serde_json::json!({
                    "api_id": mail.message_id,
                    "message_id": mail.message_id,
                    "source_folder": mail.source_folder_path,
                    "dest_folder": dest_path,
                    "is_gmail": is_gmail,
                }).to_string();
                enqueue_op(conn, account_id, mail_id, "move", &payload);
            }
        }
    }
}

/// Queue a pending op (best-effort; logs on failure). Mirrors the manual
/// command's `INSERT OR REPLACE` dedup on the `(mail_id, op_type)` unique index.
fn enqueue_op(conn: &rusqlite::Connection, account_id: &str, mail_id: &str, op_type: &str, payload: &str) {
    if let Err(e) = conn.execute(
        "INSERT OR REPLACE INTO pending_ops (account_id, mail_id, op_type, payload, retry_count) VALUES (?1, ?2, ?3, ?4, 0)",
        rusqlite::params![account_id, mail_id, op_type, payload],
    ) {
        log::warn!("rule enqueue {} for mail {} failed: {}", op_type, mail_id, e);
    }
}

/// Look up the (id, path) of the account's folder of the given type.
fn folder_of_type(conn: &rusqlite::Connection, account_id: &str, folder_type: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = ?2 LIMIT 1",
        rusqlite::params![account_id, folder_type],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .ok()
}
