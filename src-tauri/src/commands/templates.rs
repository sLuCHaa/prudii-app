use crate::db::Database;
use crate::models::EmailTemplate;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn list_templates(db: State<'_, Database>) -> Result<Vec<EmailTemplate>, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare("SELECT id, name, subject, body_html, body_text, created_at, updated_at FROM email_templates ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let templates = stmt
            .query_map([], |row| {
                Ok(EmailTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    subject: row.get(2)?,
                    body_html: row.get(3)?,
                    body_text: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(templates)
    })
}

#[tauri::command]
pub fn create_template(
    db: State<'_, Database>,
    name: String,
    subject: String,
    body_html: String,
    body_text: String,
) -> Result<EmailTemplate, String> {
    super::catch_panic(|| {
        let id = Uuid::new_v4().to_string();
        let conn = db.lock_db();
        conn.execute(
            "INSERT INTO email_templates (id, name, subject, body_html, body_text) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, name, subject, body_html, body_text],
        )
        .map_err(|e| e.to_string())?;

        let template = conn
            .query_row(
                "SELECT id, name, subject, body_html, body_text, created_at, updated_at FROM email_templates WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok(EmailTemplate {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        subject: row.get(2)?,
                        body_html: row.get(3)?,
                        body_text: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?;

        Ok(template)
    })
}

#[tauri::command]
pub fn update_template(
    db: State<'_, Database>,
    id: String,
    name: String,
    subject: String,
    body_html: String,
    body_text: String,
) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE email_templates SET name = ?1, subject = ?2, body_html = ?3, body_text = ?4, updated_at = datetime('now') WHERE id = ?5",
            rusqlite::params![name, subject, body_html, body_text, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn delete_template(db: State<'_, Database>, id: String) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        conn.execute(
            "DELETE FROM email_templates WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}
