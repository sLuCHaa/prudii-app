//! Due-date reminder check, ticked from the same 60-second loop as scheduled sends.

use crate::commands::tasks::{due_reminders_impl, mark_reminded_impl};
use crate::db::Database;
use crate::models::Task;
use crate::notifications;
use tauri::{AppHandle, Manager};

// A long absence can leave many tasks due at once; capping the tick keeps that
// from becoming a toast storm — the rest follow on the next ticks, 60 s apart.
const MAX_REMINDERS_PER_TICK: usize = 5;

// `due_reminders_impl` orders by due_at, so the oldest due tasks go first.
fn select_batch(due: Vec<Task>) -> Vec<Task> {
    due.into_iter().take(MAX_REMINDERS_PER_TICK).collect()
}

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

    for task in select_batch(due) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, due_at: &str) -> Task {
        Task {
            id: id.to_string(),
            title: id.to_string(),
            description_html: String::new(),
            status: "todo".into(),
            priority: "normal".into(),
            due_at: Some(due_at.to_string()),
            sort_order: 0.0,
            reminder_sent: false,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            checklist_done: 0,
            checklist_total: 0,
            link_count: 0,
            attachment_count: 0,
        }
    }

    #[test]
    fn select_batch_caps_the_tick_and_keeps_the_due_order() {
        let due: Vec<Task> = (0..20).map(|i| task(&format!("t{i:02}"), "2026-09-08T08:00:00Z")).collect();

        let batch = select_batch(due);
        assert!(batch.len() < 20, "20 due tasks must not all fire in one tick");
        assert_eq!(batch.len(), MAX_REMINDERS_PER_TICK);
        assert_eq!(batch.first().map(|t| t.id.as_str()), Some("t00"));
        assert_eq!(batch.last().map(|t| t.id.as_str()), Some(format!("t{:02}", MAX_REMINDERS_PER_TICK - 1).as_str()));
    }

    #[test]
    fn select_batch_keeps_a_short_list_whole() {
        let due = vec![task("a", "2026-09-08T08:00:00Z"), task("b", "2026-09-08T09:00:00Z")];
        assert_eq!(select_batch(due).iter().map(|t| t.id.clone()).collect::<Vec<_>>(), vec!["a", "b"]);
    }
}
