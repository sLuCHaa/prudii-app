use crate::credentials;
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
            })
        })
        .collect()
}

#[tauri::command]
pub async fn send_mail(app: AppHandle, db: State<'_, Database>, pool: State<'_, ImapPool>, request: SendMailRequest) -> Result<(), String> {
    // Get account details, before any await
    let (account_id, email, display_name, smtp_host, smtp_port, smtp_security, imap_host, imap_port, auth_type, provider, sent_folder) = {
        let conn = db.lock_db();
        let (email, display_name, smtp_host, smtp_port, smtp_security, imap_host, imap_port, auth_type, provider): (String, String, String, i32, String, String, i32, String, String) = conn
            .query_row(
                "SELECT email, display_name, smtp_host, smtp_port, COALESCE(smtp_security, 'ssl'), imap_host, imap_port, auth_type, provider FROM accounts WHERE id = ?1",
                rusqlite::params![request.account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
            )
            .map_err(|e| format!("Account not found: {}", e))?;

        // Find the Sent folder (id + path). The id lets us insert the sent copy into
        // the local DB right after APPEND so it shows up without waiting for a sync.
        let sent_folder: Option<(String, String)> = conn
            .query_row(
                "SELECT id, path FROM folders WHERE account_id = ?1 AND folder_type = 'sent'",
                rusqlite::params![request.account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        (request.account_id.clone(), email, display_name, smtp_host, smtp_port, smtp_security, imap_host, imap_port, auth_type, provider, sent_folder)
    };

    // Resolve credential (password or OAuth access_token)
    let credential = credentials::resolve_credential(&account_id, &auth_type, &provider)
        .await
        .map_err(|e| format!("Failed to retrieve credentials: {}", e))?;

    let (config, message) = {
        if smtp_security != "ssl" && smtp_security != "starttls" {
            return Err(format!("Invalid SMTP security mode: '{}'. Must be 'ssl' or 'starttls'.", smtp_security));
        }

        // Validate port ranges (prevent silent truncation when casting i32 -> u16)
        if !(1..=65535).contains(&smtp_port) {
            return Err(format!("Invalid SMTP port: {}. Must be 1-65535.", smtp_port));
        }
        if !(1..=65535).contains(&imap_port) {
            return Err(format!("Invalid IMAP port: {}. Must be 1-65535.", imap_port));
        }

        let config = SmtpConfig {
            host: smtp_host,
            port: smtp_port as u16,
            security: smtp_security,
            email: email.clone(),
            password: credential.clone(),
            auth_type: auth_type.clone(),
            display_name: display_name.clone(),
        };

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
        };

        (config, message)
    };

    let is_gmail_api = provider == "google" && auth_type == "oauth";
    let is_outlook_api = provider == "microsoft" && auth_type == "oauth";

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
        let att_tuples: Vec<(String, String, Vec<u8>)> = message.attachments
            .into_iter()
            .map(|a| (a.name, a.mime_type, a.data))
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
            )
            .await
            .map_err(|e| format!("Outlook send failed: {}", e))?;
        }
    } else {
        // Send the email via SMTP — returns the raw RFC822 bytes
        let message_bytes = smtp::send_mail(config, message)
            .await
            .map_err(|e| format!("Failed to send email: {}", e))?;

        let is_gmail_imap = imap_host.contains("gmail.com") || imap_host.contains("googlemail.com");

        // Append to Sent folder via IMAP (skip for Gmail which auto-saves sent mails).
        // The mail was already sent successfully via SMTP — if saving to Sent fails,
        // emit a non-blocking warning event so the user knows, but don't fail the send.
        if !is_gmail_imap {
            if let Some((sent_id, sent_path)) = sent_folder {
                let sent_save_result = match pool.get_session(&account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type).await {
                    Ok(mut session) => {
                        match imap::append_to_folder(&mut session, &sent_path, &message_bytes, &["\\Seen"]).await {
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
                log::warn!("send_mail: no Sent folder detected for account {} — sent copy not saved", account_id);
                let _ = app.emit("sent-folder-save-failed", serde_json::json!({
                    "account_id": account_id,
                    "error": "No 'Sent' folder was detected for this account, so the sent copy could not be saved.",
                }));
            }
        }
    }

    Ok(())
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
        let attachments: Vec<(String, String, Vec<u8>)> = decode_attachments(request.attachments.clone())?
            .into_iter()
            .map(|att| (smtp::attachment::repair_encoded_name(&att.name), att.mime_type, att.data))
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
        )
        .await
        .map_err(|e| format!("Outlook draft failed: {}", e))?;

        return Ok(None);
    }

    // Gmail and IMAP both need an RFC822 message
    let from_mailbox = if display_name.is_empty() {
        email.parse::<lettre::Address>()
            .map_err(|e| format!("Invalid email: {}", e))?
            .into()
    } else {
        lettre::message::Mailbox::new(Some(display_name), email.parse().map_err(|e| format!("Invalid email: {}", e))?)
    };

    let from_mailbox_clone = from_mailbox.clone();
    let mut message_builder = Message::builder()
        .from(from_mailbox)
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

    let attachments: Vec<(String, String, Vec<u8>)> = decode_attachments(request.attachments.clone())?
        .into_iter()
        .map(|att| (att.name, att.mime_type, att.data))
        .collect();

    let message = if attachments.is_empty() {
        if let Some(ref html) = request.body_html {
            message_builder
                .multipart(
                    MultiPart::alternative()
                        .singlepart(SinglePart::plain(request.body_text.clone()))
                        .singlepart(SinglePart::html(html.clone())),
                )
                .map_err(|e| format!("Failed to build message: {}", e))?
        } else {
            message_builder
                .body(request.body_text.clone())
                .map_err(|e| format!("Failed to build message: {}", e))?
        }
    } else {
        let body_part = if let Some(ref html) = request.body_html {
            MultiPart::alternative()
                .singlepart(SinglePart::plain(request.body_text.clone()))
                .singlepart(SinglePart::html(html.clone()))
        } else {
            MultiPart::alternative()
                .singlepart(SinglePart::plain(request.body_text.clone()))
        };

        let mut mixed = MultiPart::mixed().multipart(body_part);
        for (name, mime_type, data) in attachments {
            mixed = mixed.singlepart(smtp::attachment_part(&name, &mime_type, data));
        }

        message_builder
            .multipart(mixed)
            .map_err(|e| format!("Failed to build message: {}", e))?
    };

    let message_bytes = message.formatted();

    if is_gmail_api {
        // Gmail API: POST /me/drafts with base64url-encoded RFC822
        let client = crate::gmail::api::GmailClient::new(&credential);
        crate::gmail::messages::save_draft(&client, &message_bytes)
            .await
            .map_err(|e| format!("Gmail draft failed: {}", e))?;
        return Ok(None);
    }

    let mut session = pool.get_session(&request.account_id, &imap_host, imap_port as u16, &email, &credential, &auth_type)
        .await
        .map_err(|e| format!("Failed to get IMAP session: {}", e))?;

    match imap::append_to_folder(&mut session, &drafts_folder_path, &message_bytes, &["\\Draft", "\\Seen"]).await {
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

    let attachments_json = request.attachments
        .as_ref()
        .map(|atts| serde_json::to_string(atts).unwrap_or_default())
        .unwrap_or_default();

    conn.execute(
        "INSERT INTO drafts (id, account_id, subject, to_addresses, cc_addresses, bcc_addresses, body_text, body_html, in_reply_to, references_header, attachments_json, scheduled_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            id,
            request.account_id,
            request.subject,
            serde_json::to_string(&request.to).unwrap_or_default(),
            serde_json::to_string(&request.cc).unwrap_or_default(),
            serde_json::to_string(&request.bcc).unwrap_or_default(),
            request.body_text,
            request.body_html.unwrap_or_default(),
            request.in_reply_to.as_deref().unwrap_or(""),
            request.references.as_deref().unwrap_or(""),
            attachments_json,
            scheduled_at,
        ],
    ).map_err(|e| format!("Failed to schedule mail: {}", e))?;

    Ok(id)
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
    db: State<'_, Database>,
) -> Result<i32, String> {
    const MAX_RETRIES: i32 = 3;

    let due_drafts: Vec<(String, String, String, String, String, String, String, String, String, String, String, i32)> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, COALESCE(subject, ''), COALESCE(to_addresses, '[]'), \
             COALESCE(cc_addresses, '[]'), COALESCE(bcc_addresses, '[]'), COALESCE(body_text, ''), \
             COALESCE(body_html, ''), COALESCE(in_reply_to, ''), COALESCE(references_header, ''), \
             COALESCE(attachments_json, ''), retry_count \
             FROM drafts WHERE scheduled_at IS NOT NULL AND scheduled_at != '' \
             AND scheduled_at <= datetime('now') AND retry_count < ?1"
        ).map_err(|e| e.to_string())?;

        let rows: Vec<_> = stmt.query_map(rusqlite::params![MAX_RETRIES], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i32>(11)?,
            ))
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        rows
    };

    let count = due_drafts.len() as i32;
    if count == 0 {
        return Ok(0);
    }

    for (draft_id, account_id, subject, to_json, cc_json, bcc_json, body_text, body_html, in_reply_to, references_header, attachments_json, retry_count) in due_drafts {
        let to: Vec<String> = serde_json::from_str(&to_json).unwrap_or_default();
        let cc: Vec<String> = serde_json::from_str(&cc_json).unwrap_or_default();
        let bcc: Vec<String> = serde_json::from_str(&bcc_json).unwrap_or_default();
        let attachments: Option<Vec<crate::models::SendAttachment>> = if attachments_json.is_empty() {
            None
        } else {
            serde_json::from_str(&attachments_json).ok()
        };

        let request = SendMailRequest {
            account_id: account_id.clone(),
            to,
            cc,
            bcc,
            subject: subject.clone(),
            body_text,
            body_html: if body_html.is_empty() { None } else { Some(body_html) },
            in_reply_to: if in_reply_to.is_empty() { None } else { Some(in_reply_to) },
            references: if references_header.is_empty() { None } else { Some(references_header) },
            attachments,
        };

        let db_state: tauri::State<'_, Database> = app.state();
        let pool_state: tauri::State<'_, ImapPool> = app.state();
        match send_mail(app.clone(), db_state, pool_state, request).await {
            Ok(()) => {
                let db_ref = app.state::<Database>();
                let conn = db_ref.lock_db();
                let _ = conn.execute("DELETE FROM drafts WHERE id = ?1", rusqlite::params![draft_id]);
                log::info!("Scheduled mail sent: {} ({})", subject, draft_id);
                let _ = app.emit("scheduled-mail-sent", serde_json::json!({
                    "draft_id": draft_id,
                    "subject": subject,
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
