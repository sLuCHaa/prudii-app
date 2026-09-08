use crate::db::Database;
use crate::models::{ChecklistItem, CreateTaskInput, Task, TaskAttachment, TaskDetail, TaskMailLink, UpdateTaskPatch};
use base64::Engine;
use rusqlite::params;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

fn fetch_checklist_item(conn: &rusqlite::Connection, id: &str) -> Result<ChecklistItem, String> {
    conn.query_row(
        "SELECT id, task_id, text, done, sort_order FROM task_checklist WHERE id = ?1",
        params![id],
        |row| {
            Ok(ChecklistItem {
                id: row.get(0)?,
                task_id: row.get(1)?,
                text: row.get(2)?,
                done: row.get::<_, i64>(3)? != 0,
                sort_order: row.get(4)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Fields copied from `mails` into a `task_mail_links` row at link time, so the
/// link survives the source mail being deleted or re-synced.
struct MailSnapshot {
    subject: String,
    from_name: String,
    from_email: String,
    date: String,
    snippet: String,
}

fn mail_snapshot(conn: &rusqlite::Connection, mail_id: &str) -> Result<MailSnapshot, String> {
    conn.query_row(
        "SELECT subject, from_name, from_email, date, snippet FROM mails WHERE id = ?1",
        params![mail_id],
        |row| {
            Ok(MailSnapshot {
                subject: row.get(0)?,
                from_name: row.get(1)?,
                from_email: row.get(2)?,
                date: row.get(3)?,
                snippet: row.get(4)?,
            })
        },
    )
    .map_err(|e| format!("Mail not found: {}", e))
}

fn insert_mail_link(
    conn: &rusqlite::Connection,
    task_id: &str,
    mail_id: &str,
    account_id: &str,
    snap: &MailSnapshot,
    now: &str,
) -> Result<(), String> {
    // Primary key is (task_id, mail_id); OR IGNORE makes re-linking a no-op.
    conn.execute(
        "INSERT OR IGNORE INTO task_mail_links (task_id, mail_id, account_id, subject, from_name, from_email, mail_date, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![task_id, mail_id, account_id, snap.subject, snap.from_name, snap.from_email, snap.date, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn guess_mime_type(filename: &str) -> &'static str {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// Appends a " (n)" suffix before the extension until the name is free, matching
/// how Windows/macOS Finder resolve a copy into an already-populated folder.
fn unique_dest_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let name_path = Path::new(filename);
    let stem = name_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| filename.to_string());
    let ext = name_path.extension().map(|e| e.to_string_lossy().to_string());
    let mut n = 2;
    loop {
        let candidate_name = match &ext {
            Some(e) => format!("{} ({}).{}", stem, n, e),
            None => format!("{} ({})", stem, n),
        };
        let candidate = dir.join(&candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn resolve_task_file_path(db: &Database, attachment_id: &str) -> Result<PathBuf, String> {
    let path: String = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT local_path FROM task_attachments WHERE id = ?1",
            params![attachment_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Attachment not found: {}", e))?
    };

    let canonical_path = Path::new(&path).canonicalize().map_err(|e| format!("Invalid attachment path: {}", e))?;
    let data_dir = db.data_dir.canonicalize().map_err(|e| format!("Cannot resolve data dir: {}", e))?;
    if !canonical_path.starts_with(&data_dir) {
        return Err("Attachment path is outside app data directory".into());
    }
    Ok(canonical_path)
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

// The inner `collected` binding is not redundant: it forces the query_map
// iterator (borrowing `stmt`) to be dropped before the block ends, which the
// `?`-chained tail-expression form does not do (E0597, temporary outlives `stmt`).
#[allow(clippy::let_and_return)]
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
    let affected = tx
        .execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2, completed_at = CASE WHEN ?1 = 'done' THEN COALESCE(completed_at, ?2) ELSE NULL END WHERE id = ?3",
            params![status, now, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        // tx is dropped here without commit, rolling back — no renumbering is persisted.
        return Err("Task not found".into());
    }
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

fn add_checklist_item_impl(db: &Database, task_id: &str, text: &str) -> Result<ChecklistItem, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock_db();
    let next: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM task_checklist WHERE task_id = ?1",
            params![task_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO task_checklist (id, task_id, text, sort_order) VALUES (?1,?2,?3,?4)",
        params![id, task_id, text.trim(), next],
    )
    .map_err(|e| e.to_string())?;
    fetch_checklist_item(&conn, &id)
}

fn update_checklist_item_impl(db: &Database, id: &str, text: Option<String>, done: Option<bool>) -> Result<ChecklistItem, String> {
    let conn = db.lock_db();
    let text = text.map(|t| t.trim().to_string());
    let done = done.map(|d| d as i64);
    let affected = conn
        .execute(
            "UPDATE task_checklist SET text = COALESCE(?1, text), done = COALESCE(?2, done) WHERE id = ?3",
            params![text, done, id],
        )
        .map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("Checklist item not found".into());
    }
    fetch_checklist_item(&conn, id)
}

fn delete_checklist_item_impl(db: &Database, id: &str) -> Result<(), String> {
    let conn = db.lock_db();
    let affected = conn.execute("DELETE FROM task_checklist WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    if affected == 0 {
        return Err("Checklist item not found".into());
    }
    Ok(())
}

fn reorder_checklist_impl(db: &Database, task_id: &str, ids: Vec<String>) -> Result<(), String> {
    let conn = db.lock_db();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (i, item_id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE task_checklist SET sort_order = ?1 WHERE id = ?2 AND task_id = ?3",
            params![i as f64, item_id, task_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn create_task_from_mail_impl(db: &Database, mail_id: &str, account_id: &str) -> Result<Task, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.lock_db();
    let snap = mail_snapshot(&conn, mail_id)?;
    let title = if snap.subject.trim().is_empty() { "(no subject)".to_string() } else { snap.subject.clone() };
    let description_html = format!("<p>{}</p>", escape_html(&snap.snippet));

    // Task creation and the link snapshot commit together, so a failed link
    // (e.g. the mail vanished mid-call) never leaves an orphaned task behind.
    let id = uuid::Uuid::new_v4().to_string();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let next: f64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE status = 'open'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO tasks (id, title, description_html, status, priority, sort_order, created_at, updated_at) VALUES (?1,?2,?3,'open','normal',?4,?5,?5)",
        params![id, title, description_html, next, now],
    )
    .map_err(|e| e.to_string())?;

    insert_mail_link(&tx, &id, mail_id, account_id, &snap, &now)?;
    tx.commit().map_err(|e| e.to_string())?;

    fetch_task(&conn, &id)
}

fn link_task_mail_impl(db: &Database, task_id: &str, mail_id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.lock_db();
    let account_id: String = conn
        .query_row("SELECT account_id FROM mails WHERE id = ?1", params![mail_id], |r| r.get(0))
        .map_err(|e| format!("Mail not found: {}", e))?;
    let snap = mail_snapshot(&conn, mail_id)?;
    insert_mail_link(&conn, task_id, mail_id, &account_id, &snap, &now)
}

fn unlink_task_mail_impl(db: &Database, task_id: &str, mail_id: &str) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute("DELETE FROM task_mail_links WHERE task_id = ?1 AND mail_id = ?2", params![task_id, mail_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// See move_task_impl above for why `tasks` is bound before being returned:
// it forces the query_map iterator (borrowing `stmt`) to drop first (E0597).
#[allow(clippy::let_and_return)]
fn tasks_for_mail_impl(db: &Database, mail_id: &str) -> Result<Vec<Task>, String> {
    let conn = db.lock_db();
    let sql = format!("{} JOIN task_mail_links l ON l.task_id = t.id WHERE l.mail_id = ?1 ORDER BY t.created_at", TASK_SELECT);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map(params![mail_id], row_to_task)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tasks)
}

fn tasks_for_mails_impl(db: &Database, mail_ids: Vec<String>) -> Result<HashMap<String, i64>, String> {
    let mut result = HashMap::new();
    if mail_ids.is_empty() {
        return Ok(result);
    }

    let conn = db.lock_db();
    let placeholders = mail_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT mail_id, COUNT(*) FROM task_mail_links WHERE mail_id IN ({}) GROUP BY mail_id", placeholders);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let bound: Vec<&dyn rusqlite::ToSql> = mail_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(bound.as_slice(), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (mail_id, count) = row.map_err(|e| e.to_string())?;
        result.insert(mail_id, count);
    }
    Ok(result)
}

fn remove_task_attachment_impl(db: &Database, id: &str) -> Result<(), String> {
    let path = resolve_task_file_path(db, id)?;
    let affected = {
        let conn = db.lock_db();
        conn.execute("DELETE FROM task_attachments WHERE id = ?1", params![id]).map_err(|e| e.to_string())?
    };
    if affected == 0 {
        return Err("Attachment not found".into());
    }
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

/// Result of copying picked files into a task's folder: files that made it in,
/// plus the filenames of any that didn't (copy or DB-insert failure). Kept
/// separate from a plain `Result` so the caller can emit `tasks-changed` for
/// the partial success case and still surface which files need retrying.
#[derive(Debug)]
struct CopyOutcome {
    added: Vec<TaskAttachment>,
    failed: Vec<String>,
}

/// Copies picked files into `data_dir/task_files/{task_id}/`, recording one
/// `task_attachments` row per successful copy. A per-file failure is recorded
/// in `failed` and does not stop the remaining files from being processed;
/// only an unknown task id (checked up front, before any directory is
/// created) fails the whole call.
fn copy_files_into_task(db: &Database, task_id: &str, paths: Vec<PathBuf>) -> Result<CopyOutcome, String> {
    let conn = db.lock_db();
    fetch_task(&conn, task_id).map_err(|_| "Task not found".to_string())?;

    let dest_dir = db.data_dir.join("task_files").join(task_id);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let mut added = Vec::new();
    let mut failed = Vec::new();
    for src in paths {
        let filename = src.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| "file".to_string());
        let dest = unique_dest_path(&dest_dir, &filename);
        if let Err(e) = std::fs::copy(&src, &dest) {
            log::warn!("Failed to copy \"{}\" into task {}: {}", filename, task_id, e);
            let _ = std::fs::remove_file(&dest); // a partially-written copy must not linger
            failed.push(filename);
            continue;
        }

        let size_bytes = std::fs::metadata(&dest).map(|m| m.len() as i64).unwrap_or(0);
        let dest_filename = dest.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| filename.clone());
        let mime = guess_mime_type(&dest_filename).to_string();
        let local_path = dest.to_string_lossy().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        if let Err(e) = conn.execute(
            "INSERT INTO task_attachments (id, task_id, filename, mime_type, size_bytes, local_path, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![id, task_id, dest_filename, mime, size_bytes, local_path, now],
        ) {
            log::warn!("Failed to record attachment \"{}\" for task {}: {}", dest_filename, task_id, e);
            let _ = std::fs::remove_file(&dest); // don't leave a file on disk with no DB record
            failed.push(dest_filename);
            continue;
        }

        added.push(TaskAttachment { id, task_id: task_id.to_string(), filename: dest_filename, mime_type: mime, size_bytes, local_path, created_at: now });
    }

    Ok(CopyOutcome { added, failed })
}

/// Decodes a dropped file's base64 payload to a scratch file (named after the drop's
/// filename), then reuses `copy_files_into_task` for naming, mime-guessing and the DB insert.
fn add_task_attachment_data_impl(
    db: &Database,
    task_id: &str,
    filename: &str,
    data_base64: &str,
) -> Result<TaskAttachment, String> {
    let safe_filename = Path::new(filename)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| "file".to_string());

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("Invalid file data: {}", e))?;

    let scratch_dir = std::env::temp_dir().join(format!("prudii-drop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch_dir).map_err(|e| e.to_string())?;
    let scratch_path = scratch_dir.join(&safe_filename);
    std::fs::write(&scratch_path, &bytes).map_err(|e| e.to_string())?;

    let outcome = copy_files_into_task(db, task_id, vec![scratch_path]);
    let _ = std::fs::remove_dir_all(&scratch_dir);
    let CopyOutcome { mut added, mut failed } = outcome?;

    added.pop().ok_or_else(|| failed.pop().unwrap_or_else(|| "Failed to add attachment".to_string()))
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

#[tauri::command(async)]
pub fn add_checklist_item(app: AppHandle, db: State<'_, Database>, task_id: String, text: String) -> Result<ChecklistItem, String> {
    super::catch_panic(|| {
        let item = add_checklist_item_impl(&db, &task_id, &text)?;
        let _ = app.emit("tasks-changed", ());
        Ok(item)
    })
}

#[tauri::command(async)]
pub fn update_checklist_item(
    app: AppHandle,
    db: State<'_, Database>,
    id: String,
    text: Option<String>,
    done: Option<bool>,
) -> Result<ChecklistItem, String> {
    super::catch_panic(|| {
        let item = update_checklist_item_impl(&db, &id, text, done)?;
        let _ = app.emit("tasks-changed", ());
        Ok(item)
    })
}

#[tauri::command(async)]
pub fn delete_checklist_item(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    super::catch_panic(|| {
        delete_checklist_item_impl(&db, &id)?;
        let _ = app.emit("tasks-changed", ());
        Ok(())
    })
}

#[tauri::command(async)]
pub fn reorder_checklist(app: AppHandle, db: State<'_, Database>, task_id: String, ids: Vec<String>) -> Result<(), String> {
    super::catch_panic(|| {
        reorder_checklist_impl(&db, &task_id, ids)?;
        let _ = app.emit("tasks-changed", ());
        Ok(())
    })
}

#[tauri::command(async)]
pub fn create_task_from_mail(app: AppHandle, db: State<'_, Database>, mail_id: String, account_id: String) -> Result<Task, String> {
    super::catch_panic(|| {
        let task = create_task_from_mail_impl(&db, &mail_id, &account_id)?;
        let _ = app.emit("tasks-changed", ());
        Ok(task)
    })
}

#[tauri::command(async)]
pub fn link_task_mail(app: AppHandle, db: State<'_, Database>, task_id: String, mail_id: String) -> Result<(), String> {
    super::catch_panic(|| {
        link_task_mail_impl(&db, &task_id, &mail_id)?;
        let _ = app.emit("tasks-changed", ());
        Ok(())
    })
}

#[tauri::command(async)]
pub fn unlink_task_mail(app: AppHandle, db: State<'_, Database>, task_id: String, mail_id: String) -> Result<(), String> {
    super::catch_panic(|| {
        unlink_task_mail_impl(&db, &task_id, &mail_id)?;
        let _ = app.emit("tasks-changed", ());
        Ok(())
    })
}

#[tauri::command(async)]
pub fn tasks_for_mail(db: State<'_, Database>, mail_id: String) -> Result<Vec<Task>, String> {
    super::catch_panic(|| tasks_for_mail_impl(&db, &mail_id))
}

#[tauri::command(async)]
pub fn tasks_for_mails(db: State<'_, Database>, mail_ids: Vec<String>) -> Result<HashMap<String, i64>, String> {
    super::catch_panic(|| tasks_for_mails_impl(&db, mail_ids))
}

#[tauri::command]
pub async fn add_task_attachments(app: AppHandle, db: State<'_, Database>, task_id: String) -> Result<Vec<TaskAttachment>, String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let picked = rx.recv().map_err(|e| format!("Dialog error: {}", e))?;
    let Some(paths) = picked else {
        return Ok(Vec::new()); // user cancelled
    };
    let paths: Vec<PathBuf> = paths.into_iter().filter_map(|p| p.as_path().map(|p| p.to_path_buf())).collect();

    let outcome = copy_files_into_task(&db, &task_id, paths)?;

    if !outcome.added.is_empty() {
        let _ = app.emit("tasks-changed", ());
    }
    if !outcome.failed.is_empty() {
        return Err(format!("Could not add: {}", outcome.failed.join(", ")));
    }
    Ok(outcome.added)
}

#[tauri::command(async)]
pub fn add_task_attachment_data(
    app: AppHandle,
    db: State<'_, Database>,
    task_id: String,
    filename: String,
    data_base64: String,
) -> Result<TaskAttachment, String> {
    super::catch_panic(|| {
        let attachment = add_task_attachment_data_impl(&db, &task_id, &filename, &data_base64)?;
        let _ = app.emit("tasks-changed", ());
        Ok(attachment)
    })
}

#[tauri::command(async)]
pub fn remove_task_attachment(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    super::catch_panic(|| {
        remove_task_attachment_impl(&db, &id)?;
        let _ = app.emit("tasks-changed", ());
        Ok(())
    })
}

#[tauri::command(async)]
pub fn open_task_attachment(db: State<'_, Database>, id: String) -> Result<String, String> {
    let canonical_path = resolve_task_file_path(&db, &id)?;
    super::mails::open_path_with_os(&canonical_path)?;
    Ok(canonical_path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn reveal_task_attachment(app: AppHandle, db: State<'_, Database>, id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = resolve_task_file_path(&db, &id)?;
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_task_attachment_drag(window: tauri::Window, db: State<'_, Database>, id: String) -> Result<(), String> {
    let canonical_path = resolve_task_file_path(&db, &id)?;
    super::mails::start_native_drag(&window, canonical_path)
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
    fn move_rejects_unknown_task_id_and_leaves_sort_orders_unchanged() {
        let db = temp_db();
        let a = create_task_impl(&db, CreateTaskInput { title: "a".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let b = create_task_impl(&db, CreateTaskInput { title: "b".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        assert!(move_task_impl(&db, "nope", "open", 0).is_err());
        let after = list_tasks_impl(&db, Some("open".into())).unwrap();
        assert_eq!(
            after.iter().map(|t| (t.id.clone(), t.sort_order)).collect::<Vec<_>>(),
            vec![(a.id.clone(), a.sort_order), (b.id.clone(), b.sort_order)]
        );
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

    fn insert_mail_row(db: &Database, mail_id: &str, subject: &str, snippet: &str) {
        let conn = db.lock_db();
        conn.execute(
            "INSERT OR IGNORE INTO accounts (id, email, display_name, provider, imap_host, smtp_host) VALUES ('acc1','a@example.com','A','imap','imap.example.com','smtp.example.com')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO folders (id, account_id, name, path) VALUES ('fld1','acc1','Inbox','INBOX')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mails (id, account_id, folder_id, subject, from_name, from_email, date, snippet) VALUES (?1,'acc1','fld1',?2,'Sender','sender@example.com','2026-01-01T00:00:00Z',?3)",
            params![mail_id, subject, snippet],
        )
        .unwrap();
    }

    #[test]
    fn checklist_add_toggle_and_reorder() {
        let db = temp_db();
        let task = create_task_impl(&db, CreateTaskInput { title: "t".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let a = add_checklist_item_impl(&db, &task.id, "a").unwrap();
        let b = add_checklist_item_impl(&db, &task.id, "b").unwrap();
        assert_eq!((a.sort_order, b.sort_order), (0.0, 1.0));
        assert!(!a.done);

        let toggled = update_checklist_item_impl(&db, &a.id, None, Some(true)).unwrap();
        assert!(toggled.done);
        assert_eq!(toggled.text, "a");

        reorder_checklist_impl(&db, &task.id, vec![b.id.clone(), a.id.clone()]).unwrap();
        let detail = get_task_impl(&db, &task.id).unwrap();
        assert_eq!(detail.checklist.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![b.id.clone(), a.id.clone()]);

        delete_checklist_item_impl(&db, &a.id).unwrap();
        let detail = get_task_impl(&db, &task.id).unwrap();
        assert_eq!(detail.checklist.len(), 1);
        assert!(delete_checklist_item_impl(&db, &a.id).is_err());
    }

    #[test]
    fn create_task_from_mail_links_and_counts_correctly() {
        let db = temp_db();
        insert_mail_row(&db, "mail1", "Hello World", "A short preview");

        let task = create_task_from_mail_impl(&db, "mail1", "acc1").unwrap();
        assert_eq!(task.title, "Hello World");
        assert_eq!(task.link_count, 1);
        assert_eq!(task.description_html, "<p>A short preview</p>");

        let counts = tasks_for_mails_impl(&db, vec!["mail1".into()]).unwrap();
        assert_eq!(counts.get("mail1"), Some(&1));

        let for_mail = tasks_for_mail_impl(&db, "mail1").unwrap();
        assert_eq!(for_mail.len(), 1);
        assert_eq!(for_mail[0].id, task.id);

        unlink_task_mail_impl(&db, &task.id, "mail1").unwrap();
        let counts_after = tasks_for_mails_impl(&db, vec!["mail1".into()]).unwrap();
        assert_eq!(counts_after.get("mail1").copied().unwrap_or(0), 0);
        assert_eq!(tasks_for_mail_impl(&db, "mail1").unwrap().len(), 0);
    }

    #[test]
    fn create_task_from_mail_defaults_title_and_escapes_snippet() {
        let db = temp_db();
        insert_mail_row(&db, "mail2", "", "<b>Bold</b> & more");
        let task = create_task_from_mail_impl(&db, "mail2", "acc1").unwrap();
        assert_eq!(task.title, "(no subject)");
        assert_eq!(task.description_html, "<p>&lt;b&gt;Bold&lt;/b&gt; &amp; more</p>");
    }

    #[test]
    fn link_task_mail_ignores_duplicates() {
        let db = temp_db();
        insert_mail_row(&db, "mail3", "Subj", "preview");
        let task = create_task_impl(&db, CreateTaskInput { title: "t".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        link_task_mail_impl(&db, &task.id, "mail3").unwrap();
        link_task_mail_impl(&db, &task.id, "mail3").unwrap();
        let detail = get_task_impl(&db, &task.id).unwrap();
        assert_eq!(detail.links.len(), 1);
    }

    #[test]
    fn guess_mime_type_known_and_unknown_extensions() {
        assert_eq!(guess_mime_type("report.pdf"), "application/pdf");
        assert_eq!(guess_mime_type("archive.tar.gz"), "application/octet-stream");
        assert_eq!(guess_mime_type("noext"), "application/octet-stream");
    }

    #[test]
    fn unique_dest_path_appends_numbered_suffix_on_collision() {
        let dir = std::env::temp_dir().join(format!("prudii-test-dest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("file.txt"), b"a").unwrap();
        let p = unique_dest_path(&dir, "file.txt");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "file (2).txt");
        std::fs::write(&p, b"b").unwrap();
        let p2 = unique_dest_path(&dir, "file.txt");
        assert_eq!(p2.file_name().unwrap().to_string_lossy(), "file (3).txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_files_into_task_succeeds_and_records_attachment() {
        let db = temp_db();
        let task = create_task_impl(&db, CreateTaskInput { title: "t".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();

        let src_dir = std::env::temp_dir().join(format!("prudii-test-src-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("report.pdf");
        std::fs::write(&src_file, b"content").unwrap();

        let outcome = copy_files_into_task(&db, &task.id, vec![src_file.clone()]).unwrap();
        assert_eq!(outcome.added.len(), 1);
        assert!(outcome.failed.is_empty());
        assert_eq!(outcome.added[0].filename, "report.pdf");
        assert_eq!(outcome.added[0].mime_type, "application/pdf");

        let detail = get_task_impl(&db, &task.id).unwrap();
        assert_eq!(detail.attachments.len(), 1);
        assert!(std::path::Path::new(&detail.attachments[0].local_path).exists());

        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn add_task_attachment_data_decodes_and_records_attachment() {
        let db = temp_db();
        let task = create_task_impl(&db, CreateTaskInput { title: "t".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(b"dropped content");

        let attachment = add_task_attachment_data_impl(&db, &task.id, "dropped.txt", &data_base64).unwrap();
        assert_eq!(attachment.filename, "dropped.txt");
        assert_eq!(attachment.mime_type, "text/plain");
        assert!(std::path::Path::new(&attachment.local_path).exists());
        assert_eq!(std::fs::read(&attachment.local_path).unwrap(), b"dropped content");

        let detail = get_task_impl(&db, &task.id).unwrap();
        assert_eq!(detail.attachments.len(), 1);
    }

    #[test]
    fn add_task_attachment_data_rejects_invalid_base64() {
        let db = temp_db();
        let task = create_task_impl(&db, CreateTaskInput { title: "t".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        assert!(add_task_attachment_data_impl(&db, &task.id, "note.txt", "not-base64!!").is_err());
    }

    #[test]
    fn add_task_attachment_data_rejects_unknown_task_id() {
        let db = temp_db();
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(b"x");
        assert!(add_task_attachment_data_impl(&db, "does-not-exist", "note.txt", &data_base64).is_err());
    }

    #[test]
    fn copy_files_into_task_rejects_unknown_task_id() {
        let db = temp_db();
        let src_dir = std::env::temp_dir().join(format!("prudii-test-src-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("note.txt");
        std::fs::write(&src_file, b"content").unwrap();

        let err = copy_files_into_task(&db, "does-not-exist", vec![src_file]).unwrap_err();
        assert_eq!(err, "Task not found");
        assert!(!db.data_dir.join("task_files").join("does-not-exist").exists());

        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn remove_task_attachment_deletes_row_and_file() {
        let db = temp_db();
        let task = create_task_impl(&db, CreateTaskInput { title: "t".into(), description_html: None, status: None, priority: None, due_at: None }).unwrap();
        let dir = db.data_dir.join("task_files").join(&task.id);
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("note.txt");
        std::fs::write(&file_path, b"hi").unwrap();
        let att_id = uuid::Uuid::new_v4().to_string();
        {
            let conn = db.lock_db();
            conn.execute(
                "INSERT INTO task_attachments (id, task_id, filename, mime_type, size_bytes, local_path) VALUES (?1,?2,'note.txt','text/plain',2,?3)",
                params![att_id, task.id, file_path.to_string_lossy().to_string()],
            )
            .unwrap();
        }
        remove_task_attachment_impl(&db, &att_id).unwrap();
        assert!(!file_path.exists());
        assert!(resolve_task_file_path(&db, &att_id).is_err());
        assert!(remove_task_attachment_impl(&db, &att_id).is_err());
    }
}
