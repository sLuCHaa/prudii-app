use crate::db::Database;
use crate::models::{CreateRuleRequest, MailRule};
use tauri::State;

#[tauri::command]
pub fn list_rules(
    db: State<'_, Database>,
    account_id: String,
) -> Result<Vec<MailRule>, String> {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, name, enabled, priority, from_contains, to_contains, subject_contains, has_attachments, action_move_to_folder, action_mark_read, action_star, action_trash, action_archive, created_at FROM mail_rules WHERE account_id = ?1 ORDER BY priority DESC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rules = stmt
        .query_map(rusqlite::params![account_id], |row| {
            Ok(MailRule {
                id: row.get(0)?,
                account_id: row.get(1)?,
                name: row.get(2)?,
                enabled: row.get::<_, i32>(3)? != 0,
                priority: row.get(4)?,
                from_contains: row.get(5)?,
                to_contains: row.get(6)?,
                subject_contains: row.get(7)?,
                has_attachments: row.get::<_, Option<i32>>(8)?.map(|v| v != 0),
                action_move_to_folder: row.get(9)?,
                action_mark_read: row.get::<_, Option<i32>>(10)?.map(|v| v != 0),
                action_star: row.get::<_, Option<i32>>(11)?.map(|v| v != 0),
                action_trash: row.get::<_, Option<i32>>(12)?.map(|v| v != 0),
                action_archive: row.get::<_, Option<i32>>(13)?.map(|v| v != 0),
                created_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rules)
}

#[tauri::command]
pub fn create_rule(
    db: State<'_, Database>,
    request: CreateRuleRequest,
) -> Result<MailRule, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock_db();

    conn.execute(
        "INSERT INTO mail_rules (id, account_id, name, enabled, priority, from_contains, to_contains, subject_contains, has_attachments, action_move_to_folder, action_mark_read, action_star, action_trash, action_archive) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            id,
            request.account_id,
            request.name,
            request.enabled as i32,
            request.priority,
            request.from_contains,
            request.to_contains,
            request.subject_contains,
            request.has_attachments.map(|v| v as i32),
            request.action_move_to_folder,
            request.action_mark_read.map(|v| v as i32),
            request.action_star.map(|v| v as i32),
            request.action_trash.map(|v| v as i32),
            request.action_archive.map(|v| v as i32),
        ],
    )
    .map_err(|e| e.to_string())?;

    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM mail_rules WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(MailRule {
        id,
        account_id: request.account_id,
        name: request.name,
        enabled: request.enabled,
        priority: request.priority,
        from_contains: request.from_contains,
        to_contains: request.to_contains,
        subject_contains: request.subject_contains,
        has_attachments: request.has_attachments,
        action_move_to_folder: request.action_move_to_folder,
        action_mark_read: request.action_mark_read,
        action_star: request.action_star,
        action_trash: request.action_trash,
        action_archive: request.action_archive,
        created_at,
    })
}

#[tauri::command]
pub fn update_rule(
    db: State<'_, Database>,
    rule: MailRule,
) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute(
        "UPDATE mail_rules SET name = ?1, enabled = ?2, priority = ?3, from_contains = ?4, to_contains = ?5, subject_contains = ?6, has_attachments = ?7, action_move_to_folder = ?8, action_mark_read = ?9, action_star = ?10, action_trash = ?11, action_archive = ?12 WHERE id = ?13",
        rusqlite::params![
            rule.name,
            rule.enabled as i32,
            rule.priority,
            rule.from_contains,
            rule.to_contains,
            rule.subject_contains,
            rule.has_attachments.map(|v| v as i32),
            rule.action_move_to_folder,
            rule.action_mark_read.map(|v| v as i32),
            rule.action_star.map(|v| v as i32),
            rule.action_trash.map(|v| v as i32),
            rule.action_archive.map(|v| v as i32),
            rule.id,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn delete_rule(
    db: State<'_, Database>,
    rule_id: String,
) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute("DELETE FROM mail_rules WHERE id = ?1", rusqlite::params![rule_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply all enabled rules to the mails currently in the account's Inbox.
/// Returns the number of mails a rule matched. Resulting actions are queued as
/// `pending_ops` (by the engine), so they reach the server on the next sync.
#[tauri::command]
pub fn apply_rules_now(
    db: State<'_, Database>,
    account_id: String,
) -> Result<u32, String> {
    let inbox_id: String = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'inbox' LIMIT 1",
            rusqlite::params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| "No inbox folder found for this account".to_string())?
    };

    let mail_ids: Vec<String> = {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare("SELECT id FROM mails WHERE folder_id = ?1")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(rusqlite::params![inbox_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect::<Vec<String>>();
        ids
    };

    let mut total = 0u32;
    for chunk in mail_ids.chunks(500) {
        total += crate::rules::apply_rules_to_mails(&account_id, chunk, &db);
    }
    Ok(total)
}
