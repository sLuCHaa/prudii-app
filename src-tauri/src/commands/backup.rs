use crate::db::Database;
use crate::models::{BackupIncludes, BackupManifest, BackupOptions, BackupProgress, BackupStats, RestorePreview};
use crate::pool::ImapPool;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

static BACKUP_IN_PROGRESS: std::sync::LazyLock<Mutex<bool>> =
    std::sync::LazyLock::new(|| Mutex::new(false));

fn emit_backup_progress(app: &AppHandle, progress: &BackupProgress) {
    let _ = app.emit("backup-progress", progress);
}

fn emit_restore_progress(app: &AppHandle, progress: &BackupProgress) {
    let _ = app.emit("restore-progress", progress);
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
    {
        return Err("Please select at least one category to backup.".into());
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

    let result = do_create_backup_inner(&app, &options, &file_path, &data_dir);

    {
        let mut in_progress = BACKUP_IN_PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        *in_progress = false;
    }

    if let Err(e) = result {
        // Clean up partial ZIP
        let _ = std::fs::remove_file(&file_path);
        emit_backup_progress(&app, &BackupProgress {
            status: "error".into(),
            message: format!("Backup failed: {}", e),
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

    current_step += 1;
    emit_backup_progress(app, &BackupProgress {
        status: "exporting_manifest".into(),
        message: "Writing manifest...".into(),
        current_step,
        total_steps,
    });

    let manifest = BackupManifest {
        version: 1,
        schema_version: 26,
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        includes: BackupIncludes {
            app_settings: options.include_settings,
            accounts: options.include_accounts,
            folders: options.include_folders,
            mails: options.include_mails,
            attachments: options.include_attachments,
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

    let manifest: BackupManifest = {
        let mut manifest_file = archive.by_name("manifest.json")
            .map_err(|_| "Not a valid Prudii backup: manifest.json not found.".to_string())?;
        let mut contents = String::new();
        manifest_file.read_to_string(&mut contents)
            .map_err(|e| format!("Failed to read manifest: {}", e))?;
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse manifest: {}", e))?
    };

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
        manifest,
        existing_account_emails,
    }))
}

#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    file_path: String,
    strategy: String,
) -> Result<(), String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        do_restore_backup(app_clone, file_path, strategy).await;
    });
    Ok(())
}

async fn do_restore_backup(
    app: AppHandle,
    file_path: String,
    strategy: String,
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

    let result = do_restore_backup_inner(&app, &file_path, &strategy);

    // Clear all IMAP pool connections — restored data may have changed account IDs/folders
    if result.is_ok() {
        let pool = app.state::<ImapPool>();
        pool.clear_all().await;
    }

    {
        let mut in_progress = BACKUP_IN_PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        *in_progress = false;
    }

    if let Err(e) = result {
        emit_restore_progress(&app, &BackupProgress {
            status: "error".into(),
            message: format!("Restore failed: {}", e),
            current_step: 0,
            total_steps: 0,
        });
    }
}

fn do_restore_backup_inner(
    app: &AppHandle,
    file_path: &str,
    strategy: &str,
) -> Result<(), String> {
    let db = app.state::<Database>();
    let data_dir = db.data_dir.clone();
    let is_replace = strategy == "replace";

    let file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open backup: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid ZIP file: {}", e))?;

    let manifest: BackupManifest = {
        let mut f = archive.by_name("manifest.json")
            .map_err(|_| "manifest.json not found".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())?
    };

    let mut total_steps: u32 = 0;
    if manifest.includes.app_settings { total_steps += 1; }
    if manifest.includes.accounts { total_steps += 1; }
    if manifest.includes.folders { total_steps += 1; }
    if manifest.includes.mails { total_steps += 2; } // mails + FTS rebuild
    if manifest.includes.attachments { total_steps += 1; }
    let mut current_step: u32 = 0;

    let mut accounts_needing_passwords: Vec<String> = Vec::new();

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
            }
        }
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
        conn.execute_batch("DELETE FROM mails_fts;").map_err(|e| e.to_string())?;
        conn.execute_batch(
            "INSERT INTO mails_fts (mail_id, subject, from_email, from_name, body_text)
             SELECT id, subject, from_email, from_name, body_text FROM mails;"
        ).map_err(|e| e.to_string())?;
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

                    // ZIP Slip protection: reject path components that escape the base dir
                    // Check BEFORE creating any directories or writing any files
                    if rel_path.contains("..") || rel_path.starts_with('/') || rel_path.starts_with('\\') {
                        log::warn!("ZIP Slip attempt blocked: {}", name);
                        continue;
                    }

                    let dest = attachments_base.join(rel_path);

                    if let Some(parent) = dest.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }

                    // Double-check: canonical path must be inside base dir
                    let canonical_base = attachments_base.canonicalize().unwrap_or_else(|_| attachments_base.clone());
                    let canonical_dest = dest.canonicalize().unwrap_or_else(|_| dest.clone());
                    if !canonical_dest.starts_with(&canonical_base) {
                        log::warn!("ZIP Slip attempt blocked (canonical check): {}", name);
                        continue;
                    }

                    let mut out_file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                    std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    if !accounts_needing_passwords.is_empty() {
        let _ = app.emit("restore-needs-passwords", serde_json::json!({
            "emails": accounts_needing_passwords,
        }));
    }

    emit_restore_progress(app, &BackupProgress {
        status: "done".into(),
        message: "Restore completed successfully!".into(),
        current_step: total_steps,
        total_steps,
    });

    Ok(())
}
