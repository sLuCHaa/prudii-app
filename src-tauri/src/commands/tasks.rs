use crate::db::Database;
use crate::models::{ChecklistItem, CreateTaskInput, Task, TaskAttachment, TaskDetail, TaskMailLink, UpdateTaskPatch};
use rusqlite::params;
use tauri::{AppHandle, Emitter, State};

const TASK_SELECT: &str = "SELECT t.id, t.title, t.description_html, t.status, t.priority, t.due_at, t.sort_order, t.reminder_sent, t.created_at, t.updated_at, t.completed_at,
  (SELECT COUNT(*) FROM task_checklist c WHERE c.task_id = t.id AND c.done = 1),
  (SELECT COUNT(*) FROM task_checklist c WHERE c.task_id = t.id),
  (SELECT COUNT(*) FROM task_mail_links l WHERE l.task_id = t.id),
  (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = t.id)
  FROM tasks t";

fn row_to_task(row: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        description_html: row.get(2)?,
        status: row.get(3)?,
        priority: row.get(4)?,
        due_at: row.get(5)?,
        sort_order: row.get(6)?,
        reminder_sent: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        completed_at: row.get(10)?,
        checklist_done: row.get(11)?,
        checklist_total: row.get(12)?,
        link_count: row.get(13)?,
        attachment_count: row.get(14)?,
    })
}

fn is_valid_status(status: &str) -> bool {
    matches!(status, "open" | "in_progress" | "done")
}

fn is_valid_priority(priority: &str) -> bool {
    matches!(priority, "low" | "normal" | "high")
}

/// Fetches a single task through an already-locked connection, so callers
/// that hold a transaction or a lock guard don't deadlock re-locking it.
fn fetch_task(conn: &rusqlite::Connection, id: &str) -> Result<Task, String> {
    let sql = format!("{} WHERE t.id = ?1", TASK_SELECT);
    conn.query_row(&sql, params![id], row_to_task)
        .map_err(|e| e.to_string())
}

fn list_tasks_impl(db: &Database, status: Option<String>) -> Result<Vec<Task>, String> {
    let conn = db.lock_db();
    let sql = format!(
        "{} {} ORDER BY t.status, t.sort_order, t.created_at",
        TASK_SELECT,
        if status.is_some() { "WHERE t.status = ?1" } else { "" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match &status {
        Some(s) => stmt.query_map(params![s], row_to_task),
        None => stmt.query_map([], row_to_task),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn get_task_impl(db: &Database, id: &str) -> Result<TaskDetail, String> {
    let conn = db.lock_db();
    let task = fetch_task(&conn, id)?;

    let mut checklist_stmt = conn
        .prepare("SELECT id, task_id, text, done, sort_order FROM task_checklist WHERE task_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let checklist = checklist_stmt
        .query_map(params![id], |row| {
            Ok(ChecklistItem {
                id: row.get(0)?,
                task_id: row.get(1)?,
                text: row.get(2)?,
                done: row.get::<_, i64>(3)? != 0,
                sort_order: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut links_stmt = conn
        .prepare("SELECT task_id, mail_id, account_id, subject, from_name, from_email, mail_date, created_at FROM task_mail_links WHERE task_id = ?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let links = links_stmt
        .query_map(params![id], |row| {
            Ok(TaskMailLink {
                task_id: row.get(0)?,
                mail_id: row.get(1)?,
                account_id: row.get(2)?,
                subject: row.get(3)?,
                from_name: row.get(4)?,
                from_email: row.get(5)?,
                mail_date: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut attach_stmt = conn
        .prepare("SELECT id, task_id, filename, mime_type, size_bytes, local_path, created_at FROM task_attachments WHERE task_id = ?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let attachments = attach_stmt
        .query_map(params![id], |row| {
            Ok(TaskAttachment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                filename: row.get(2)?,
                mime_type: row.get(3)?,
                size_bytes: row.get(4)?,
                local_path: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(TaskDetail { task, checklist, links, attachments })
}

fn create_task_impl(db: &Database, input: CreateTaskInput) -> Result<Task, String> {
    let status = input.status.unwrap_or_else(|| "open".into());
    let priority = input.priority.unwrap_or_else(|| "normal".into());
    if !is_valid_status(&status) {
        return Err("Invalid status".into());
    }
    if !is_valid_priority(&priority) {
        return Err("Invalid priority".into());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.lock_db();
    let next: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE status = ?1",
            [&status],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO tasks (id, title, description_html, status, priority, due_at, sort_order, created_at, updated_at, completed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)",
        params![
            id,
            input.title.trim(),
            input.description_html.unwrap_or_default(),
            status,
            priority,
            input.due_at,
            next,
            now,
            if status == "done" { Some(now.clone()) } else { None }
        ],
    )
    .map_err(|e| e.to_string())?;

    fetch_task(&conn, &id)
}

fn update_task_impl(db: &Database, id: &str, patch: UpdateTaskPatch) -> Result<Task, String> {
    if let Some(status) = &patch.status {
        if !is_valid_status(status) {
            return Err("Invalid status".into());
        }
    }
    if let Some(priority) = &patch.priority {
        if !is_valid_priority(priority) {
            return Err("Invalid priority".into());
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.lock_db();
    let title = patch.title.as_ref().map(|t| t.trim().to_string());
    let affected = conn
        .execute(
            "UPDATE tasks SET
                title = COALESCE(?1, title),
                description_html = COALESCE(?2, description_html),
                status = COALESCE(?3, status),
                priority = COALESCE(?4, priority),
                due_at = CASE WHEN ?5 = 1 THEN NULL WHEN ?6 IS NOT NULL THEN ?6 ELSE due_at END,
                completed_at = CASE WHEN ?3 IS NULL THEN completed_at WHEN ?3 = 'done' THEN COALESCE(completed_at, ?7) ELSE NULL END,
                updated_at = ?7
            WHERE id = ?8",
            params![
                title,
                patch.description_html,
                patch.status,
                patch.priority,
                patch.clear_due_at.unwrap_or(false),
                patch.due_at,
                now,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("Task not found".into());
    }

    fetch_task(&conn, id)
}

fn delete_task_impl(db: &Database, id: &str) -> Result<(), String> {
    let affected = {
        let conn = db.lock_db();
        conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?
    };
    if affected == 0 {
        return Err("Task not found".into());
    }

    let dir = db.data_dir.join("task_files").join(id);
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(())
}

fn move_task_impl(db: &Database, id: &str, status: &str, index: i64) -> Result<Vec<Task>, String> {
    if !is_valid_status(status) {
        return Err("Invalid status".into());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.lock_db();
    let mut ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM tasks WHERE status = ?1 AND id != ?2 ORDER BY sort_order, created_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![status, id], |r| r.get(0)).map_err(|e| e.to_string())?;
        let collected = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        collected
    };
    let idx = (index.max(0) as usize).min(ids.len());
    ids.insert(idx, id.to_string());

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET status = ?1, updated_at = ?2, completed_at = CASE WHEN ?1 = 'done' THEN COALESCE(completed_at, ?2) ELSE NULL END WHERE id = ?3",
        params![status, now, id],
    )
    .map_err(|e| e.to_string())?;
    // Renumbering the whole column keeps sort_order dense; columns are small.
    for (i, tid) in ids.iter().enumerate() {
        tx.execute("UPDATE tasks SET sort_order = ?1 WHERE id = ?2", params![i as f64, tid])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    let sql = format!("{} WHERE t.status = ?1 ORDER BY t.sort_order, t.created_at", TASK_SELECT);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map(params![status], row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tasks)
}

fn count_open_impl(db: &Database) -> Result<i64, String> {
    let conn = db.lock_db();
    conn.query_row("SELECT COUNT(*) FROM tasks WHERE status != 'done'", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_tasks(db: State<'_, Database>, status: Option<String>) -> Result<Vec<Task>, String> {
    super::catch_panic(|| list_tasks_impl(&db, status))
}

#[tauri::command(async)]
pub fn get_task(db: State<'_, Database>, id: String) -> Result<TaskDetail, String> {
    super::catch_panic(|| get_task_impl(&db, &id))
}

#[tauri::command(async)]
pub fn create_task(app: AppHandle, db: State<'_, Database>, input: CreateTaskInput) -> Result<Task, String> {
    super::catch_panic(|| {
        let task = create_task_impl(&db, input)?;
        let _ = app.emit("tasks-changed", ());
        Ok(task)
    })
}

#[tauri::command(async)]
pub fn update_task(app: AppHandle, db: State<'_, Database>, id: String, patch: UpdateTaskPatch) -> Result<Task, String> {
    super::catch_panic(|| {
        let task = update_task_impl(&db, &id, patch)?;
        let _ = app.emit("tasks-changed", ());
        Ok(task)
    })
}

#[tauri::command(async)]
pub fn delete_task(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    super::catch_panic(|| {
        delete_task_impl(&db, &id)?;
        let _ = app.emit("tasks-changed", ());
        Ok(())
    })
}

#[tauri::command(async)]
pub fn move_task(app: AppHandle, db: State<'_, Database>, id: String, status: String, index: i64) -> Result<Vec<Task>, String> {
    super::catch_panic(|| {
        let tasks = move_task_impl(&db, &id, &status, index)?;
        let _ = app.emit("tasks-changed", ());
        Ok(tasks)
    })
}

#[tauri::command(async)]
pub fn count_open_tasks(db: State<'_, Database>) -> Result<i64, String> {
    super::catch_panic(|| count_open_impl(&db))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    #[test]
    fn move_renumbers_the_target_column_and_sets_completed_at() {
        let db = temp_db();
        let a = create_task_impl(&db, CreateTaskInput { title: "a".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let b = create_task_impl(&db, CreateTaskInput { title: "b".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let c = create_task_impl(&db, CreateTaskInput { title: "c".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        assert_eq!((a.sort_order, b.sort_order, c.sort_order), (0.0, 1.0, 2.0));
        let open = move_task_impl(&db, &c.id, "open", 0).unwrap();
        assert_eq!(open.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["c", "a", "b"]);
        let done = move_task_impl(&db, &a.id, "done", 0).unwrap();
        assert_eq!(done.len(), 1);
        assert!(done[0].completed_at.is_some());
        assert_eq!(count_open_impl(&db).unwrap(), 2);
    }

    #[test]
    fn create_rejects_invalid_status_and_priority() {
        let db = temp_db();
        assert!(create_task_impl(&db, CreateTaskInput { title: "x".into(), description_html: None, status: Some("bogus".into()), priority: None, due_at: None }).is_err());
        assert!(create_task_impl(&db, CreateTaskInput { title: "x".into(), description_html: None, status: None, priority: Some("urgent".into()), due_at: None }).is_err());
    }

    #[test]
    fn update_toggles_completed_at_and_preserves_untouched_fields() {
        let db = temp_db();
        let a = create_task_impl(&db, CreateTaskInput { title: "a".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let done = update_task_impl(&db, &a.id, UpdateTaskPatch { title: None, description_html: None, status: Some("done".into()), priority: None, due_at: None, clear_due_at: None }).unwrap();
        assert_eq!(done.status, "done");
        assert!(done.completed_at.is_some());
        assert_eq!(done.title, "a");

        let reopened = update_task_impl(&db, &a.id, UpdateTaskPatch { title: None, description_html: None, status: Some("open".into()), priority: None, due_at: None, clear_due_at: None }).unwrap();
        assert!(reopened.completed_at.is_none());
    }

    #[test]
    fn delete_removes_the_task_file_directory() {
        let db = temp_db();
        let a = create_task_impl(&db, CreateTaskInput { title: "a".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let dir = db.data_dir.join("task_files").join(&a.id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("note.txt"), b"x").unwrap();
        delete_task_impl(&db, &a.id).unwrap();
        assert!(!dir.exists());
        assert!(delete_task_impl(&db, &a.id).is_err());
    }
}
