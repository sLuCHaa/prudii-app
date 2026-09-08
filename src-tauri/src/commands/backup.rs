use crate::credentials::SecretStore;
use crate::db::Database;
use crate::models::{BackupIncludes, BackupManifest, BackupOptions, BackupProgress, BackupStats, RestorePreview};
use crate::pool::ImapPool;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

static BACKUP_IN_PROGRESS: std::sync::LazyLock<Mutex<bool>> =
    std::sync::LazyLock::new(|| Mutex::new(false));

/// True while a backup or restore is writing — the export-backup window must not
/// let the OS close button kill the process mid-write.
pub fn backup_in_progress() -> bool {
    *BACKUP_IN_PROGRESS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Clears the flag even if the backup task panics — otherwise the export window's
/// close guard would keep the process alive forever and block the uninstaller.
struct InProgressGuard;

impl Drop for InProgressGuard {
    fn drop(&mut self) {
        *BACKUP_IN_PROGRESS.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

fn emit_backup_progress(app: &AppHandle, progress: &BackupProgress) {
    let _ = app.emit("backup-progress", progress);
}

fn emit_restore_progress(app: &AppHandle, progress: &BackupProgress) {
    let _ = app.emit("restore-progress", progress);
}

/// Outcome of validating one ZIP entry's relative path against `base`.
enum ExtractCheck {
    Ok(PathBuf),
    /// The path escapes `base` — a genuine ZIP-slip attempt.
    Rejected,
    /// Couldn't create the destination directory or resolve a canonical path.
    IoError(String),
}

/// Resolves a ZIP entry's relative path under `base`, rejecting directory traversal
/// (`..`/absolute) and a symlinked ancestor directory.
/// True for a name that is exactly one ordinary path segment — no `..`, no separator,
/// no root or drive prefix.
fn is_plain_path_component(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(std::path::Component::Normal(c)) if c == name)
        && components.next().is_none()
}

fn safe_extract_path(base: &Path, rel_path: &str) -> ExtractCheck {
    // Before any filesystem call: `Path::join` silently replaces the base when the
    // argument has a root or drive prefix, so only plain components may pass.
    if rel_path.is_empty()
        || !Path::new(rel_path)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return ExtractCheck::Rejected;
    }

    let dest = base.join(rel_path);
    let Some(parent) = dest.parent() else { return ExtractCheck::Rejected };
    if let Err(e) = std::fs::create_dir_all(parent) {
        return ExtractCheck::IoError(e.to_string());
    }

    let canonical_base = match base.canonicalize() {
        Ok(p) => p,
        Err(e) => return ExtractCheck::IoError(e.to_string()),
    };
    // `dest` often doesn't exist yet, so fall back to canonicalizing its parent.
    // Windows prefixes canonical paths with `\\?\`, so compare canonical to canonical.
    let canonical_check = match dest.canonicalize().or_else(|_| parent.canonicalize()) {
        Ok(p) => p,
        Err(e) => return ExtractCheck::IoError(e.to_string()),
    };
    if !canonical_check.starts_with(&canonical_base) {
        return ExtractCheck::Rejected;
    }

    ExtractCheck::Ok(dest)
}

/// Reads one archive entry to a string, or `None` if the archive predates that file
/// (older backups without `tasks.json` etc. must still restore everything else).
fn read_zip_json<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Result<Option<String>, String> {
    match archive.by_name(name) {
        Ok(mut f) => {
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            Ok(Some(s))
        }
        Err(_) => Ok(None),
    }
}

/// Parses `manifest.json` and refuses archives written by a newer schema — their
/// columns and semantics are unknown here, so this runs before the first write.
pub(crate) fn read_manifest<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Result<BackupManifest, String> {
    let manifest: BackupManifest = {
        let mut f = archive
            .by_name("manifest.json")
            .map_err(|_| "Not a valid Prudii backup: manifest.json not found.".to_string())?;
        let mut contents = String::new();
        f.read_to_string(&mut contents)
            .map_err(|e| format!("Failed to read manifest: {}", e))?;
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse manifest: {}", e))?
    };

    if manifest.schema_version > crate::db::SCHEMA_VERSION {
        return Err(NEWER_VERSION_KEY.into());
    }

    Ok(manifest)
}

#[tauri::command]
pub async fn create_backup(
    app: AppHandle,
    db: State<'_, Database>,
    options: BackupOptions,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    if !options.include_settings
        && !options.include_accounts
        && !options.include_folders
        && !options.include_mails
        && !options.include_attachments
        && !options.include_tasks
    {
        return Err(NOTHING_SELECTED_KEY.into());
    }

    if options.include_credentials {
        if !options.include_accounts {
            return Err("Credentials require accounts".into());
        }
        let passphrase = options.passphrase.as_deref().unwrap_or("");
        if passphrase.chars().count() < crate::crypto::MIN_PASSPHRASE_LEN {
            return Err(SHORT_PASSPHRASE_KEY.into());
        }
    }

    let now = chrono::Local::now();
    let default_name = format!("prudii-backup-{}.zip", now.format("%Y-%m-%d_%H-%M-%S"));

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("ZIP Archive", &["zip"])
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file_path = rx.recv().map_err(|e| format!("Dialog error: {}", e))?;
    let file_path = match file_path {
        Some(p) => match p.as_path() {
            Some(path) => path.to_path_buf(),
            None => return Ok(()), // invalid path
        },
        None => return Ok(()), // user cancelled
    };

    let data_dir = db.data_dir.clone();

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        do_create_backup(app_clone, options, file_path, data_dir).await;
    });

    Ok(())
}

async fn do_create_backup(
    app: AppHandle,
    options: BackupOptions,
    file_path: std::path::PathBuf,
    data_dir: std::path::PathBuf,
) {
    {
        let mut in_progress = BACKUP_IN_PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        if *in_progress {
            emit_backup_progress(&app, &BackupProgress {
                status: "error".into(),
                message: "A backup or restore is already in progress.".into(),
                current_step: 0,
                total_steps: 0,
            });
            return;
        }
        *in_progress = true;
    }
    let _guard = InProgressGuard;

    let result = do_create_backup_inner(&app, &options, &file_path, &data_dir);

    if let Err(e) = result {
        // Clean up partial ZIP
        let _ = std::fs::remove_file(&file_path);
        // Errors that are already i18n keys reach the UI verbatim so it can translate them.
        let message = if e.starts_with("backup.") { e } else { format!("Backup failed: {}", e) };
        emit_backup_progress(&app, &BackupProgress {
            status: "error".into(),
            message,
            current_step: 0,
            total_steps: 0,
        });
    }
}

fn do_create_backup_inner(
    app: &AppHandle,
    options: &BackupOptions,
    file_path: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<(), String> {
    let db = app.state::<Database>();

    let mut total_steps: u32 = 1; // manifest always
    if options.include_settings { total_steps += 1; }
    if options.include_accounts { total_steps += 1; }
    if options.include_folders { total_steps += 1; }
    if options.include_mails { total_steps += 2; } // mails + drafts
    if options.include_attachments { total_steps += 1; }
    if options.include_tasks { total_steps += 1; }

    let mut current_step: u32 = 0;

    emit_backup_progress(app, &BackupProgress {
        status: "preparing".into(),
        message: "Creating backup...".into(),
        current_step,
        total_steps,
    });

    let file = std::fs::File::create(file_path).map_err(|e| format!("Failed to create ZIP file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut stats = BackupStats {
        account_count: 0,
        folder_count: 0,
        mail_count: 0,
        attachment_count: 0,
        task_count: 0,
    };

    if options.include_settings {
        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_settings".into(),
            message: "Exporting app settings...".into(),
            current_step,
            total_steps,
        });

        let settings_data: Vec<(String, String)> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare("SELECT key, value FROM app_settings")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };

        let json = serde_json::to_string_pretty(&settings_data).map_err(|e| e.to_string())?;
        zip.start_file("app_settings.json", zip_options).map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

        // Email Templates (bundled with settings)
        let templates: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, name, subject, body_html, body_text, created_at, updated_at
                 FROM email_templates ORDER BY name"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "subject": row.get::<_, String>(2)?,
                    "body_html": row.get::<_, String>(3)?,
                    "body_text": row.get::<_, String>(4)?,
                    "created_at": row.get::<_, String>(5)?,
                    "updated_at": row.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };
        if !templates.is_empty() {
            let json = serde_json::to_string_pretty(&templates).map_err(|e| e.to_string())?;
            zip.start_file("email_templates.json", zip_options).map_err(|e| e.to_string())?;
            zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        }

        // Inbox Splits (bundled with settings)
        let splits: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, name, position, icon, conditions, is_default, created_at
                 FROM inbox_splits ORDER BY position"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "position": row.get::<_, i32>(2)?,
                    "icon": row.get::<_, String>(3)?,
                    "conditions": row.get::<_, String>(4)?,
                    "is_default": row.get::<_, i32>(5)?,
                    "created_at": row.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };
        if !splits.is_empty() {
            let json = serde_json::to_string_pretty(&splits).map_err(|e| e.to_string())?;
            zip.start_file("inbox_splits.json", zip_options).map_err(|e| e.to_string())?;
            zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        }
    }

    if options.include_accounts {
        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_accounts".into(),
            message: "Exporting accounts...".into(),
            current_step,
            total_steps,
        });

        let accounts: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port,
                        COALESCE(smtp_security, 'ssl'), auth_type,
                        COALESCE(signature_html, ''), COALESCE(signature_text, ''),
                        COALESCE(sync_interval_minutes, 0),
                        COALESCE(signature_on_compose, 1), COALESCE(signature_on_reply, 1),
                        COALESCE(load_external_images, 'always'),
                        created_at, updated_at
                 FROM accounts ORDER BY created_at ASC"
            ).map_err(|e| e.to_string())?;

            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "email": row.get::<_, String>(1)?,
                    "display_name": row.get::<_, String>(2)?,
                    "provider": row.get::<_, String>(3)?,
                    "color": row.get::<_, String>(4)?,
                    "imap_host": row.get::<_, String>(5)?,
                    "imap_port": row.get::<_, i32>(6)?,
                    "smtp_host": row.get::<_, String>(7)?,
                    "smtp_port": row.get::<_, i32>(8)?,
                    "smtp_security": row.get::<_, String>(9)?,
                    "auth_type": row.get::<_, String>(10)?,
                    "signature_html": row.get::<_, String>(11)?,
                    "signature_text": row.get::<_, String>(12)?,
                    "sync_interval_minutes": row.get::<_, i32>(13)?,
                    "signature_on_compose": row.get::<_, bool>(14)?,
                    "signature_on_reply": row.get::<_, bool>(15)?,
                    "load_external_images": row.get::<_, String>(16)?,
                    "created_at": row.get::<_, String>(17)?,
                    "updated_at": row.get::<_, String>(18)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };

        stats.account_count = accounts.len() as u64;
        let json = serde_json::to_string_pretty(&accounts).map_err(|e| e.to_string())?;
        zip.start_file("accounts.json", zip_options).map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

        if options.include_credentials {
            let store = crate::credentials::KeyringStore;
            let passphrase = options.passphrase.as_deref().unwrap_or("");
            export_credentials(&store, &accounts, &mut zip, passphrase, &zip_options)?;
        }

        // Mail Rules (bundled with accounts)
        let rules: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, account_id, name, enabled, priority, from_contains, to_contains,
                        subject_contains, has_attachments, action_move_to_folder,
                        action_mark_read, action_star, action_trash, action_archive, created_at
                 FROM mail_rules ORDER BY account_id, priority"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "account_id": row.get::<_, String>(1)?,
                    "name": row.get::<_, String>(2)?,
                    "enabled": row.get::<_, i32>(3)?,
                    "priority": row.get::<_, i32>(4)?,
                    "from_contains": row.get::<_, Option<String>>(5)?,
                    "to_contains": row.get::<_, Option<String>>(6)?,
                    "subject_contains": row.get::<_, Option<String>>(7)?,
                    "has_attachments": row.get::<_, Option<i32>>(8)?,
                    "action_move_to_folder": row.get::<_, Option<String>>(9)?,
                    "action_mark_read": row.get::<_, Option<i32>>(10)?,
                    "action_star": row.get::<_, Option<i32>>(11)?,
                    "action_trash": row.get::<_, Option<i32>>(12)?,
                    "action_archive": row.get::<_, Option<i32>>(13)?,
                    "created_at": row.get::<_, String>(14)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };
        if !rules.is_empty() {
            let json = serde_json::to_string_pretty(&rules).map_err(|e| e.to_string())?;
            zip.start_file("mail_rules.json", zip_options).map_err(|e| e.to_string())?;
            zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        }
    }

    if options.include_folders {
        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_folders".into(),
            message: "Exporting folders...".into(),
            current_step,
            total_steps,
        });

        let folders: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, account_id, name, folder_type, path, unread_count, total_count,
                        COALESCE(is_local, 0), COALESCE(color, '')
                 FROM folders ORDER BY account_id, name"
            ).map_err(|e| e.to_string())?;

            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "account_id": row.get::<_, String>(1)?,
                    "name": row.get::<_, String>(2)?,
                    "folder_type": row.get::<_, String>(3)?,
                    "path": row.get::<_, String>(4)?,
                    "unread_count": row.get::<_, i32>(5)?,
                    "total_count": row.get::<_, i32>(6)?,
                    "is_local": row.get::<_, i32>(7)?,
                    "color": row.get::<_, String>(8)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };

        stats.folder_count = folders.len() as u64;
        let json = serde_json::to_string_pretty(&folders).map_err(|e| e.to_string())?;
        zip.start_file("folders.json", zip_options).map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    }

    if options.include_mails {
        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_mails".into(),
            message: "Exporting mails...".into(),
            current_step,
            total_steps,
        });

        // Export mails in batches to avoid high memory usage
        let mail_count: i64 = {
            let conn = db.lock_db();
            conn.query_row("SELECT COUNT(*) FROM mails", [], |row| row.get(0))
                .map_err(|e| e.to_string())?
        };

        zip.start_file("mails.json", zip_options).map_err(|e| e.to_string())?;
        zip.write_all(b"[").map_err(|e| e.to_string())?;

        let batch_size: i64 = 5000;
        let mut offset: i64 = 0;
        let mut first = true;

        loop {
            let batch: Vec<serde_json::Value> = {
                let conn = db.lock_db();
                let mut stmt = conn.prepare(
                    "SELECT id, account_id, folder_id, message_id, uid, subject,
                            from_name, from_email, to_json, cc_json, bcc_json,
                            date, snippet, body_text, body_html,
                            is_read, is_starred, is_flagged, is_replied, is_forwarded,
                            has_attachments, thread_id, in_reply_to, size_bytes,
                            COALESCE(flags, ''),
                            COALESCE(list_unsubscribe, ''),
                            COALESCE(is_pinned, 0),
                            COALESCE(snoozed_until, ''),
                            COALESCE(reply_to_json, '[]'),
                            COALESCE(auto_labels, '')
                     FROM mails ORDER BY date DESC LIMIT ?1 OFFSET ?2"
                ).map_err(|e| e.to_string())?;

                let rows = stmt.query_map(rusqlite::params![batch_size, offset], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "account_id": row.get::<_, String>(1)?,
                        "folder_id": row.get::<_, String>(2)?,
                        "message_id": row.get::<_, Option<String>>(3)?,
                        "uid": row.get::<_, Option<u32>>(4)?,
                        "subject": row.get::<_, String>(5)?,
                        "from_name": row.get::<_, String>(6)?,
                        "from_email": row.get::<_, String>(7)?,
                        "to_json": row.get::<_, String>(8)?,
                        "cc_json": row.get::<_, String>(9)?,
                        "bcc_json": row.get::<_, String>(10)?,
                        "date": row.get::<_, String>(11)?,
                        "snippet": row.get::<_, String>(12)?,
                        "body_text": row.get::<_, String>(13)?,
                        "body_html": row.get::<_, String>(14)?,
                        "is_read": row.get::<_, i32>(15)?,
                        "is_starred": row.get::<_, i32>(16)?,
                        "is_flagged": row.get::<_, i32>(17)?,
                        "is_replied": row.get::<_, i32>(18)?,
                        "is_forwarded": row.get::<_, i32>(19)?,
                        "has_attachments": row.get::<_, i32>(20)?,
                        "thread_id": row.get::<_, Option<String>>(21)?,
                        "in_reply_to": row.get::<_, Option<String>>(22)?,
                        "size_bytes": row.get::<_, Option<i64>>(23)?,
                        "flags": row.get::<_, String>(24)?,
                        "list_unsubscribe": row.get::<_, String>(25)?,
                        "is_pinned": row.get::<_, i32>(26)?,
                        "snoozed_until": row.get::<_, String>(27)?,
                        "reply_to_json": row.get::<_, String>(28)?,
                        "auto_labels": row.get::<_, String>(29)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
                rows
            };

            if batch.is_empty() {
                break;
            }

            for item in &batch {
                if !first {
                    zip.write_all(b",").map_err(|e| e.to_string())?;
                }
                first = false;
                let json = serde_json::to_string(item).map_err(|e| e.to_string())?;
                zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
            }

            offset += batch.len() as i64;

            emit_backup_progress(app, &BackupProgress {
                status: "exporting_mails".into(),
                message: format!("Exporting mails... ({}/{})", offset, mail_count),
                current_step,
                total_steps,
            });

            if (batch.len() as i64) < batch_size {
                break;
            }
        }

        zip.write_all(b"]").map_err(|e| e.to_string())?;
        stats.mail_count = offset as u64;

        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_drafts".into(),
            message: "Exporting drafts...".into(),
            current_step,
            total_steps,
        });

        let drafts: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, account_id, subject, to_addresses, cc_addresses, bcc_addresses,
                        body_text, body_html, in_reply_to, scheduled_at, created_at, updated_at
                 FROM drafts ORDER BY updated_at DESC"
            ).map_err(|e| e.to_string())?;

            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "account_id": row.get::<_, String>(1)?,
                    "subject": row.get::<_, Option<String>>(2)?,
                    "to_addresses": row.get::<_, Option<String>>(3)?,
                    "cc_addresses": row.get::<_, Option<String>>(4)?,
                    "bcc_addresses": row.get::<_, Option<String>>(5)?,
                    "body_text": row.get::<_, Option<String>>(6)?,
                    "body_html": row.get::<_, Option<String>>(7)?,
                    "in_reply_to": row.get::<_, Option<String>>(8)?,
                    "scheduled_at": row.get::<_, Option<String>>(9)?,
                    "created_at": row.get::<_, String>(10)?,
                    "updated_at": row.get::<_, String>(11)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };

        let json = serde_json::to_string_pretty(&drafts).map_err(|e| e.to_string())?;
        zip.start_file("drafts.json", zip_options).map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    }

    if options.include_attachments {
        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_attachments".into(),
            message: "Exporting attachments...".into(),
            current_step,
            total_steps,
        });

        let attachments: Vec<serde_json::Value> = {
            let conn = db.lock_db();
            let mut stmt = conn.prepare(
                "SELECT id, mail_id, filename, mime_type, size_bytes, content_id, is_inline, local_path, created_at
                 FROM attachments ORDER BY mail_id"
            ).map_err(|e| e.to_string())?;

            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "mail_id": row.get::<_, String>(1)?,
                    "filename": row.get::<_, String>(2)?,
                    "mime_type": row.get::<_, Option<String>>(3)?,
                    "size_bytes": row.get::<_, Option<i64>>(4)?,
                    "content_id": row.get::<_, Option<String>>(5)?,
                    "is_inline": row.get::<_, i32>(6)?,
                    "local_path": row.get::<_, Option<String>>(7)?,
                    "created_at": row.get::<_, String>(8)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };

        stats.attachment_count = attachments.len() as u64;

        let json = serde_json::to_string_pretty(&attachments).map_err(|e| e.to_string())?;
        zip.start_file("attachments.json", zip_options).map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

        let attachments_dir = data_dir.join("attachments");
        if attachments_dir.exists() {
            for att in &attachments {
                if let (Some(mail_id), Some(local_path)) = (
                    att.get("mail_id").and_then(|v| v.as_str()),
                    att.get("local_path").and_then(|v| v.as_str()),
                ) {
                    let src = std::path::Path::new(local_path);
                    if src.exists() {
                        if let Some(filename) = src.file_name().and_then(|f| f.to_str()) {
                            let zip_path = format!("attachment_files/{}/{}", mail_id, filename);
                            if let Ok(mut file) = std::fs::File::open(src) {
                                if zip.start_file(&zip_path, zip_options).is_ok() {
                                    let _ = std::io::copy(&mut file, &mut zip);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if options.include_tasks {
        current_step += 1;
        emit_backup_progress(app, &BackupProgress {
            status: "exporting_tasks".into(),
            message: "Exporting tasks...".into(),
            current_step,
            total_steps,
        });

        stats.task_count = export_tasks(&db, &mut zip, data_dir, &zip_options)? as u64;
    }

    current_step += 1;
    emit_backup_progress(app, &BackupProgress {
        status: "exporting_manifest".into(),
        message: "Writing manifest...".into(),
        current_step,
        total_steps,
    });

    let manifest = BackupManifest {
        version: 1,
        schema_version: crate::db::SCHEMA_VERSION,
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        includes: BackupIncludes {
            app_settings: options.include_settings,
            accounts: options.include_accounts,
            folders: options.include_folders,
            mails: options.include_mails,
            attachments: options.include_attachments,
            tasks: options.include_tasks,
            credentials: options.include_credentials,
        },
        stats,
    };

    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", zip_options).map_err(|e| e.to_string())?;
    zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;

    emit_backup_progress(app, &BackupProgress {
        status: "done".into(),
        message: format!("Backup created successfully at {}", file_path.display()),
        current_step: total_steps,
        total_steps,
    });

    Ok(())
}

/// Writes the four task tables plus `task_files/{task_id}/{filename}`; a missing
/// attachment file is logged, not fatal — the row is still exported.
pub(crate) fn export_tasks<W: Write + Seek>(
    db: &Database,
    zip: &mut zip::ZipWriter<W>,
    data_dir: &Path,
    opts: &zip::write::SimpleFileOptions,
) -> Result<i64, String> {
    // The DB lock covers only the four queries; writing the ZIP and copying task
    // files afterwards would otherwise stall every other DB-backed command.
    let (tasks, checklist, links, attachments) = {
        let conn = db.lock_db();
        let tasks: Vec<serde_json::Value> = {
            let mut stmt = conn.prepare(
                "SELECT id, title, description_html, status, priority, due_at, sort_order, reminder_sent, created_at, updated_at, completed_at
                 FROM tasks ORDER BY status, sort_order"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "description_html": row.get::<_, String>(2)?,
                    "status": row.get::<_, String>(3)?,
                    "priority": row.get::<_, String>(4)?,
                    "due_at": row.get::<_, Option<String>>(5)?,
                    "sort_order": row.get::<_, f64>(6)?,
                    "reminder_sent": row.get::<_, i64>(7)?,
                    "created_at": row.get::<_, String>(8)?,
                    "updated_at": row.get::<_, String>(9)?,
                    "completed_at": row.get::<_, Option<String>>(10)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };

        let checklist: Vec<serde_json::Value> = {
            let mut stmt = conn.prepare(
                "SELECT id, task_id, text, done, sort_order FROM task_checklist ORDER BY task_id, sort_order"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "task_id": row.get::<_, String>(1)?,
                    "text": row.get::<_, String>(2)?,
                    "done": row.get::<_, i64>(3)?,
                    "sort_order": row.get::<_, f64>(4)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };
        let links: Vec<serde_json::Value> = {
            let mut stmt = conn.prepare(
                "SELECT task_id, mail_id, account_id, subject, from_name, from_email, mail_date, created_at
                 FROM task_mail_links ORDER BY task_id, created_at"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "task_id": row.get::<_, String>(0)?,
                    "mail_id": row.get::<_, String>(1)?,
                    "account_id": row.get::<_, String>(2)?,
                    "subject": row.get::<_, String>(3)?,
                    "from_name": row.get::<_, String>(4)?,
                    "from_email": row.get::<_, String>(5)?,
                    "mail_date": row.get::<_, Option<String>>(6)?,
                    "created_at": row.get::<_, String>(7)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };
        let attachments: Vec<serde_json::Value> = {
            let mut stmt = conn.prepare(
                "SELECT id, task_id, filename, mime_type, size_bytes, local_path, created_at
                 FROM task_attachments ORDER BY task_id, created_at"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "task_id": row.get::<_, String>(1)?,
                    "filename": row.get::<_, String>(2)?,
                    "mime_type": row.get::<_, String>(3)?,
                    "size_bytes": row.get::<_, i64>(4)?,
                    "local_path": row.get::<_, String>(5)?,
                    "created_at": row.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
            rows
        };
        (tasks, checklist, links, attachments)
    };
    let task_count = tasks.len() as i64;

    for (name, rows) in [
        ("tasks.json", &tasks),
        ("task_checklist.json", &checklist),
        ("task_mail_links.json", &links),
        ("task_attachments.json", &attachments),
    ] {
        let json = serde_json::to_string_pretty(rows).map_err(|e| e.to_string())?;
        zip.start_file(name, *opts).map_err(|e| e.to_string())?;
        zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    }

    let task_files_dir = data_dir.join("task_files");
    if task_files_dir.exists() {
        for att in &attachments {
            if let (Some(task_id), Some(local_path)) = (
                att.get("task_id").and_then(|v| v.as_str()),
                att.get("local_path").and_then(|v| v.as_str()),
            ) {
                let src = Path::new(local_path);
                if !src.exists() {
                    log::warn!("Task attachment file missing, exporting row anyway: {}", local_path);
                    continue;
                }
                if let Some(filename) = src.file_name().and_then(|f| f.to_str()) {
                    let zip_path = format!("task_files/{}/{}", task_id, filename);
                    if let Ok(mut file) = std::fs::File::open(src) {
                        if zip.start_file(&zip_path, *opts).is_ok() {
                            let _ = std::io::copy(&mut file, zip);
                        }
                    }
                }
            }
        }
    }

    Ok(task_count)
}

/// A task attachment row inserted by `import_task_rows`, kept so `extract_task_files`
/// can look up its `task_files/{task_id}/{filename}` archive entry by exact name.
pub(crate) struct TaskFileEntry {
    task_id: String,
    filename: String,
}

/// Inserts the four task tables in FK order, in one transaction. Returns the task
/// count and the attachment rows, for `extract_task_files` to copy once `conn` is dropped.
pub(crate) fn import_task_rows<R: Read + Seek>(
    conn: &rusqlite::Connection,
    archive: &mut zip::ZipArchive<R>,
    data_dir: &Path,
    is_replace: bool,
) -> Result<(i64, Vec<TaskFileEntry>), String> {
    let insert_or = if is_replace { "INSERT OR REPLACE" } else { "INSERT OR IGNORE" };
    let mut task_count = 0i64;
    let mut files = Vec::new();

    let tasks_json = read_zip_json(archive, "tasks.json")?;
    let checklist_json = read_zip_json(archive, "task_checklist.json")?;
    let links_json = read_zip_json(archive, "task_mail_links.json")?;
    let attachments_json = read_zip_json(archive, "task_attachments.json")?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    if let Some(s) = tasks_json {
        let tasks: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        task_count = tasks.len() as i64;
        let sql = format!(
            "{} INTO tasks (id, title, description_html, status, priority, due_at, sort_order, reminder_sent, created_at, updated_at, completed_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            insert_or
        );
        for t in &tasks {
            tx.execute(&sql, rusqlite::params![
                t.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                t.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                t.get("description_html").and_then(|v| v.as_str()).unwrap_or(""),
                t.get("status").and_then(|v| v.as_str()).unwrap_or("open"),
                t.get("priority").and_then(|v| v.as_str()).unwrap_or("normal"),
                t.get("due_at").and_then(|v| v.as_str()),
                t.get("sort_order").and_then(|v| v.as_f64()).unwrap_or(0.0),
                t.get("reminder_sent").and_then(|v| v.as_i64()).unwrap_or(0),
                t.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                t.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
                t.get("completed_at").and_then(|v| v.as_str()),
            ]).map_err(|e| e.to_string())?;
        }
    }

    if let Some(s) = checklist_json {
        let items: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        let sql = format!(
            "{} INTO task_checklist (id, task_id, text, done, sort_order) VALUES (?1,?2,?3,?4,?5)",
            insert_or
        );
        for c in &items {
            tx.execute(&sql, rusqlite::params![
                c.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                c.get("task_id").and_then(|v| v.as_str()).unwrap_or(""),
                c.get("text").and_then(|v| v.as_str()).unwrap_or(""),
                c.get("done").and_then(|v| v.as_i64()).unwrap_or(0),
                c.get("sort_order").and_then(|v| v.as_f64()).unwrap_or(0.0),
            ]).map_err(|e| e.to_string())?;
        }
    }

    if let Some(s) = links_json {
        let links: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        let sql = format!(
            "{} INTO task_mail_links (task_id, mail_id, account_id, subject, from_name, from_email, mail_date, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            insert_or
        );
        for l in &links {
            tx.execute(&sql, rusqlite::params![
                l.get("task_id").and_then(|v| v.as_str()).unwrap_or(""),
                l.get("mail_id").and_then(|v| v.as_str()).unwrap_or(""),
                l.get("account_id").and_then(|v| v.as_str()).unwrap_or(""),
                l.get("subject").and_then(|v| v.as_str()).unwrap_or(""),
                l.get("from_name").and_then(|v| v.as_str()).unwrap_or(""),
                l.get("from_email").and_then(|v| v.as_str()).unwrap_or(""),
                l.get("mail_date").and_then(|v| v.as_str()),
                l.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
            ]).map_err(|e| e.to_string())?;
        }
    }

    if let Some(s) = attachments_json {
        let attachments: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        let sql = format!(
            "{} INTO task_attachments (id, task_id, filename, mime_type, size_bytes, local_path, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            insert_or
        );
        for a in &attachments {
            let task_id = a.get("task_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let filename = a.get("filename").and_then(|v| v.as_str()).unwrap_or("").to_string();
            // A row whose path parts are not plain names could never be extracted, so
            // importing it would only leave a dead attachment pointing outside the base.
            if !is_plain_path_component(&task_id) || !is_plain_path_component(&filename) {
                log::warn!("Skipping task attachment with an unsafe path: {}/{}", task_id, filename);
                continue;
            }
            let new_local_path = data_dir.join("task_files").join(&task_id).join(&filename);

            tx.execute(&sql, rusqlite::params![
                a.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                task_id,
                filename,
                a.get("mime_type").and_then(|v| v.as_str()).unwrap_or("application/octet-stream"),
                a.get("size_bytes").and_then(|v| v.as_i64()).unwrap_or(0),
                new_local_path.to_string_lossy().to_string(),
                a.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
            ]).map_err(|e| e.to_string())?;

            files.push(TaskFileEntry { task_id, filename });
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok((task_count, files))
}

/// Extracts each planned `task_files/{task_id}/{filename}` entry, with the same
/// ZIP-slip guard as attachments. Call after `import_task_rows`'s `conn` is dropped.
pub(crate) fn extract_task_files<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    data_dir: &Path,
    files: &[TaskFileEntry],
) -> Result<(), String> {
    let task_files_base = data_dir.join("task_files");
    for entry in files {
        let zip_path = format!("task_files/{}/{}", entry.task_id, entry.filename);
        let mut zf = match archive.by_name(&zip_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let rel_path = format!("{}/{}", entry.task_id, entry.filename);
        match safe_extract_path(&task_files_base, &rel_path) {
            ExtractCheck::Ok(dest) => {
                let mut out_file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut zf, &mut out_file).map_err(|e| e.to_string())?;
            }
            ExtractCheck::Rejected => log::warn!("ZIP Slip attempt blocked: {}", zip_path),
            ExtractCheck::IoError(e) => log::warn!("Skipping {}: {}", zip_path, e),
        }
    }
    Ok(())
}

/// Emitted instead of raw error text so the UI can translate the two failures the
/// user can actually act on. Both paths pass `backup.`-prefixed errors through verbatim.
const WRONG_PASSPHRASE_KEY: &str = "backup.wrongPassphrase";
const SHORT_PASSPHRASE_KEY: &str = "backup.passphraseTooShort";
const NOTHING_SELECTED_KEY: &str = "backup.nothingSelected";
const NEWER_VERSION_KEY: &str = "backup.newerVersion";

/// One account's stored secret inside the encrypted `credentials.enc` payload.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct CredentialEntry {
    pub account_id: String,
    pub email: String,
    pub secret: String,
}

/// Encrypts the secrets of the exported accounts into `credentials.enc`.
/// An account without a readable secret is skipped so the rest of the backup still succeeds.
pub(crate) fn export_credentials<W: Write + Seek>(
    store: &dyn SecretStore,
    accounts: &[serde_json::Value],
    zip: &mut zip::ZipWriter<W>,
    passphrase: &str,
    opts: &zip::write::SimpleFileOptions,
) -> Result<usize, String> {
    let mut entries: Vec<CredentialEntry> = Vec::new();
    for acc in accounts {
        let account_id = acc.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let email = acc.get("email").and_then(|v| v.as_str()).unwrap_or("");
        if account_id.is_empty() {
            continue;
        }
        match store.get(account_id) {
            Ok(secret) => entries.push(CredentialEntry {
                account_id: account_id.to_string(),
                email: email.to_string(),
                secret,
            }),
            Err(e) => log::warn!("[backup] Skipping credentials for account {}: {}", account_id, e),
        }
    }

    let plaintext = serde_json::to_vec(&entries).map_err(|e| e.to_string())?;
    let envelope = crate::crypto::encrypt_with_passphrase(&plaintext, passphrase)?;
    zip.start_file("credentials.enc", *opts).map_err(|e| e.to_string())?;
    zip.write_all(envelope.as_bytes()).map_err(|e| e.to_string())?;

    Ok(entries.len())
}

/// Reads and decrypts `credentials.enc`, or `Ok(None)` for an archive without it.
pub(crate) fn read_credentials<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    passphrase: &str,
) -> Result<Option<Vec<CredentialEntry>>, String> {
    let Some(envelope) = read_zip_json(archive, "credentials.enc")? else {
        return Ok(None);
    };

    let plaintext = crate::crypto::decrypt_with_passphrase(&envelope, passphrase).map_err(|e| {
        if e == crate::crypto::WRONG_PASSPHRASE { WRONG_PASSPHRASE_KEY.to_string() } else { e }
    })?;
    let entries: Vec<CredentialEntry> =
        serde_json::from_slice(&plaintext).map_err(|_| "Invalid credentials payload".to_string())?;

    Ok(Some(entries))
}

/// Stores the decrypted secrets of the accounts that were actually imported, matched by
/// account id. Returns their emails — those accounts no longer need a manual re-login.
pub(crate) fn restore_credentials(
    store: &dyn SecretStore,
    entries: &[CredentialEntry],
    imported_account_ids: &[String],
) -> Vec<String> {
    let mut restored = Vec::new();
    for entry in entries {
        if !imported_account_ids.iter().any(|id| id == &entry.account_id) {
            continue;
        }
        match store.set(&entry.account_id, &entry.secret) {
            Ok(()) => restored.push(entry.email.clone()),
            Err(e) => log::warn!("[backup] Storing the secret for account {} failed: {}", entry.account_id, e),
        }
    }
    restored
}

#[tauri::command]
pub async fn preview_restore(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<Option<RestorePreview>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("ZIP Archive", &["zip"])
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let file_path = rx.recv().map_err(|e| format!("Dialog error: {}", e))?;
    let file_path = match file_path {
        Some(p) => match p.as_path() {
            Some(path) => path.to_path_buf(),
            None => return Ok(None),
        },
        None => return Ok(None), // user cancelled
    };

    let file = std::fs::File::open(&file_path)
        .map_err(|e| format!("Failed to open backup file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid ZIP file: {}", e))?;

    let manifest = read_manifest(&mut archive)?;

    let mut existing_account_emails = Vec::new();
    if manifest.includes.accounts {
        if let Ok(mut accounts_file) = archive.by_name("accounts.json") {
            let mut contents = String::new();
            if accounts_file.read_to_string(&mut contents).is_ok() {
                if let Ok(backup_accounts) = serde_json::from_str::<Vec<serde_json::Value>>(&contents) {
                    let backup_emails: Vec<String> = backup_accounts.iter()
                        .filter_map(|a| a.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()))
                        .collect();

                    let conn = db.lock_db();
                    for email in &backup_emails {
                        let exists: bool = conn.query_row(
                            "SELECT COUNT(*) > 0 FROM accounts WHERE email = ?1",
                            rusqlite::params![email],
                            |row| row.get(0),
                        ).unwrap_or(false);
                        if exists {
                            existing_account_emails.push(email.clone());
                        }
                    }
                }
            }
        }
    }

    Ok(Some(RestorePreview {
        file_path: file_path.to_string_lossy().to_string(),
        has_credentials: manifest.includes.credentials,
        manifest,
        existing_account_emails,
    }))
}

#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    file_path: String,
    strategy: String,
    passphrase: Option<String>,
) -> Result<(), String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        do_restore_backup(app_clone, file_path, strategy, passphrase).await;
    });
    Ok(())
}

async fn do_restore_backup(
    app: AppHandle,
    file_path: String,
    strategy: String,
    passphrase: Option<String>,
) {
    {
        let mut in_progress = BACKUP_IN_PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        if *in_progress {
            emit_restore_progress(&app, &BackupProgress {
                status: "error".into(),
                message: "A backup or restore is already in progress.".into(),
                current_step: 0,
                total_steps: 0,
            });
            return;
        }
        *in_progress = true;
    }
    let _guard = InProgressGuard;

    let result = do_restore_backup_inner(&app, &file_path, &strategy, passphrase.as_deref());

    // Clear all IMAP pool connections — restored data may have changed account IDs/folders
    if result.is_ok() {
        let pool = app.state::<ImapPool>();
        pool.clear_all().await;
    }

    if let Err(e) = result {
        // Errors that are already i18n keys reach the UI verbatim so it can translate them.
        let message = if e.starts_with("backup.") { e } else { format!("Restore failed: {}", e) };
        emit_restore_progress(&app, &BackupProgress {
            status: "error".into(),
            message,
            current_step: 0,
            total_steps: 0,
        });
    }
}

fn do_restore_backup_inner(
    app: &AppHandle,
    file_path: &str,
    strategy: &str,
    passphrase: Option<&str>,
) -> Result<(), String> {
    let db = app.state::<Database>();
    let data_dir = db.data_dir.clone();
    let is_replace = strategy == "replace";

    let file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open backup: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid ZIP file: {}", e))?;

    let manifest = read_manifest(&mut archive)?;

    let mut total_steps: u32 = 0;
    if manifest.includes.app_settings { total_steps += 1; }
    if manifest.includes.accounts { total_steps += 1; }
    if manifest.includes.folders { total_steps += 1; }
    if manifest.includes.mails { total_steps += 2; } // mails + FTS rebuild
    if manifest.includes.attachments { total_steps += 1; }
    if manifest.includes.tasks { total_steps += 1; }
    let mut current_step: u32 = 0;

    let mut accounts_needing_passwords: Vec<String> = Vec::new();
    let mut imported_account_ids: Vec<String> = Vec::new();
    let mut tasks_imported: i64 = 0;

    // Decrypted up front: a wrong passphrase must abort before the first table is written.
    let credentials = match passphrase {
        Some(p) if !p.is_empty() => read_credentials(&mut archive, p)?,
        _ => None,
    };

    if manifest.includes.app_settings {
        if let Ok(mut f) = archive.by_name("app_settings.json") {
            current_step += 1;
            emit_restore_progress(app, &BackupProgress {
                status: "restoring_settings".into(),
                message: "Restoring app settings...".into(),
                current_step,
                total_steps,
            });

            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let settings: Vec<(String, String)> = serde_json::from_str(&s).map_err(|e| e.to_string())?;

            let conn = db.lock_db();
            for (key, value) in &settings {
                conn.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                    rusqlite::params![key, value],
                ).map_err(|e| e.to_string())?;
            }
        }
    }

    // Email Templates (bundled with settings)
    if manifest.includes.app_settings {
        if let Ok(mut f) = archive.by_name("email_templates.json") {
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let templates: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            let conn = db.lock_db();
            if is_replace {
                conn.execute_batch("DELETE FROM email_templates;").map_err(|e| e.to_string())?;
            }
            let insert_or = if is_replace { "INSERT OR REPLACE" } else { "INSERT OR IGNORE" };
            let sql = format!(
                "{} INTO email_templates (id, name, subject, body_html, body_text, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)", insert_or
            );
            for tmpl in &templates {
                conn.execute(&sql, rusqlite::params![
                    tmpl.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    tmpl.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    tmpl.get("subject").and_then(|v| v.as_str()).unwrap_or(""),
                    tmpl.get("body_html").and_then(|v| v.as_str()).unwrap_or(""),
                    tmpl.get("body_text").and_then(|v| v.as_str()).unwrap_or(""),
                    tmpl.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                    tmpl.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
                ]).map_err(|e| e.to_string())?;
            }
        }

        // Inbox Splits (bundled with settings)
        if let Ok(mut f) = archive.by_name("inbox_splits.json") {
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let splits: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            let conn = db.lock_db();
            if is_replace {
                conn.execute_batch("DELETE FROM inbox_splits;").map_err(|e| e.to_string())?;
            }
            let insert_or = if is_replace { "INSERT OR REPLACE" } else { "INSERT OR IGNORE" };
            let sql = format!(
                "{} INTO inbox_splits (id, name, position, icon, conditions, is_default, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)", insert_or
            );
            for split in &splits {
                conn.execute(&sql, rusqlite::params![
                    split.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    split.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    split.get("position").and_then(|v| v.as_i64()).unwrap_or(0),
                    split.get("icon").and_then(|v| v.as_str()).unwrap_or("inbox"),
                    split.get("conditions").and_then(|v| v.as_str()).unwrap_or("{}"),
                    split.get("is_default").and_then(|v| v.as_i64()).unwrap_or(0),
                    split.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                ]).map_err(|e| e.to_string())?;
            }
        }
    }

    if manifest.includes.accounts {
        if let Ok(mut f) = archive.by_name("accounts.json") {
            current_step += 1;
            emit_restore_progress(app, &BackupProgress {
                status: "restoring_accounts".into(),
                message: "Restoring accounts...".into(),
                current_step,
                total_steps,
            });

            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let accounts: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;

            let conn = db.lock_db();
            for acc in &accounts {
                let email = acc.get("email").and_then(|v| v.as_str()).unwrap_or("");
                let id = acc.get("id").and_then(|v| v.as_str()).unwrap_or("");

                if is_replace {
                    // Delete existing account with same email (CASCADE deletes folders/mails/attachments)
                    conn.execute("DELETE FROM accounts WHERE email = ?1", rusqlite::params![email])
                        .map_err(|e| e.to_string())?;
                } else {
                    // Merge: skip if email already exists
                    let exists: bool = conn.query_row(
                        "SELECT COUNT(*) > 0 FROM accounts WHERE email = ?1",
                        rusqlite::params![email],
                        |row| row.get(0),
                    ).unwrap_or(false);
                    if exists {
                        continue;
                    }
                }

                conn.execute(
                    "INSERT OR REPLACE INTO accounts (id, email, display_name, provider, color, imap_host, imap_port, smtp_host, smtp_port, smtp_security, auth_type, signature_html, signature_text, sync_interval_minutes, signature_on_compose, signature_on_reply, load_external_images, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                    rusqlite::params![
                        id,
                        email,
                        acc.get("display_name").and_then(|v| v.as_str()).unwrap_or(""),
                        acc.get("provider").and_then(|v| v.as_str()).unwrap_or("custom"),
                        acc.get("color").and_then(|v| v.as_str()).unwrap_or("#3b82f6"),
                        acc.get("imap_host").and_then(|v| v.as_str()).unwrap_or(""),
                        acc.get("imap_port").and_then(|v| v.as_i64()).unwrap_or(993),
                        acc.get("smtp_host").and_then(|v| v.as_str()).unwrap_or(""),
                        acc.get("smtp_port").and_then(|v| v.as_i64()).unwrap_or(587),
                        acc.get("smtp_security").and_then(|v| v.as_str()).unwrap_or("ssl"),
                        acc.get("auth_type").and_then(|v| v.as_str()).unwrap_or("password"),
                        acc.get("signature_html").and_then(|v| v.as_str()).unwrap_or(""),
                        acc.get("signature_text").and_then(|v| v.as_str()).unwrap_or(""),
                        acc.get("sync_interval_minutes").and_then(|v| v.as_i64()).unwrap_or(0),
                        acc.get("signature_on_compose").and_then(|v| v.as_bool()).unwrap_or(true),
                        acc.get("signature_on_reply").and_then(|v| v.as_bool()).unwrap_or(true),
                        acc.get("load_external_images").and_then(|v| v.as_str()).unwrap_or("always"),
                        acc.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                        acc.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                ).map_err(|e| e.to_string())?;

                accounts_needing_passwords.push(email.to_string());
                imported_account_ids.push(id.to_string());
            }
        }
    }

    if let Some(entries) = &credentials {
        let store = crate::credentials::KeyringStore;
        let restored = restore_credentials(&store, entries, &imported_account_ids);
        accounts_needing_passwords.retain(|email| !restored.contains(email));
    }

    // Mail Rules (bundled with accounts)
    if manifest.includes.accounts {
        if let Ok(mut f) = archive.by_name("mail_rules.json") {
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let rules: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            let conn = db.lock_db();
            let insert_or = if is_replace { "INSERT OR REPLACE" } else { "INSERT OR IGNORE" };
            let sql = format!(
                "{} INTO mail_rules (id, account_id, name, enabled, priority, from_contains, to_contains,
                 subject_contains, has_attachments, action_move_to_folder,
                 action_mark_read, action_star, action_trash, action_archive, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)", insert_or
            );
            for rule in &rules {
                conn.execute(&sql, rusqlite::params![
                    rule.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    rule.get("account_id").and_then(|v| v.as_str()).unwrap_or(""),
                    rule.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    rule.get("enabled").and_then(|v| v.as_i64()).unwrap_or(1),
                    rule.get("priority").and_then(|v| v.as_i64()).unwrap_or(0),
                    rule.get("from_contains").and_then(|v| v.as_str()),
                    rule.get("to_contains").and_then(|v| v.as_str()),
                    rule.get("subject_contains").and_then(|v| v.as_str()),
                    rule.get("has_attachments").and_then(|v| v.as_i64()).map(|i| i as i32),
                    rule.get("action_move_to_folder").and_then(|v| v.as_str()),
                    rule.get("action_mark_read").and_then(|v| v.as_i64()).map(|i| i as i32),
                    rule.get("action_star").and_then(|v| v.as_i64()).map(|i| i as i32),
                    rule.get("action_trash").and_then(|v| v.as_i64()).map(|i| i as i32),
                    rule.get("action_archive").and_then(|v| v.as_i64()).map(|i| i as i32),
                    rule.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                ]).map_err(|e| e.to_string())?;
            }
        }
    }

    if manifest.includes.folders {
        if let Ok(mut f) = archive.by_name("folders.json") {
            current_step += 1;
            emit_restore_progress(app, &BackupProgress {
                status: "restoring_folders".into(),
                message: "Restoring folders...".into(),
                current_step,
                total_steps,
            });

            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let folders: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;

            let conn = db.lock_db();
            for folder in &folders {
                let id = folder.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let account_id = folder.get("account_id").and_then(|v| v.as_str()).unwrap_or("");
                let path = folder.get("path").and_then(|v| v.as_str()).unwrap_or("");

                if is_replace {
                    conn.execute(
                        "DELETE FROM folders WHERE account_id = ?1 AND path = ?2",
                        rusqlite::params![account_id, path],
                    ).map_err(|e| e.to_string())?;
                }

                let sql = if is_replace {
                    "INSERT OR REPLACE INTO folders (id, account_id, name, folder_type, path, unread_count, total_count, is_local, color)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
                } else {
                    "INSERT OR IGNORE INTO folders (id, account_id, name, folder_type, path, unread_count, total_count, is_local, color)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
                };

                conn.execute(
                    sql,
                    rusqlite::params![
                        id,
                        account_id,
                        folder.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        folder.get("folder_type").and_then(|v| v.as_str()).unwrap_or("custom"),
                        path,
                        folder.get("unread_count").and_then(|v| v.as_i64()).unwrap_or(0),
                        folder.get("total_count").and_then(|v| v.as_i64()).unwrap_or(0),
                        folder.get("is_local").and_then(|v| v.as_i64()).unwrap_or(0),
                        folder.get("color").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                ).map_err(|e| e.to_string())?;
            }
        }
    }

    if manifest.includes.mails {
        let mails_json = {
            if let Ok(mut f) = archive.by_name("mails.json") {
                let mut s = String::new();
                f.read_to_string(&mut s).map_err(|e| e.to_string())?;
                Some(s)
            } else {
                None
            }
        };

        // Read drafts JSON from archive (separate borrow scope)
        let drafts_json = {
            if let Ok(mut f) = archive.by_name("drafts.json") {
                let mut s = String::new();
                f.read_to_string(&mut s).map_err(|e| e.to_string())?;
                Some(s)
            } else {
                None
            }
        };

        if let Some(mails_str) = mails_json {
            current_step += 1;
            emit_restore_progress(app, &BackupProgress {
                status: "restoring_mails".into(),
                message: "Restoring mails...".into(),
                current_step,
                total_steps,
            });

            let mails: Vec<serde_json::Value> = serde_json::from_str(&mails_str).map_err(|e| e.to_string())?;
            drop(mails_str); // Free raw JSON string — parsed data is now in `mails`

            let conn = db.lock_db();
            let insert_or = if is_replace { "INSERT OR REPLACE" } else { "INSERT OR IGNORE" };
            let sql = format!(
                "{} INTO mails (id, account_id, folder_id, message_id, uid, subject,
                 from_name, from_email, to_json, cc_json, bcc_json,
                 date, snippet, body_text, body_html,
                 is_read, is_starred, is_flagged, is_replied, is_forwarded,
                 has_attachments, thread_id, in_reply_to, size_bytes, flags,
                 list_unsubscribe, is_pinned, snoozed_until, reply_to_json, auto_labels)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30)",
                insert_or
            );

            let batch_size = 1000;
            let total_mails = mails.len();
            for chunk_start in (0..total_mails).step_by(batch_size) {
                let chunk_end = (chunk_start + batch_size).min(total_mails);
                conn.execute_batch("BEGIN TRANSACTION;").map_err(|e| e.to_string())?;

                for mail in &mails[chunk_start..chunk_end] {
                    conn.execute(
                        &sql,
                        rusqlite::params![
                            mail.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("account_id").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("folder_id").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("message_id").and_then(|v| v.as_str()),
                            mail.get("uid").and_then(|v| v.as_u64()).map(|u| u as u32),
                            mail.get("subject").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("from_name").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("from_email").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("to_json").and_then(|v| v.as_str()).unwrap_or("[]"),
                            mail.get("cc_json").and_then(|v| v.as_str()).unwrap_or("[]"),
                            mail.get("bcc_json").and_then(|v| v.as_str()).unwrap_or("[]"),
                            mail.get("date").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("snippet").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("body_text").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("body_html").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("is_read").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("is_starred").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("is_flagged").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("is_replied").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("is_forwarded").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("has_attachments").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("thread_id").and_then(|v| v.as_str()),
                            mail.get("in_reply_to").and_then(|v| v.as_str()),
                            mail.get("size_bytes").and_then(|v| v.as_i64()),
                            mail.get("flags").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("list_unsubscribe").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("is_pinned").and_then(|v| v.as_i64()).unwrap_or(0),
                            mail.get("snoozed_until").and_then(|v| v.as_str()).unwrap_or(""),
                            mail.get("reply_to_json").and_then(|v| v.as_str()).unwrap_or("[]"),
                            mail.get("auto_labels").and_then(|v| v.as_str()).unwrap_or(""),
                        ],
                    ).map_err(|e| e.to_string())?;
                }

                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;

                emit_restore_progress(app, &BackupProgress {
                    status: "restoring_mails".into(),
                    message: format!("Restoring mails... ({}/{})", chunk_end, total_mails),
                    current_step,
                    total_steps,
                });
            }

            if let Some(drafts_str) = drafts_json {
                let drafts: Vec<serde_json::Value> = serde_json::from_str(&drafts_str).map_err(|e| e.to_string())?;

                let draft_sql = format!(
                    "{} INTO drafts (id, account_id, subject, to_addresses, cc_addresses, bcc_addresses,
                     body_text, body_html, in_reply_to, scheduled_at, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    insert_or
                );

                conn.execute_batch("BEGIN TRANSACTION;").map_err(|e| e.to_string())?;
                for draft in &drafts {
                    conn.execute(
                        &draft_sql,
                        rusqlite::params![
                            draft.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                            draft.get("account_id").and_then(|v| v.as_str()).unwrap_or(""),
                            draft.get("subject").and_then(|v| v.as_str()),
                            draft.get("to_addresses").and_then(|v| v.as_str()),
                            draft.get("cc_addresses").and_then(|v| v.as_str()),
                            draft.get("bcc_addresses").and_then(|v| v.as_str()),
                            draft.get("body_text").and_then(|v| v.as_str()),
                            draft.get("body_html").and_then(|v| v.as_str()),
                            draft.get("in_reply_to").and_then(|v| v.as_str()),
                            draft.get("scheduled_at").and_then(|v| v.as_str()),
                            draft.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                            draft.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
                        ],
                    ).map_err(|e| e.to_string())?;
                }
                conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
            }
        }

        {
            let conn = db.lock_db();
            conn.execute_batch(
                "UPDATE folders SET
                    total_count = (SELECT COUNT(*) FROM mails WHERE folder_id = folders.id),
                    unread_count = (SELECT COUNT(*) FROM mails WHERE folder_id = folders.id AND is_read = 0);"
            ).map_err(|e| e.to_string())?;
        }

        current_step += 1;
        emit_restore_progress(app, &BackupProgress {
            status: "restoring_fts".into(),
            message: "Rebuilding search index...".into(),
            current_step,
            total_steps,
        });

        let conn = db.lock_db();
        // External-content FTS: 'rebuild' wipes and re-indexes from the mails table.
        conn.execute_batch("INSERT INTO mails_fts(mails_fts) VALUES('rebuild');")
            .map_err(|e| e.to_string())?;
    }

    if manifest.includes.attachments {
        if let Ok(mut f) = archive.by_name("attachments.json") {
            current_step += 1;
            emit_restore_progress(app, &BackupProgress {
                status: "restoring_attachments".into(),
                message: "Restoring attachments...".into(),
                current_step,
                total_steps,
            });

            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let attachments: Vec<serde_json::Value> = serde_json::from_str(&s).map_err(|e| e.to_string())?;

            let conn = db.lock_db();
            let insert_or = if is_replace { "INSERT OR REPLACE" } else { "INSERT OR IGNORE" };
            let sql = format!(
                "{} INTO attachments (id, mail_id, filename, mime_type, size_bytes, content_id, is_inline, local_path, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                insert_or
            );

            for att in &attachments {
                let mail_id = att.get("mail_id").and_then(|v| v.as_str()).unwrap_or("");
                let filename = att.get("filename").and_then(|v| v.as_str()).unwrap_or("");

                // Determine new local_path based on current data_dir
                let att_dir = data_dir.join("attachments").join(mail_id);
                let new_local_path = att_dir.join(filename);

                conn.execute(
                    &sql,
                    rusqlite::params![
                        att.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        mail_id,
                        filename,
                        att.get("mime_type").and_then(|v| v.as_str()),
                        att.get("size_bytes").and_then(|v| v.as_i64()),
                        att.get("content_id").and_then(|v| v.as_str()),
                        att.get("is_inline").and_then(|v| v.as_i64()).unwrap_or(0),
                        new_local_path.to_string_lossy().to_string(),
                        att.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                    ],
                ).map_err(|e| e.to_string())?;
            }

            // We need to re-open the archive to iterate over attachment files
            // (since we already consumed `f`)
            drop(conn);
            let file2 = std::fs::File::open(file_path)
                .map_err(|e| format!("Failed to reopen backup: {}", e))?;
            let mut archive2 = zip::ZipArchive::new(file2)
                .map_err(|e| format!("Failed to reopen ZIP: {}", e))?;

            let attachments_base = data_dir.join("attachments");
            for i in 0..archive2.len() {
                let mut entry = archive2.by_index(i).map_err(|e| e.to_string())?;
                let name = entry.name().to_string();
                if name.starts_with("attachment_files/") && !entry.is_dir() {
                    // attachment_files/{mail_id}/{filename}
                    let rel_path = &name["attachment_files/".len()..];
                    match safe_extract_path(&attachments_base, rel_path) {
                        ExtractCheck::Ok(dest) => {
                            let mut out_file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
                        }
                        ExtractCheck::Rejected => log::warn!("ZIP Slip attempt blocked: {}", name),
                        ExtractCheck::IoError(e) => log::warn!("Skipping {}: {}", name, e),
                    }
                }
            }
        }
    }

    if manifest.includes.tasks {
        current_step += 1;
        emit_restore_progress(app, &BackupProgress {
            status: "restoring_tasks".into(),
            message: "Restoring tasks...".into(),
            current_step,
            total_steps,
        });

        let (count, files) = {
            let conn = db.lock_db();
            import_task_rows(&conn, &mut archive, &data_dir, is_replace)?
        };
        tasks_imported = count;
        extract_task_files(&mut archive, &data_dir, &files)?;
    }

    if !accounts_needing_passwords.is_empty() {
        let _ = app.emit("restore-needs-passwords", serde_json::json!({
            "emails": accounts_needing_passwords,
        }));
    }

    if tasks_imported > 0 {
        let _ = app.emit("tasks-changed", ());
    }

    emit_restore_progress(app, &BackupProgress {
        status: "done".into(),
        message: "Restore completed successfully!".into(),
        current_step: total_steps,
        total_steps,
    });

    Ok(())
}

#[cfg(test)]
mod tasks_roundtrip {
    use super::*;
    use crate::commands::tasks::list_tasks_impl;
    use std::io::Cursor;

    fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    #[test]
    fn export_then_import_preserves_tasks_checklist_links_and_files() {
        let db_a = temp_db();
        let task1 = uuid::Uuid::new_v4().to_string();
        let task2 = uuid::Uuid::new_v4().to_string();

        {
            let conn = db_a.lock_db();
            conn.execute("INSERT INTO tasks (id, title) VALUES (?1, 'Task one')", rusqlite::params![task1]).unwrap();
            conn.execute("INSERT INTO tasks (id, title) VALUES (?1, 'Task two')", rusqlite::params![task2]).unwrap();
            conn.execute(
                "INSERT INTO task_checklist (id, task_id, text) VALUES (?1, ?2, 'do it')",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task1],
            ).unwrap();
            conn.execute(
                "INSERT INTO task_mail_links (task_id, mail_id, account_id, subject) VALUES (?1, 'mail1', 'acc1', 'Snapshot subject')",
                rusqlite::params![task1],
            ).unwrap();

            let file_dir = db_a.data_dir.join("task_files").join(&task1);
            std::fs::create_dir_all(&file_dir).unwrap();
            let file_path = file_dir.join("a.txt");
            std::fs::write(&file_path, b"attachment content").unwrap();
            conn.execute(
                "INSERT INTO task_attachments (id, task_id, filename, local_path) VALUES (?1, ?2, 'a.txt', ?3)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), task1, file_path.to_string_lossy().to_string()],
            ).unwrap();
        }

        let zip_options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let exported_count = export_tasks(&db_a, &mut zip, &db_a.data_dir, &zip_options).unwrap();
        assert_eq!(exported_count, 2);
        let bytes = zip.finish().unwrap().into_inner();

        let db_b = temp_db();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let (imported_count, files) = {
            let conn = db_b.lock_db();
            import_task_rows(&conn, &mut archive, &db_b.data_dir, false).unwrap()
        };
        assert_eq!(imported_count, 2);
        extract_task_files(&mut archive, &db_b.data_dir, &files).unwrap();

        let tasks = list_tasks_impl(&db_b, None).unwrap();
        assert_eq!(tasks.len(), 2);
        let restored_task1 = tasks.iter().find(|t| t.id == task1).unwrap();
        assert_eq!(restored_task1.checklist_total, 1);
        assert_eq!(restored_task1.link_count, 1);
        assert_eq!(restored_task1.attachment_count, 1);
        let restored_task2 = tasks.iter().find(|t| t.id == task2).unwrap();
        assert_eq!(restored_task2.checklist_total, 0);
        assert_eq!(restored_task2.link_count, 0);
        assert_eq!(restored_task2.attachment_count, 0);

        let restored_file = db_b.data_dir.join("task_files").join(&task1).join("a.txt");
        assert!(restored_file.exists());
        assert_eq!(std::fs::read(&restored_file).unwrap(), b"attachment content");

        let local_path: String = db_b.lock_db().query_row(
            "SELECT local_path FROM task_attachments WHERE task_id = ?1",
            rusqlite::params![task1],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(std::path::Path::new(&local_path), restored_file);
    }

    #[test]
    fn import_rejects_a_zip_slip_filename_and_writes_nothing_outside_the_base_dir() {
        let db_b = temp_db();
        let task_id = uuid::Uuid::new_v4().to_string();

        let zip_options = zip::write::SimpleFileOptions::default();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let tasks_json = serde_json::json!([{
            "id": task_id, "title": "t", "description_html": "", "status": "open", "priority": "normal",
            "due_at": null, "sort_order": 0.0, "reminder_sent": 0, "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z", "completed_at": null,
        }]);
        zip.start_file("tasks.json", zip_options).unwrap();
        zip.write_all(serde_json::to_string(&tasks_json).unwrap().as_bytes()).unwrap();

        let attachments_json = serde_json::json!([
            {
                "id": uuid::Uuid::new_v4().to_string(), "task_id": task_id, "filename": "../evil.txt",
                "mime_type": "text/plain", "size_bytes": 4, "local_path": "unused", "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "id": uuid::Uuid::new_v4().to_string(), "task_id": task_id, "filename": "C:/evil-drive.txt",
                "mime_type": "text/plain", "size_bytes": 4, "local_path": "unused", "created_at": "2026-01-01T00:00:00Z",
            },
        ]);
        zip.start_file("task_attachments.json", zip_options).unwrap();
        zip.write_all(serde_json::to_string(&attachments_json).unwrap().as_bytes()).unwrap();

        // The malicious entry's path, after stripping the "task_files/" prefix, contains
        // ".." and must be rejected before any directory is created or file written.
        zip.start_file(format!("task_files/{}/../evil.txt", task_id), zip_options).unwrap();
        zip.write_all(b"evil").unwrap();

        let bytes = zip.finish().unwrap().into_inner();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();

        let (imported_count, files) = {
            let conn = db_b.lock_db();
            import_task_rows(&conn, &mut archive, &db_b.data_dir, false).unwrap()
        };
        assert_eq!(imported_count, 1);
        assert!(files.is_empty(), "no unsafe attachment row should be planned for extraction");
        extract_task_files(&mut archive, &db_b.data_dir, &files).unwrap();

        let attachment_rows: i64 = db_b.lock_db().query_row(
            "SELECT COUNT(*) FROM task_attachments",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(attachment_rows, 0, "an attachment row with an unsafe path must not be inserted");

        // Neither the escape target nor anything at the base dir root was written.
        assert!(!db_b.data_dir.join("evil.txt").exists());
        assert!(!db_b.data_dir.join("task_files").join("evil.txt").exists());
        let task_files_dir = db_b.data_dir.join("task_files").join(&task_id);
        let written: Vec<_> = if task_files_dir.exists() {
            std::fs::read_dir(&task_files_dir).unwrap().collect()
        } else {
            Vec::new()
        };
        assert!(written.is_empty(), "no file should have been written for the malicious entry");
    }

    #[test]
    fn safe_extract_path_rejects_prefixed_paths_before_creating_any_directory() {
        let base = std::env::temp_dir().join(format!("prudii-slip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();

        for rel in ["C:/evil.txt", "C:evil.txt", "/evil.txt", "\\evil.txt", "../evil.txt", "a/../../evil.txt", ""] {
            assert!(
                matches!(safe_extract_path(&base, rel), ExtractCheck::Rejected),
                "{} should be rejected",
                rel
            );
        }

        // Nothing outside the base may be created while rejecting those paths.
        assert!(!std::path::Path::new("C:/evil.txt").exists());
        assert!(!base.parent().unwrap().join("evil.txt").exists());
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0);

        // A dot inside a plain file name is legal and must still resolve.
        match safe_extract_path(&base, "task-1/report..pdf") {
            ExtractCheck::Ok(dest) => assert_eq!(dest, base.join("task-1").join("report..pdf")),
            _ => panic!("a plain file name containing dots must be accepted"),
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_manifest_from_a_newer_schema_is_rejected_before_anything_is_imported() {
        let db = temp_db();

        let make_archive = |schema_version: u32| {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            let opts = zip::write::SimpleFileOptions::default();
            let manifest = serde_json::json!({
                "version": 1,
                "schema_version": schema_version,
                "created_at": "2026-01-01 00:00:00",
                "includes": { "app_settings": false, "accounts": false, "folders": false, "mails": false, "attachments": false, "tasks": true, "credentials": false },
                "stats": { "account_count": 0, "folder_count": 0, "mail_count": 0, "attachment_count": 0, "task_count": 1 },
            });
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes()).unwrap();
            let tasks = serde_json::json!([{ "id": "t1", "title": "Task one" }]);
            zip.start_file("tasks.json", opts).unwrap();
            zip.write_all(serde_json::to_string(&tasks).unwrap().as_bytes()).unwrap();
            zip::ZipArchive::new(Cursor::new(zip.finish().unwrap().into_inner())).unwrap()
        };

        let mut newer = make_archive(crate::db::SCHEMA_VERSION + 1);
        assert_eq!(read_manifest(&mut newer).unwrap_err(), "backup.newerVersion");

        let task_rows: i64 = db.lock_db()
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_rows, 0, "a rejected archive must not import anything");

        let mut current = make_archive(crate::db::SCHEMA_VERSION);
        assert_eq!(read_manifest(&mut current).unwrap().schema_version, crate::db::SCHEMA_VERSION);
    }
}

#[cfg(test)]
mod credentials_roundtrip {
    use super::*;
    use std::collections::HashMap;
    use std::io::Cursor;

    #[derive(Default)]
    struct MemoryStore {
        secrets: Mutex<HashMap<String, String>>,
        /// Account ids whose `set` fails, standing in for a keyring plus DB write that both failed.
        failing: Vec<String>,
    }

    impl MemoryStore {
        fn seeded(pairs: &[(&str, &str)]) -> Self {
            let store = MemoryStore::default();
            for (id, secret) in pairs {
                store.set(id, secret).unwrap();
            }
            store
        }

        fn failing_for(account_ids: &[&str]) -> Self {
            MemoryStore {
                failing: account_ids.iter().map(|id| id.to_string()).collect(),
                ..MemoryStore::default()
            }
        }

        fn stored(&self, account_id: &str) -> Option<String> {
            self.secrets.lock().unwrap().get(account_id).cloned()
        }
    }

    impl SecretStore for MemoryStore {
        fn get(&self, account_id: &str) -> Result<String, String> {
            self.secrets
                .lock()
                .unwrap()
                .get(account_id)
                .cloned()
                .ok_or_else(|| "no secret stored".to_string())
        }

        fn set(&self, account_id: &str, secret: &str) -> Result<(), String> {
            if self.failing.iter().any(|id| id == account_id) {
                return Err("keyring and database both failed".into());
            }
            self.secrets.lock().unwrap().insert(account_id.to_string(), secret.to_string());
            Ok(())
        }
    }

    const PASSPHRASE: &str = "a good long passphrase";

    fn accounts_json() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({ "id": "acc-1", "email": "one@example.com" }),
            serde_json::json!({ "id": "acc-2", "email": "two@example.com" }),
            serde_json::json!({ "id": "acc-3", "email": "three@example.com" }),
        ]
    }

    fn export_to_bytes(store: &MemoryStore, passphrase: &str) -> (usize, Vec<u8>) {
        let zip_options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let exported =
            export_credentials(store, &accounts_json(), &mut zip, passphrase, &zip_options).unwrap();
        (exported, zip.finish().unwrap().into_inner())
    }

    #[test]
    fn exported_secrets_are_restored_for_the_imported_accounts_only() {
        // acc-3 has no secret at all — it must not block the other two.
        let source = MemoryStore::seeded(&[("acc-1", "secret-one"), ("acc-2", "secret-two")]);
        let (exported, bytes) = export_to_bytes(&source, PASSPHRASE);
        assert_eq!(exported, 2);

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let entries = read_credentials(&mut archive, PASSPHRASE).unwrap().unwrap();
        assert_eq!(entries.len(), 2);

        // Only acc-1 was imported; acc-2 already existed and was skipped.
        let target = MemoryStore::default();
        let imported = vec!["acc-1".to_string()];
        let restored = restore_credentials(&target, &entries, &imported);

        assert_eq!(restored, vec!["one@example.com".to_string()]);
        assert_eq!(target.stored("acc-1").as_deref(), Some("secret-one"));
        assert_eq!(target.stored("acc-2"), None);
    }

    #[test]
    fn an_account_whose_secret_cannot_be_stored_still_needs_its_password() {
        let source = MemoryStore::seeded(&[("acc-1", "secret-one"), ("acc-2", "secret-two")]);
        let (_, bytes) = export_to_bytes(&source, PASSPHRASE);

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let entries = read_credentials(&mut archive, PASSPHRASE).unwrap().unwrap();

        let target = MemoryStore::failing_for(&["acc-1"]);
        let imported_ids = vec!["acc-1".to_string(), "acc-2".to_string()];
        let restored = restore_credentials(&target, &entries, &imported_ids);

        // Same retain the restore path performs on the needs-passwords list.
        let mut needs_passwords = vec!["one@example.com".to_string(), "two@example.com".to_string()];
        needs_passwords.retain(|email| !restored.contains(email));

        assert_eq!(needs_passwords, vec!["one@example.com".to_string()]);
        assert_eq!(target.stored("acc-1"), None);
        assert_eq!(target.stored("acc-2").as_deref(), Some("secret-two"));
    }

    #[test]
    fn the_ciphertext_never_contains_the_plaintext_secret() {
        let source = MemoryStore::seeded(&[("acc-1", "secret-one")]);
        let (_, bytes) = export_to_bytes(&source, PASSPHRASE);

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let envelope = read_zip_json(&mut archive, "credentials.enc").unwrap().unwrap();
        assert!(!envelope.contains("secret-one"));
        assert!(!envelope.contains("one@example.com"));
    }

    #[test]
    fn a_wrong_passphrase_reports_the_translatable_key() {
        let source = MemoryStore::seeded(&[("acc-1", "secret-one")]);
        let (_, bytes) = export_to_bytes(&source, PASSPHRASE);

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        // `.err()` rather than `unwrap_err()`: CredentialEntry deliberately has no Debug impl.
        let err = read_credentials(&mut archive, "another passphrase").err().unwrap();
        assert_eq!(err, "backup.wrongPassphrase");
    }

    #[test]
    fn an_archive_without_credentials_restores_without_a_passphrase() {
        let zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let bytes = zip.finish().unwrap().into_inner();

        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(read_credentials(&mut archive, PASSPHRASE).unwrap().is_none());
    }
}
