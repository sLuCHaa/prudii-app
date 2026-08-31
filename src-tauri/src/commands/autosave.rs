use crate::db::Database;
use tauri::State;

// Crash/quit safety net for compose windows: the frontend snapshots the whole
// draft (recipients, body, attachments) into one opaque JSON payload keyed by
// the compose window's label. A clean close (send / save draft / discard)
// deletes the row; whatever is left at next launch is offered for restore.

#[derive(serde::Serialize)]
pub struct ComposeAutosave {
    pub id: String,
    pub payload: String,
    pub updated_at: String,
}

#[tauri::command(async)]
pub fn save_compose_autosave(db: State<'_, Database>, id: String, payload: String) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute(
        "INSERT INTO compose_autosaves (id, payload, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        rusqlite::params![id, payload],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn delete_compose_autosave(db: State<'_, Database>, id: String) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute("DELETE FROM compose_autosaves WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn list_compose_autosaves(db: State<'_, Database>) -> Result<Vec<ComposeAutosave>, String> {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare("SELECT id, payload, updated_at FROM compose_autosaves ORDER BY updated_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ComposeAutosave {
                id: row.get(0)?,
                payload: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
