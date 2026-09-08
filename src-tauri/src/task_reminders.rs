//! Due-date reminder check, ticked from the same 60-second loop as scheduled sends.

use crate::commands::tasks::{due_reminders_impl, mark_reminded_impl};
use crate::db::Database;
use crate::notifications;
use tauri::{AppHandle, Manager};

pub async fn run_task_reminder_check(app: &AppHandle) {
    let now = chrono::Utc::now().to_rfc3339();
    let due = {
        let db = app.state::<Database>();
        match due_reminders_impl(&db, &now) {
            Ok(tasks) => tasks,
            Err(e) => {
                log::warn!("task reminder check failed: {}", e);
                return;
            }
        }
    };

    for task in due {
        // Mark reminded before sending: a failed notification must not retry every
        // tick, matching the "exactly one reminder per due date" rule.
        let db = app.state::<Database>();
        if let Err(e) = mark_reminded_impl(&db, &task.id) {
            log::warn!("failed to mark task {} as reminded: {}", task.id, e);
            continue;
        }
        notifications::send_task_reminder(app, &task);
    }
}
