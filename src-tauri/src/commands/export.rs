use crate::db::Database;
use crate::export::{self, ExportLabels, ExportOptions, ExportProgress, ExportSummary};
use crate::pool::ImapPool;
use futures_util::FutureExt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

static LAST_EXPORT_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

fn validate(options: &ExportOptions) -> Result<(), String> {
    if options.folder_ids.is_empty() {
        return Err("mailExport.errors.noSelection".into());
    }
    if !options.html && !options.eml {
        return Err("mailExport.errors.noFormat".into());
    }
    Ok(())
}

fn create_export_dir(parent: &Path, now: chrono::DateTime<chrono::Local>) -> Result<PathBuf, String> {
    let name = format!("Prudii-Export {}", now.format("%Y-%m-%d %H-%M"));
    for n in 1..1000 {
        let candidate = parent.join(if n == 1 { name.clone() } else { format!("{name} ({n})") });
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create export folder: {e}")),
        }
    }
    Err("Failed to create export folder".into())
}

#[tauri::command]
pub async fn start_mail_export(app: AppHandle, options: ExportOptions, labels: ExportLabels) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    validate(&options)?;
    if export::export_in_progress() {
        return Err("mailExport.errors.alreadyRunning".into());
    }

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let parent = match rx.recv().map_err(|e| format!("Dialog error: {}", e))? {
        Some(p) => match p.as_path() {
            Some(path) => path.to_path_buf(),
            None => return Ok(false),
        },
        None => return Ok(false),
    };

    // Taken after the dialog, so an open folder picker does not count as a running export on quit.
    let guard = export::RunGuard::acquire().ok_or_else(|| "mailExport.errors.alreadyRunning".to_string())?;
    let out_dir = create_export_dir(&parent, chrono::Local::now())?;
    export::take_cancel();

    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let db = task_app.state::<Database>();
        let fetch_app = task_app.clone();
        let progress_app = task_app.clone();
        let last = Arc::new(Mutex::new(None));
        let last_in = Arc::clone(&last);
        let work = export::run::run_export(
            &db,
            &options,
            &labels,
            &out_dir,
            move |id| {
                let app = fetch_app.clone();
                async move {
                    let db = app.state::<Database>();
                    let pool = app.state::<ImapPool>();
                    export::source::fetch_raw_message(&db, &pool, &id).await
                }
            },
            &export::CANCEL,
            move |progress| {
                *last_in.lock().unwrap_or_else(|e| e.into_inner()) = Some(progress.clone());
                let _ = progress_app.emit("mail-export-progress", &progress);
            },
        );
        let summary = run_reporting(work, &out_dir, &last).await;
        *LAST_EXPORT_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(out_dir);
        drop(guard);
        let _ = task_app.emit("mail-export-done", &summary);
    });

    Ok(true)
}

async fn run_reporting<W>(work: W, out_dir: &Path, last: &Mutex<Option<ExportProgress>>) -> ExportSummary
where
    W: Future<Output = ExportSummary>,
{
    match AssertUnwindSafe(work).catch_unwind().await {
        Ok(summary) => summary,
        Err(_) => {
            log::error!("mail export: the export task panicked");
            let p = last.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let (processed, local_copy, failed) = p.map_or((0, 0, 0), |p| (p.processed, p.local_copy, p.failed));
            ExportSummary {
                path: out_dir.to_string_lossy().into_owned(),
                exported: processed.saturating_sub(local_copy + failed),
                local_copy,
                failed,
                cancelled: true,
            }
        }
    }
}

#[tauri::command]
pub fn cancel_mail_export() {
    export::request_cancel();
}

#[tauri::command]
pub fn mail_export_running() -> bool {
    export::export_in_progress()
}

#[tauri::command]
pub fn open_last_export_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = LAST_EXPORT_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "No export has been run yet".to_string())?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn rejects_empty_selection_and_no_format() {
        let base = ExportOptions { folder_ids: vec!["f1".into()], html: true, eml: true, include_attachments: true };
        assert!(validate(&base).is_ok());
        assert_eq!(validate(&ExportOptions { folder_ids: vec![], ..base.clone() }).unwrap_err(), "mailExport.errors.noSelection");
        assert_eq!(validate(&ExportOptions { html: false, eml: false, ..base }).unwrap_err(), "mailExport.errors.noFormat");
    }

    #[tokio::test]
    async fn a_panicking_export_still_reports_a_summary() {
        let last = Mutex::new(Some(ExportProgress { processed: 30, total: 100, local_copy: 4, failed: 2 }));
        let summary = run_reporting(async { panic!("boom") }, Path::new("Prudii-Export"), &last).await;
        assert_eq!(summary.path, "Prudii-Export");
        assert_eq!((summary.exported, summary.local_copy, summary.failed, summary.cancelled), (24, 4, 2, true));

        let none = Mutex::new(None);
        let summary = run_reporting(async { panic!("boom") }, Path::new("Prudii-Export"), &none).await;
        assert_eq!((summary.exported, summary.local_copy, summary.failed, summary.cancelled), (0, 0, 0, true));
    }

    #[test]
    fn export_folder_is_named_by_local_time_and_never_reused() {
        let parent = std::env::temp_dir().join(format!("prudii-export-dir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        let now = chrono::Local.with_ymd_and_hms(2026, 11, 1, 16, 40, 5).unwrap();
        let first = create_export_dir(&parent, now).unwrap();
        let second = create_export_dir(&parent, now).unwrap();
        let third = create_export_dir(&parent, now).unwrap();
        assert_eq!(first.file_name().unwrap(), "Prudii-Export 2026-11-01 16-40");
        assert_eq!(second.file_name().unwrap(), "Prudii-Export 2026-11-01 16-40 (2)");
        assert_eq!(third.file_name().unwrap(), "Prudii-Export 2026-11-01 16-40 (3)");
        let _ = std::fs::remove_dir_all(&parent);
    }
}
