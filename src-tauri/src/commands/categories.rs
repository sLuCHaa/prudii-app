use super::mails::{dedup_mails, filter_clause, mail_columns, map_mail_row};
use crate::categorize::store::{self, CategoryCount, MailCategoryInfo, SenderRule};
use crate::db::Database;
use crate::models::Mail;
use tauri::State;

#[tauri::command(async)]
pub fn categorize_pending_mails(db: State<'_, Database>) -> Result<u32, String> {
    super::catch_panic(|| Ok(store::categorize_all_pending(&db) as u32))
}

#[tauri::command(async)]
pub fn list_category_mails(
    db: State<'_, Database>,
    category: String,
    folder_id: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    folder_filter: Option<String>,
    sort: Option<String>,
) -> Result<Vec<Mail>, String> {
    super::catch_panic(|| {
        let limit = limit.unwrap_or(500).min(2000);
        let offset = offset.unwrap_or(0);
        let extra = filter_clause(&folder_filter, "m.");
        let folder_clause = if folder_id.is_some() { " AND m.folder_id = ?4" } else { "" };
        let sql = format!(
            "SELECT {} FROM mails m JOIN folders f ON m.folder_id = f.id
             WHERE f.folder_type = 'inbox' AND m.category = ?1{folder_clause}
               AND (m.snoozed_until IS NULL OR m.snoozed_until = '' OR m.snoozed_until <= datetime('now')){extra}
             ORDER BY {} LIMIT ?2 OFFSET ?3",
            mail_columns("m.", false),
            crate::db::mail_sort::order_clause(sort.as_deref(), "m.", true),
        );
        let conn = db.lock_db();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mails = match &folder_id {
            Some(id) => stmt.query_map(rusqlite::params![category, limit, offset, id], map_mail_row),
            None => stmt.query_map(rusqlite::params![category, limit, offset], map_mail_row),
        }
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
        Ok(dedup_mails(mails))
    })
}

#[tauri::command(async)]
pub fn list_category_counts(db: State<'_, Database>) -> Result<Vec<CategoryCount>, String> {
    super::catch_panic(|| store::category_counts(&db.lock_db()).map_err(|e| e.to_string()))
}

#[tauri::command(async)]
pub fn get_mail_category_info(db: State<'_, Database>, mail_id: String) -> Result<Option<MailCategoryInfo>, String> {
    super::catch_panic(|| store::category_info(&db.lock_db(), &mail_id).map_err(|e| e.to_string()))
}

#[tauri::command(async)]
pub fn set_mail_category(
    db: State<'_, Database>,
    mail_id: String,
    category: Option<String>,
    remember_sender: bool,
) -> Result<u32, String> {
    super::catch_panic(|| {
        store::set_mail_category(&db.lock_db(), &mail_id, category.as_deref(), remember_sender).map(|n| n as u32)
    })
}

#[tauri::command(async)]
pub fn list_sender_categories(db: State<'_, Database>) -> Result<Vec<SenderRule>, String> {
    super::catch_panic(|| store::list_sender_rules(&db.lock_db()).map_err(|e| e.to_string()))
}

#[tauri::command(async)]
pub fn delete_sender_category(db: State<'_, Database>, email: String) -> Result<(), String> {
    super::catch_panic(|| store::delete_sender_rule(&db.lock_db(), &email).map_err(|e| e.to_string()))
}

#[tauri::command(async)]
pub fn reset_categories(db: State<'_, Database>) -> Result<(), String> {
    super::catch_panic(|| store::reset_all(&db.lock_db()).map_err(|e| e.to_string()))
}
