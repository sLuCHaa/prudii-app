use crate::credentials;
use crate::commands::mails::{is_pop3_account, next_synthetic_uid};
use crate::db::Database;
use crate::imap;
use crate::models::{SendAttachment, SendMailRequest};
use crate::pool::ImapPool;
use crate::smtp::{self, EmailAttachment, EmailMessage, SmtpConfig};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use lettre::message::{Message, MultiPart, SinglePart};
use uuid::Uuid;

/// Decode the attachments of an outgoing mail.
///
/// Every failure here aborts the send. A mail that silently goes out without the
/// file the user attached is worse than one that refuses to leave, so a payload
/// that cannot be decoded — or that does not match the size the composer recorded,
/// which means it was truncated somewhere on the way — is a hard error naming the
/// file.
fn decode_attachments(attachments: Option<Vec<SendAttachment>>) -> Result<Vec<EmailAttachment>, String> {
    attachments
        .unwrap_or_default()
        .into_iter()
        .map(|att| {
            let data = base64::engine::general_purpose::STANDARD
                .decode(&att.data)
                .map_err(|e| format!("Attachment \"{}\" is corrupted and was not sent: {}", att.name, e))?;

            if data.is_empty() {
                return Err(format!("Attachment \"{}\" is empty and was not sent.", att.name));
            }

            if let Some(expected) = att.size {
                if expected != data.len() as u64 {
                    return Err(format!(
                        "Attachment \"{}\" is incomplete and was not sent ({} of {} bytes).",
                        att.name,
                        data.len(),
                        expected
                    ));
                }
            }

            Ok(EmailAttachment {
                name: att.name,
                mime_type: att.mime_type,
                data,
                content_id: att.content_id,
            })
        })
        .collect()
}

struct SendAccount {
    id: String,
    email: String,
    display_name: String,
    smtp_host: String,
    smtp_port: i32,
    smtp_security: String,
    imap_host: String,
    imap_port: i32,
    auth_type: String,
    provider: String,
    /// (folder id, IMAP path); the id lets the sent copy show up before the next sync.
    sent_folder: Option<(String, String)>,
    pop3: bool,
}

fn load_send_account(db: &Database, account_id: &str) -> Result<SendAccount, String> {
    let conn = db.lock_db();
    let pop3 = is_pop3_account(&conn, account_id);
    let mut account = conn
        .query_row(
            "SELECT email, display_name, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl'), imap_host, imap_port, auth_type, provider FROM accounts WHERE id = ?1",
            rusqlite::params![account_id],
            |row| {
                Ok(SendAccount {
                    id: account_id.to_string(),
                    email: row.get(0)?,
                    display_name: row.get(1)?,
                    smtp_host: row.get(2)?,
                    smtp_port: row.get(3)?,
                    smtp_security: row.get(4)?,
                    imap_host: row.get(5)?,
                    imap_port: row.get(6)?,
                    auth_type: row.get(7)?,
                    provider: row.get(8)?,
                    sent_folder: None,
                    pop3,
                })
            },
        )
        .map_err(|e| format!("Account not found: {}", e))?;
    account.sent_folder = conn
        .query_row(
            "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'sent'",
            rusqlite::params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    Ok(account)
}

fn smtp_config(account: &SendAccount, credential: &str) -> Result<SmtpConfig, String> {
    if account.smtp_security != "ssl" && account.smtp_security != "starttls" {
        return Err(format!("Invalid SMTP security mode: '{}'. Must be 'ssl' or 'starttls'.", account.smtp_security));
    }
    // Ports are cast to u16; out-of-range values would wrap silently.
    if !(1..=65535).contains(&account.smtp_port) {
        return Err(format!("Invalid SMTP port: {}. Must be 1-65535.", account.smtp_port));
    }
    if !(1..=65535).contains(&account.imap_port) {
        return Err(format!("Invalid IMAP port: {}. Must be 1-65535.", account.imap_port));
    }
    Ok(SmtpConfig {
        host: account.smtp_host.clone(),
        port: account.smtp_port as u16,
        security: account.smtp_security.clone(),
        email: account.email.clone(),
        password: credential.to_string(),
        auth_type: account.auth_type.clone(),
        display_name: account.display_name.clone(),
    })
}

/// Detached: a running sync can hold the IMAP session for a minute.
fn spawn_sent_copy(app: &AppHandle, account: SendAccount, credential: String, raw: Vec<u8>) {
    if account.pop3 {
        let bg_app = app.clone();
        let key = account.id.clone();
        crate::task_registry::spawn_for_account(&key, async move {
            let db = bg_app.state::<Database>();
            let saved = match &account.sent_folder {
                Some((sent_id, _)) => save_sent_copy_local(&db, &account.id, sent_id, &raw).await.map(|_| ()),
                None => Err(NO_SENT_FOLDER.to_string()),
            };
            match saved {
                Ok(()) => {
                    let _ = bg_app.emit("mails-changed", serde_json::json!({ "account_id": account.id }));
                }
                Err(error) => {
                    log::warn!("send_mail: the local sent copy could not be saved");
                    let _ = bg_app.emit("sent-folder-save-failed", serde_json::json!({
                        "account_id": account.id,
                        "error": error,
                    }));
                }
            }
        });
        return;
    }
    let is_gmail_imap = account.imap_host.contains("gmail.com") || account.imap_host.contains("googlemail.com");
    let bg_app = app.clone();
    let key = account.id.clone();
    crate::task_registry::spawn_for_account(&key, async move {
        save_sent_copy(
            bg_app,
            account.id,
            account.imap_host,
            account.imap_port as u16,
            account.email,
            credential,
            account.auth_type,
            account.sent_folder,
            raw,
            is_gmail_imap,
        )
        .await;
    });
}

#[tauri::command]
pub async fn send_mail(app: AppHandle, db: State<'_, Database>, request: SendMailRequest) -> Result<(), String> {
    let account = load_send_account(&db, &request.account_id)?;

    // Resolve credential (password or OAuth access_token)
    let credential = credentials::resolve_credential(&account.id, &account.auth_type, &account.provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let (config, message) = {
        let config = smtp_config(&account, &credential)?;

        let attachments = decode_attachments(request.attachments)?;

        fn validate_email_list(addresses: &[String], field: &str) -> Result<(), String> {
            for addr in addresses {
                let addr = addr.trim();
                if !addr.is_empty() && !addr.contains('@') {
                    return Err(format!("Invalid email in {}: {}", field, addr));
                }
            }
            Ok(())
        }
        validate_email_list(&request.to, "To")?;
        validate_email_list(&request.cc, "CC")?;
        validate_email_list(&request.bcc, "BCC")?;

        if request.to.is_empty() || request.to.iter().all(|a| a.trim().is_empty()) {
            return Err("No recipient specified".into());
        }

        let message = EmailMessage {
            to: request.to,
            cc: request.cc,
            bcc: request.bcc,
            subject: request.subject,
            body_text: request.body_text,
            body_html: request.body_html,
            in_reply_to: request.in_reply_to,
            references: request.references,
            attachments,
            calendar_part: None,
            high_priority: request.high_priority,
        };

        (config, message)
    };

    let is_gmail_api = account.provider == "google" && account.auth_type == "oauth";
    let is_outlook_api = account.provider == "microsoft" && account.auth_type == "oauth";

    if is_gmail_api {
        // Build the RFC 2822 message using the same SMTP builder
        let message_bytes = smtp::build_message(config, message)
            .map_err(|e| format!("Failed to build email: {}", e))?;

        let client = crate::gmail::api::GmailClient::new(&credential);
        crate::gmail::messages::send_message(&client, &message_bytes)
            .await
            .map_err(|e| format!("Gmail send failed: {}", e))?;
    } else if is_outlook_api {
        // Send via Microsoft Graph API — JSON payload, no SMTP
        let att_tuples: Vec<(String, String, Vec<u8>, Option<String>)> = message.attachments
            .into_iter()
            .map(|a| (a.name, a.mime_type, a.data, a.content_id))
            .collect();

        let client = crate::outlook::api::OutlookClient::new(&credential);

        // Use reply endpoint for replies (threads automatically), sendMail for new messages
        if let Some(ref original_graph_id) = message.in_reply_to {
            if !original_graph_id.is_empty() {
                crate::outlook::messages::reply_mail(
                    &client,
                    original_graph_id,
                    &message.to,
                    &message.cc,
                    &message.bcc,
                    &message.subject,
                    &message.body_text,
                    message.body_html.as_deref(),
                    &att_tuples,
                    message.high_priority,
                )
                .await
                .map_err(|e| format!("Outlook reply failed: {}", e))?;
            } else {
                crate::outlook::messages::send_mail(
                    &client,
                    &message.to,
                    &message.cc,
                    &message.bcc,
                    &message.subject,
                    &message.body_text,
                    message.body_html.as_deref(),
                    &att_tuples,
                    message.high_priority,
                )
                .await
                .map_err(|e| format!("Outlook send failed: {}", e))?;
            }
        } else {
            crate::outlook::messages::send_mail(
                &client,
                &message.to,
                &message.cc,
                &message.bcc,
                &message.subject,
                &message.body_text,
                message.body_html.as_deref(),
                &att_tuples,
                message.high_priority,
            )
            .await
            .map_err(|e| format!("Outlook send failed: {}", e))?;
        }
    } else {
        // Send the email via SMTP — returns the raw RFC822 bytes
        let message_bytes = smtp::send_mail(config, message)
            .await
            .map_err(|e| format!("Failed to send email: {}", e))?;

        spawn_sent_copy(&app, account, credential, message_bytes);
    }

    Ok(())
}

/// Generated mails (iMIP replies) have no composer, undo window or draft.
pub(crate) async fn send_prepared_mail(app: &AppHandle, account_id: &str, message: EmailMessage) -> Result<(), String> {
    let account = load_send_account(&app.state::<Database>(), account_id)?;
    let credential = credentials::resolve_credential(&account.id, &account.auth_type, &account.provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;
    let config = smtp_config(&account, &credential)?;
    if account.auth_type == "oauth" && account.provider == "google" {
        let raw = smtp::build_message(config, message).map_err(|e| format!("Failed to build email: {}", e))?;
        let client = crate::gmail::api::GmailClient::new(&credential);
        return crate::gmail::messages::send_message(&client, &raw).await.map_err(|e| format!("Gmail send failed: {}", e));
    }
    if account.auth_type == "oauth" && account.provider == "microsoft" {
        let raw = smtp::build_message(config, message).map_err(|e| format!("Failed to build email: {}", e))?;
        let client = crate::outlook::api::OutlookClient::new(&credential);
        return client.send_mime(&raw).await.map_err(|e| format!("Outlook send failed: {}", e));
    }
    let raw = smtp::send_mail(config, message).await.map_err(|e| format!("Failed to send email: {}", e))?;
    spawn_sent_copy(app, account, credential, raw);
    Ok(())
}

const NO_SENT_FOLDER: &str = "No 'Sent' folder was detected for this account, so the sent copy could not be saved.";

/// POP3 has no server folder: this row and its raw source are the only copy.
async fn save_sent_copy_local(db: &Database, account_id: &str, sent_folder_id: &str, raw: &[u8]) -> Result<String, String> {
    let new_id = Uuid::new_v4().to_string();
    let source = crate::pop3::store::write_source(&db.data_dir, &new_id, raw);
    match imap::insert_local_mail(db, account_id, sent_folder_id, &new_id, raw, true).map_err(|e| e.to_string())? {
        imap::InsertOutcome::Inserted(_) => {}
        imap::InsertOutcome::Existing(existing) => {
            if crate::pop3::store::read_source(&db.data_dir, &existing).is_ok_and(|stored| stored == raw) {
                let _ = std::fs::remove_file(crate::pop3::store::source_path(&db.data_dir, &new_id));
                return Ok(existing);
            }
            let conn = db.lock_db();
            let uid = next_synthetic_uid(&conn, account_id).map_err(|e| e.to_string())?;
            imap::insert_local_twin(&conn, account_id, sent_folder_id, &new_id, raw, true, uid)
                .map_err(|e| e.to_string())?;
        }
        imap::InsertOutcome::NotStored => return Err("The sent copy could not be stored.".into()),
    }

    if imap::store_body_and_attachments(db, &new_id, raw).await.is_err() {
        log::error!("Failed to store attachments of the local sent copy");
    }
    db.lock_db()
        .execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![sent_folder_id])
        .map_err(|e| e.to_string())?;
    source.map_err(|e| format!("The source of the sent copy could not be saved: {}", e))?;
    Ok(new_id)
}

/// No raw source: replacing a draft without one deletes it instead of filling the trash.
async fn save_draft_local(db: &Database, account_id: &str, raw: &[u8]) -> Result<String, String> {
    let drafts_id: String = db
        .lock_db()
        .query_row(
            "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'drafts'",
            rusqlite::params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| "No 'Drafts' folder was detected for this account.".to_string())?;
    let id = imap::insert_local_sent_mail(db, account_id, &drafts_id, raw)
        .map_err(|e| format!("Failed to save draft: {}", e))?;
    if let Err(e) = imap::store_body_and_attachments(db, &id, raw).await {
        let _ = db.lock_db().execute("DELETE FROM mails WHERE id = ?1", rusqlite::params![id]);
        let _ = std::fs::remove_dir_all(db.data_dir.join("attachments").join(&id));
        return Err(format!("Failed to save draft: {}", e));
    }
    db.lock_db()
        .execute("UPDATE folders SET total_count = total_count + 1 WHERE id = ?1", rusqlite::params![drafts_id])
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Archive an already sent mail: APPEND it to the IMAP Sent folder, mirror it
/// into the local DB and reconcile the folder afterwards.
///
/// Runs detached from `send_mail` — every failure here is reported through
/// events (`sent-folder-save-failed`) or the log, never to the sender, because
/// the mail itself is already out.
#[allow(clippy::too_many_arguments)]
async fn save_sent_copy(
    app: AppHandle,
    account_id: String,
    imap_host: String,
    imap_port: u16,
    email: String,
    credential: String,
    auth_type: String,
    sent_folder: Option<(String, String)>,
    message_bytes: Vec<u8>,
    is_gmail_imap: bool,
) {
    let db = app.state::<Database>();
    let pool = app.state::<ImapPool>();

    // Append to Sent folder via IMAP (skip for Gmail which auto-saves sent mails).
    // The mail was already sent successfully via SMTP — if saving to Sent fails,
    // emit a non-blocking warning event so the user knows, but don't fail the send.
    let sent_folder_reconcile = sent_folder.clone();
    if !is_gmail_imap {
        if let Some((sent_id, sent_path)) = sent_folder {
            let sent_save_result = match pool.get_session_max_wait_guarded(&account_id, &imap_host, imap_port, &email, &credential, &auth_type, crate::pool::APPEND_WAIT).await {
                Ok((mut session, _guard)) => {
                    match imap::append_to_folder(&mut session, &sent_path, &message_bytes, &["\\Seen"], None).await {
                        Ok(_) => {
                            pool.return_session(&account_id, session).await;
                            // Insert the sent copy locally so it appears immediately,
                            // instead of relying on a later sync to re-fetch it (which
                            // is unreliable on some servers, e.g. GMX). The next sync
                            // claims this row by Message-ID and backfills the real UID.
                            match imap::insert_local_sent_mail(&db, &account_id, &sent_id, &message_bytes) {
                                // Store the attachments from the same bytes — the local row has
                                // no UID yet, so opening the sent mail cannot fetch them.
                                Ok(sent_mail_id) => {
                                    if let Err(e) = imap::store_body_and_attachments(&db, &sent_mail_id, &message_bytes).await {
                                        log::error!("Failed to store attachments of the local sent copy: {}", e);
                                    }
                                    // The send already returned — tell the UI the row exists.
                                    let _ = app.emit("mails-changed", serde_json::json!({ "account_id": account_id }));
                                }
                                Err(e) => log::warn!("Failed to insert local sent copy (will appear after next sync): {}", e),
                            }
                            Ok(())
                        }
                        Err(e) => {
                            let err_msg = format!("Failed to append to Sent folder: {}", e);
                            log::warn!("{}", err_msg);
                            if let Err(le) = session.logout().await {
                                log::warn!("Failed to logout IMAP session after Sent append failure: {}", le);
                            }
                            pool.release(&account_id);
                            Err(err_msg)
                        }
                    }
                }
                Err(e) => {
                    let err_msg = format!("Could not connect to IMAP to save sent mail: {}", e);
                    log::warn!("{}", err_msg);
                    Err(err_msg)
                }
            };
            if let Err(msg) = sent_save_result {
                let _ = app.emit("sent-folder-save-failed", serde_json::json!({
                    "account_id": account_id,
                    "error": msg,
                }));
            }
        } else {
            // No folder is classified as Sent for this account — the sent copy
            // would silently vanish. Surface it instead of dropping it quietly.
            log::warn!("send_mail: no Sent folder detected — sent copy not saved");
            let _ = app.emit("sent-folder-save-failed", serde_json::json!({
                "account_id": account_id,
                "error": NO_SENT_FOLDER,
            }));
        }
    }

    // Reconcile of only the Sent folder: claims the mirrored row's UID;
    // for Gmail-IMAP imports the auto-saved copy.
    if let Some((sent_id, sent_path)) = sent_folder_reconcile {
        let folder = crate::models::Folder {
            id: sent_id,
            account_id: account_id.clone(),
            name: "Sent".to_string(),
            folder_type: "sent".to_string(),
            path: sent_path,
            unread_count: 0,
            total_count: 0,
            is_local: false,
            color: String::new(),
        };
        match pool.get_session_guarded(&account_id, &imap_host, imap_port, &email, &credential, &auth_type).await {
            Ok((mut session, _guard)) => {
                match imap::sync_mails(&mut session, &folder, &account_id, &db, None).await {
                    Ok(_) => pool.return_session(&account_id, session).await,
                    Err(e) => {
                        log::warn!("Sent-folder reconcile failed (next sync catches up): {}", e);
                        drop(session);
                        pool.release(&account_id);
                    }
                }
                let _ = app.emit("mails-changed", serde_json::json!({ "account_id": account_id }));
            }
            Err(e) => log::warn!("Sent-folder reconcile: no IMAP session: {}", e),
        };
    }
}

#[tauri::command]
pub async fn test_smtp_connection(
    host: String,
    port: i32,
    email: String,
    password: String,
    security: Option<String>,
    auth_type: Option<String>,
) -> Result<String, String> {
    let sec = security.as_deref().unwrap_or(if port == 465 { "ssl" } else { "starttls" });
    let at = auth_type.as_deref().unwrap_or("password");
    smtp::test_smtp_connection(&host, port as u16, &email, &password, sec, at)
        .await
        .map_err(|e| e.to_string())?;

    Ok("SMTP connection successful".to_string())
}

/// Save a draft — routes to Graph API for Gmail/Outlook, IMAP for others.
///
/// Returns the id of the local `mails` row for the saved draft, so the UI can show
/// and reopen it right away. `None` for the Gmail/Outlook API paths, which still
/// depend on the next sync to pull the draft down (their local rows are keyed by
/// the provider's API id, not the RFC Message-ID, so a local insert would not be
/// deduplicated by the sync).
#[tauri::command]
pub async fn save_draft(db: State<'_, Database>, pool: State<'_, ImapPool>, request: SendMailRequest) -> Result<Option<String>, String> {
    let pop3_sender: Option<(String, String)> = {
        let conn = db.lock_db();
        if is_pop3_account(&conn, &request.account_id) {
            let sender = conn
                .query_row(
                    "SELECT email, display_name FROM accounts WHERE id = ?1",
                    rusqlite::params![request.account_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| format!("Account not found: {}", e))?;
            Some(sender)
        } else {
            None
        }
    };
    if let Some((email, display_name)) = pop3_sender {
        let message_bytes = build_draft_message(&email, &display_name, &request)?;
        return save_draft_local(&db, &request.account_id, &message_bytes).await.map(Some);
    }

    let (email, display_name, imap_host, imap_port, auth_type, provider, drafts_folder_path, drafts_folder_id): (String, String, String, i32, String, String, String, Option<String>) = {
        let conn = db.lock_db();

        let account_info: (String, String, String, i32, String, String) = conn
            .query_row(
                "SELECT email, display_name, imap_host, imap_port, auth_type, provider FROM accounts WHERE id = ?1",
                rusqlite::params![request.account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .map_err(|e| format!("Account not found: {}", e))?;

        let drafts_folder: Option<(String, String)> = conn
            .query_row(
                "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'drafts'",
                rusqlite::params![request.account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        let (drafts_id, drafts_path) = match drafts_folder {
            Some((id, path)) => (Some(id), path),
            None => (None, "Drafts".to_string()),
        };

        (account_info.0, account_info.1, account_info.2, account_info.3, account_info.4, account_info.5, drafts_path, drafts_id)
    };

    let credential = credentials::resolve_credential(&request.account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let is_gmail_api = provider == "google" && auth_type == "oauth";
    let is_outlook_api = provider == "microsoft" && auth_type == "oauth";

    if is_outlook_api {
        // Outlook Graph API: POST /me/messages creates a draft
        let attachments: Vec<(String, String, Vec<u8>, Option<String>)> = decode_attachments(request.attachments.clone())?
            .into_iter()
            .map(|att| (smtp::attachment::repair_encoded_name(&att.name), att.mime_type, att.data, att.content_id))
            .collect();

        let client = crate::outlook::api::OutlookClient::new(&credential);
        crate::outlook::messages::save_draft(
            &client,
            &request.to,
            &request.cc,
            &request.bcc,
            &request.subject,
            &request.body_text,
            request.body_html.as_deref(),
            &attachments,
            request.high_priority,
        )
        .await
        .map_err(|e| format!("Outlook draft failed: {}", e))?;

        return Ok(None);
    }

    // Gmail and IMAP both need an RFC822 message
    let message_bytes = build_draft_message(&email, &display_name, &request)?;

    if is_gmail_api {
        // Gmail API: POST /me/drafts with base64url-encoded RFC822
        let client = crate::gmail::api::GmailClient::new(&credential);
        crate::gmail::messages::save_draft(&client, &message_bytes)
            .await
            .map_err(|e| format!("Gmail draft failed: {}", e))?;
        return Ok(None);
    }

    // The user waits for this, so don't queue behind a running sync — a second
    // connection is better than a draft save that hangs for a minute.
    let mut session = pool.get_session_max_wait(&request.account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type, crate::pool::APPEND_WAIT)
        .await
        .map_err(|e| format!("Failed to get IMAP session: {}", e))?;

    match imap::append_to_folder(&mut session, &drafts_folder_path, &message_bytes, &["\\Draft", "\\Seen"], None).await {
        Ok(_) => pool.return_session(&request.account_id, session).await,
        Err(e) => {
            let _ = session.logout().await;
            pool.release(&request.account_id);
            return Err(format!("Failed to save draft: {}", e));
        }
    }

    // Mirror the draft into the local DB immediately. Without this the draft only
    // exists on the server until the next sync round-trip finishes, so a just-saved
    // draft cannot be reopened (the superseded local row is trashed right after this
    // returns). The row carries uid = NULL and is claimed by Message-ID on the next
    // sync, so no duplicate appears.
    let local_id = match drafts_folder_id {
        Some(folder_id) => match imap::insert_local_sent_mail(&db, &request.account_id, &folder_id, &message_bytes) {
            Ok(id) => Some(id),
            Err(e) => {
                log::warn!("save_draft: local mirror failed, falling back to sync: {}", e);
                None
            }
        },
        None => None,
    };

    // The mirrored row has no UID yet, so reopening the draft cannot fetch its
    // attachments from the server. Store them from the bytes we just built — otherwise
    // the draft reopens without them and would be sent with the files missing.
    if let Some(ref id) = local_id {
        if let Err(e) = imap::store_body_and_attachments(&db, id, &message_bytes).await {
            log::error!("save_draft: storing attachments for the local draft failed: {}", e);
        }
    }

    Ok(local_id)
}

/// The draft as RFC822 bytes for the Gmail API and the IMAP Drafts folder.
pub(crate) fn build_draft_message(email: &str, display_name: &str, request: &SendMailRequest) -> Result<Vec<u8>, String> {
    let from_mailbox = if display_name.is_empty() {
        email.parse::<lettre::Address>()
            .map_err(|e| format!("Invalid email: {}", e))?
            .into()
    } else {
        lettre::message::Mailbox::new(Some(display_name.to_string()), email.parse().map_err(|e| format!("Invalid email: {}", e))?)
    };

    let from_mailbox_clone = from_mailbox.clone();
    let mut message_builder = Message::builder()
        .from(from_mailbox)
        .message_id(Some(smtp::generate_message_id(email)))
        .subject(&request.subject);

    // Add recipients — drafts may have no recipients yet, so use sender as placeholder.
    // Bcc is written to the draft too; without it the recipients are lost as soon as the
    // draft is reopened.
    let has_any_recipient = request.to.iter().any(|a| !a.trim().is_empty())
        || request.cc.iter().any(|a| !a.trim().is_empty())
        || request.bcc.iter().any(|a| !a.trim().is_empty());

    if has_any_recipient {
        let mut added_any = false;
        for to in &request.to {
            if to.trim().is_empty() { continue; }
            match smtp::parse_recipient(to) {
                Ok(addr) => { message_builder = message_builder.to(addr); added_any = true; }
                Err(e) => log::warn!("save_draft: skipping invalid to address '{}': {}", to, e),
            }
        }
        for cc in &request.cc {
            if cc.trim().is_empty() { continue; }
            match smtp::parse_recipient(cc) {
                Ok(addr) => { message_builder = message_builder.cc(addr); added_any = true; }
                Err(e) => log::warn!("save_draft: skipping invalid cc address '{}': {}", cc, e),
            }
        }
        for bcc in &request.bcc {
            if bcc.trim().is_empty() { continue; }
            match smtp::parse_recipient(bcc) {
                Ok(addr) => { message_builder = message_builder.bcc(addr); added_any = true; }
                Err(e) => log::warn!("save_draft: skipping invalid bcc address '{}': {}", bcc, e),
            }
        }
        // All addresses failed to parse — fall back to sender placeholder so draft still saves
        if !added_any {
            message_builder = message_builder.to(from_mailbox_clone);
        }
    } else {
        // No recipients — use sender as placeholder (required for valid RFC2822)
        message_builder = message_builder.to(from_mailbox_clone);
    }

    // Add reply headers if present (ensure RFC 5322 angle brackets)
    if let Some(ref reply_to) = request.in_reply_to {
        let id = reply_to.trim();
        let bracketed = if id.starts_with('<') && id.ends_with('>') { id.to_string() } else { format!("<{}>", id) };
        message_builder = message_builder.in_reply_to(bracketed);
    }
    if let Some(ref refs) = request.references {
        let bracketed: Vec<String> = refs.split_whitespace()
            .map(|id| {
                let id = id.trim();
                if id.starts_with('<') && id.ends_with('>') { id.to_string() } else { format!("<{}>", id) }
            })
            .collect();
        message_builder = message_builder.references(bracketed.join(" "));
    }
    if request.high_priority {
        message_builder = crate::priority::with_high_priority(message_builder);
    }

    let attachments = decode_attachments(request.attachments.clone())?;
    // Mirrors build_lettre_message: cid-referenced images live in a
    // multipart/related container around the HTML part, so a draft synced back
    // from the server round-trips its embedded images like any received mail.
    let (inline, regular): (Vec<&smtp::EmailAttachment>, Vec<&smtp::EmailAttachment>) = attachments
        .iter()
        .partition(|a| a.content_id.is_some() && request.body_html.is_some());

    enum HtmlSide {
        Single(SinglePart),
        Related(MultiPart),
    }
    let html_side = request.body_html.as_ref().map(|html| {
        let html_part = SinglePart::html(html.clone());
        if inline.is_empty() {
            HtmlSide::Single(html_part)
        } else {
            let mut related = MultiPart::related().singlepart(html_part);
            for att in &inline {
                let cid = att.content_id.as_deref().unwrap_or_default();
                related = related.singlepart(smtp::inline_attachment_part(&att.name, &att.mime_type, att.data.clone(), cid));
            }
            HtmlSide::Related(related)
        }
    });
    let text_part = SinglePart::plain(request.body_text.clone());

    let message = if regular.is_empty() {
        match html_side {
            Some(HtmlSide::Single(h)) => message_builder
                .multipart(MultiPart::alternative().singlepart(text_part).singlepart(h)),
            Some(HtmlSide::Related(r)) => message_builder
                .multipart(MultiPart::alternative().singlepart(text_part).multipart(r)),
            None => message_builder.body(request.body_text.clone()),
        }
        .map_err(|e| format!("Failed to build message: {}", e))?
    } else {
        let body_part = match html_side {
            Some(HtmlSide::Single(h)) => MultiPart::alternative().singlepart(text_part).singlepart(h),
            Some(HtmlSide::Related(r)) => MultiPart::alternative().singlepart(text_part).multipart(r),
            None => MultiPart::alternative().singlepart(text_part),
        };
        let mut mixed = MultiPart::mixed().multipart(body_part);
        for att in &regular {
            mixed = mixed.singlepart(smtp::attachment_part(&att.name, &att.mime_type, att.data.clone()));
        }
        message_builder
            .multipart(mixed)
            .map_err(|e| format!("Failed to build message: {}", e))?
    };

    Ok(message.formatted())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledMail {
    pub id: String,
    pub account_id: String,
    pub subject: String,
    pub to_addresses: String,
    pub scheduled_at: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn schedule_send(
    db: State<'_, Database>,
    request: SendMailRequest,
    scheduled_at: String,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let conn = db.lock_db();
    insert_scheduled(&conn, &id, &request, &scheduled_at).map_err(|e| format!("Failed to schedule mail: {}", e))?;
    Ok(id)
}

pub(crate) fn insert_scheduled(conn: &rusqlite::Connection, id: &str, request: &SendMailRequest, scheduled_at: &str) -> rusqlite::Result<()> {
    let attachments_json = request.attachments
        .as_ref()
        .map(|atts| serde_json::to_string(atts).unwrap_or_default())
        .unwrap_or_default();

    conn.execute(
        "INSERT INTO drafts (id, account_id, subject, to_addresses, cc_addresses, bcc_addresses, body_text, body_html, in_reply_to, references_header, attachments_json, scheduled_at, high_priority)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            id,
            request.account_id,
            request.subject,
            serde_json::to_string(&request.to).unwrap_or_default(),
            serde_json::to_string(&request.cc).unwrap_or_default(),
            serde_json::to_string(&request.bcc).unwrap_or_default(),
            request.body_text,
            request.body_html.as_deref().unwrap_or_default(),
            request.in_reply_to.as_deref().unwrap_or(""),
            request.references.as_deref().unwrap_or(""),
            attachments_json,
            scheduled_at,
            request.high_priority as i32,
        ],
    )?;
    Ok(())
}

pub(crate) struct DueScheduled {
    pub draft_id: String,
    pub retry_count: i32,
    pub request: SendMailRequest,
}

pub(crate) fn due_scheduled(conn: &rusqlite::Connection, max_retries: i32) -> rusqlite::Result<Vec<DueScheduled>> {
    let mut stmt = conn.prepare(
        "SELECT id, account_id, COALESCE(subject, ''), COALESCE(to_addresses, '[]'), \
         COALESCE(cc_addresses, '[]'), COALESCE(bcc_addresses, '[]'), COALESCE(body_text, ''), \
         COALESCE(body_html, ''), COALESCE(in_reply_to, ''), COALESCE(references_header, ''), \
         COALESCE(attachments_json, ''), retry_count, COALESCE(high_priority, 0) \
         FROM drafts WHERE scheduled_at IS NOT NULL AND scheduled_at != '' \
         AND scheduled_at <= datetime('now') AND retry_count < ?1"
    )?;
    let optional = |s: String| if s.is_empty() { None } else { Some(s) };
    let rows = stmt.query_map(rusqlite::params![max_retries], |row| {
        let addresses = |i: usize| -> rusqlite::Result<Vec<String>> {
            Ok(serde_json::from_str(&row.get::<_, String>(i)?).unwrap_or_default())
        };
        let attachments_json: String = row.get(10)?;
        Ok(DueScheduled {
            draft_id: row.get(0)?,
            retry_count: row.get(11)?,
            request: SendMailRequest {
                account_id: row.get(1)?,
                to: addresses(3)?,
                cc: addresses(4)?,
                bcc: addresses(5)?,
                subject: row.get(2)?,
                body_text: row.get(6)?,
                body_html: optional(row.get(7)?),
                in_reply_to: optional(row.get(8)?),
                references: optional(row.get(9)?),
                attachments: if attachments_json.is_empty() { None } else { serde_json::from_str(&attachments_json).ok() },
                high_priority: row.get::<_, i32>(12)? != 0,
            },
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn cancel_scheduled_send(
    db: State<'_, Database>,
    draft_id: String,
) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute("DELETE FROM drafts WHERE id = ?1", rusqlite::params![draft_id])
        .map_err(|e| format!("Failed to cancel: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn list_scheduled_mails(
    db: State<'_, Database>,
) -> Result<Vec<ScheduledMail>, String> {
    let conn = db.lock_db();
    let mut stmt = conn.prepare(
        "SELECT id, account_id, COALESCE(subject, ''), COALESCE(to_addresses, ''), scheduled_at, created_at
         FROM drafts WHERE scheduled_at IS NOT NULL AND scheduled_at != ''
         ORDER BY scheduled_at ASC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(ScheduledMail {
            id: row.get(0)?,
            account_id: row.get(1)?,
            subject: row.get(2)?,
            to_addresses: row.get(3)?,
            scheduled_at: row.get(4)?,
            created_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(rows)
}

#[tauri::command]
pub async fn check_scheduled_mails(
    app: AppHandle,
    _db: State<'_, Database>,
) -> Result<i32, String> {
    run_scheduled_check(&app).await
}

/// Send every due scheduled mail. Called by the frontend command above and by
/// the Rust-side timer in lib.rs — the timer exists because a JS interval only
/// fires while the main window is visible, so mails scheduled for 09:00 never
/// went out while the app sat in the tray.
pub async fn run_scheduled_check(app: &AppHandle) -> Result<i32, String> {
    const MAX_RETRIES: i32 = 3;

    let due_drafts = {
        let db = app.state::<Database>();
        let conn = db.lock_db();
        due_scheduled(&conn, MAX_RETRIES).map_err(|e| e.to_string())?
    };

    let count = due_drafts.len() as i32;
    if count == 0 {
        return Ok(0);
    }

    for DueScheduled { draft_id, retry_count, request } in due_drafts {
        let account_id = request.account_id.clone();
        let subject = request.subject.clone();

        let db_state: tauri::State<'_, Database> = app.state();
        match send_mail(app.clone(), db_state, request).await {
            Ok(()) => {
                let db_ref = app.state::<Database>();
                let conn = db_ref.lock_db();
                let _ = conn.execute("DELETE FROM drafts WHERE id = ?1", rusqlite::params![draft_id]);
                log::info!("Scheduled mail sent: {} ({})", subject, draft_id);
                let _ = app.emit("scheduled-mail-sent", serde_json::json!({
                    "draft_id": draft_id,
                    "subject": subject,
                    "account_id": account_id,
                }));
            }
            Err(e) => {
                let new_count = retry_count + 1;
                log::warn!("Failed to send scheduled mail {} (attempt {}/{}): {}", draft_id, new_count, MAX_RETRIES, e);
                let db_ref = app.state::<Database>();
                let conn = db_ref.lock_db();
                let _ = conn.execute(
                    "UPDATE drafts SET retry_count = ?1 WHERE id = ?2",
                    rusqlite::params![new_count, draft_id],
                );
                if new_count >= MAX_RETRIES {
                    log::error!("Scheduled mail permanently failed after {} retries: {} ({})", MAX_RETRIES, subject, draft_id);
                    let _ = app.emit("scheduled-mail-failed", serde_json::json!({
                        "draft_id": draft_id,
                        "subject": subject,
                        "error": e,
                    }));
                }
            }
        }
    }

    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_accounts_load_with_their_sent_folder_and_validate_ports() {
        let db = Database::new(std::env::temp_dir().join(format!("prudii-send-{}", Uuid::new_v4()))).unwrap();
        {
            let conn = db.lock_db();
            conn.execute(
                "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host, smtp_port) VALUES ('acc', 'sam@example.com', 'Sam', 'imap', 'imap.example.com', 'smtp.example.com', 465)",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO folders (id, account_id, name, folder_type, path) VALUES ('sent', 'acc', 'Sent', 'sent', 'Sent')", []).unwrap();
        }
        let account = load_send_account(&db, "acc").unwrap();
        assert_eq!(account.sent_folder, Some(("sent".to_string(), "Sent".to_string())));
        assert_eq!(account.smtp_security, "ssl");
        let config = smtp_config(&account, "secret").unwrap();
        assert_eq!((config.host.as_str(), config.port, config.display_name.as_str()), ("smtp.example.com", 465, "Sam"));
        assert!(smtp_config(&SendAccount { smtp_port: 0, ..account }, "secret").is_err());
        assert!(load_send_account(&db, "missing").is_err());
    }

    fn scheduled_request(account_id: &str, subject: &str, high_priority: bool) -> SendMailRequest {
        SendMailRequest {
            account_id: account_id.into(),
            to: vec!["anna.weber@studio-halde.example".into()],
            cc: vec![],
            bcc: vec![],
            subject: subject.into(),
            body_text: "Hallo Anna".into(),
            body_html: None,
            in_reply_to: None,
            references: None,
            attachments: None,
            high_priority,
        }
    }

    #[test]
    fn draft_carries_priority_headers_only_when_high() {
        let draft = |high| {
            let raw = build_draft_message("sam@studio-halde.example", "Sam", &scheduled_request("acc", "Entwurf", high)).unwrap();
            String::from_utf8_lossy(&raw).to_string()
        };
        let high = draft(true);
        for header in ["X-Priority: 1 (Highest)\r\n", "X-MSMail-Priority: High\r\n", "Importance: High\r\n"] {
            assert!(high.contains(header), "{header} missing in:\n{high}");
        }
        let normal = draft(false);
        assert!(!normal.contains("X-Priority") && !normal.contains("Importance:"), "{normal}");
    }

    #[test]
    fn scheduled_mail_keeps_high_priority() {
        let db = crate::test_support::temp_db();
        let conn = db.lock_db();
        let account = crate::test_support::seed_account(&conn, "sam@studio-halde.example");
        insert_scheduled(&conn, "s1", &scheduled_request(&account, "Dringend", true), "2000-01-01 00:00:00").unwrap();
        insert_scheduled(&conn, "s2", &scheduled_request(&account, "Normal", false), "2000-01-01 00:00:01").unwrap();

        let due = due_scheduled(&conn, 3).unwrap();
        let priority_of = |id: &str| due.iter().find(|d| d.draft_id == id).map(|d| d.request.high_priority);
        assert_eq!(due.len(), 2);
        assert_eq!(priority_of("s1"), Some(true));
        assert_eq!(priority_of("s2"), Some(false));
        assert_eq!(due[0].request.to, vec!["anna.weber@studio-halde.example".to_string()]);
    }

    fn seed_pop3(db: &Database) -> (String, String, String) {
        let conn = db.lock_db();
        let account = crate::test_support::seed_account(&conn, "anna@studio-halde.example");
        conn.execute("UPDATE accounts SET incoming_protocol = 'pop3' WHERE id = ?1", [&account]).unwrap();
        let sent = crate::test_support::seed_folder(&conn, &account, "sent");
        let drafts = crate::test_support::seed_folder(&conn, &account, "drafts");
        (account, sent, drafts)
    }

    fn folder_rows(db: &Database, folder_id: &str) -> Vec<(String, bool)> {
        let conn = db.lock_db();
        let mut stmt = conn.prepare("SELECT id, is_read FROM mails WHERE folder_id = ?1").unwrap();
        stmt.query_map([folder_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn total_count(db: &Database, folder_id: &str) -> i64 {
        db.lock_db()
            .query_row("SELECT total_count FROM folders WHERE id = ?1", [folder_id], |row| row.get(0))
            .unwrap()
    }

    fn raw_mail(body: &str) -> Vec<u8> {
        format!("From: anna@studio-halde.example\r\nTo: info@studio-halde.example\r\nSubject: Angebot\r\nMessage-ID: <angebot-1@studio-halde.example>\r\nDate: Fri, 27 Nov 2026 10:00:00 +0000\r\n\r\n{body}\r\n").into_bytes()
    }

    #[tokio::test]
    async fn pop3_sent_copy_is_local_with_source() {
        let db = crate::test_support::temp_db();
        let (account, sent, _) = seed_pop3(&db);
        let raw = raw_mail("Hallo Anna");

        let id = save_sent_copy_local(&db, &account, &sent, &raw).await.unwrap();

        assert_eq!(folder_rows(&db, &sent), vec![(id.clone(), true)]);
        assert_eq!(crate::pop3::store::read_source(&db.data_dir, &id).unwrap(), raw);
        assert_eq!(total_count(&db, &sent), 1);
        let pending: i64 = db.lock_db().query_row("SELECT COUNT(*) FROM pending_ops", [], |row| row.get(0)).unwrap();
        assert_eq!(pending, 0);
    }

    #[tokio::test]
    async fn pop3_resent_message_with_other_bytes_becomes_a_twin() {
        let db = crate::test_support::temp_db();
        let (account, sent, _) = seed_pop3(&db);
        let first = raw_mail("Hallo Anna");
        let second = raw_mail("Hallo Anna, neuer Stand");

        let first_id = save_sent_copy_local(&db, &account, &sent, &first).await.unwrap();
        assert_eq!(save_sent_copy_local(&db, &account, &sent, &first).await.unwrap(), first_id);
        assert_eq!(folder_rows(&db, &sent).len(), 1);
        assert_eq!(std::fs::read_dir(db.data_dir.join("mail_sources")).unwrap().count(), 1);

        let second_id = save_sent_copy_local(&db, &account, &sent, &second).await.unwrap();
        assert_ne!(first_id, second_id);
        assert_eq!(folder_rows(&db, &sent).len(), 2);
        assert_eq!(crate::pop3::store::read_source(&db.data_dir, &first_id).unwrap(), first);
        assert_eq!(crate::pop3::store::read_source(&db.data_dir, &second_id).unwrap(), second);
        assert_eq!(total_count(&db, &sent), 2);
    }

    #[tokio::test]
    async fn pop3_sent_copy_keeps_the_row_when_the_source_cannot_be_written() {
        let db = crate::test_support::temp_db();
        let (account, sent, _) = seed_pop3(&db);
        std::fs::write(db.data_dir.join("mail_sources"), b"x").unwrap();

        assert!(save_sent_copy_local(&db, &account, &sent, &raw_mail("Hallo Anna")).await.is_err());

        assert_eq!(folder_rows(&db, &sent).len(), 1);
        assert_eq!(total_count(&db, &sent), 1);
    }

    #[tokio::test]
    async fn pop3_draft_is_local_without_source() {
        let db = crate::test_support::temp_db();
        let (account, _, drafts) = seed_pop3(&db);
        let draft = || build_draft_message("anna@studio-halde.example", "Anna Weber", &scheduled_request(&account, "Entwurf", false)).unwrap();

        let first = save_draft_local(&db, &account, &draft()).await.unwrap();
        let second = save_draft_local(&db, &account, &draft()).await.unwrap();

        assert_ne!(first, second);
        assert_eq!(folder_rows(&db, &drafts).len(), 2);
        assert_eq!(total_count(&db, &drafts), 2);
        assert!(!crate::pop3::store::has_source(&db.data_dir, &first));
        assert!(!crate::pop3::store::has_source(&db.data_dir, &second));
    }

    #[tokio::test]
    async fn pop3_draft_without_drafts_folder_is_an_error() {
        let db = crate::test_support::temp_db();
        let (account, _, drafts) = seed_pop3(&db);
        db.lock_db().execute("DELETE FROM folders WHERE id = ?1", [&drafts]).unwrap();
        let raw = build_draft_message("anna@studio-halde.example", "Anna Weber", &scheduled_request(&account, "Entwurf", false)).unwrap();

        assert!(save_draft_local(&db, &account, &raw).await.is_err());
    }

    #[test]
    fn pop3_accounts_load_for_sending() {
        let db = crate::test_support::temp_db();
        let (account, sent, _) = seed_pop3(&db);
        let loaded = load_send_account(&db, &account).unwrap();
        assert!(loaded.pop3);
        assert_eq!(loaded.sent_folder.map(|(id, _)| id), Some(sent));
    }
}
