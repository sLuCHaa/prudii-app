//! Gmail message body fetching, attachment handling, send, and label operations.

use crate::db::Database;
use crate::gmail::api::{self, GmailClient, GmailPayload};
use anyhow::Result;

/// Fetch the full body of a Gmail message and store it in the DB.
pub async fn fetch_message_body(
    client: &GmailClient,
    gmail_id: &str,
    mail_id: &str,
    db: &Database,
) -> Result<()> {
    let msg = client.get_message(gmail_id, "full").await?;

    let payload = msg.payload
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No payload in message {}", gmail_id))?;

    let mut body_text = String::new();
    let mut body_html = String::new();
    let mut attachments: Vec<AttachmentInfo> = Vec::new();

    extract_body_parts(payload, &mut body_text, &mut body_html, &mut attachments);

    log::info!(
        "fetch_message_body {}: text={} chars, html={} chars, attachments={}",
        gmail_id, body_text.len(), body_html.len(), attachments.len()
    );

    let has_attachments = !attachments.is_empty();
    let snippet = msg.snippet.as_deref().unwrap_or("");

    // Backfill empty metadata early (safe — doesn't set body_text/body_html which the
    // dedup mechanism polls for, so this won't cause premature cache hits)
    {
        let conn = db.lock_db();

        let subject = super::api::get_header(payload, "Subject").unwrap_or("");
        let from_raw = super::api::get_header(payload, "From").unwrap_or("");
        let (from_name, from_email) = super::sync::parse_address_public(from_raw);
        if !subject.is_empty() || !from_email.is_empty() {
            conn.execute(
                "UPDATE mails SET subject = CASE WHEN subject = '' THEN ?1 ELSE subject END, \
                 from_name = CASE WHEN from_name = '' THEN ?2 ELSE from_name END, \
                 from_email = CASE WHEN from_email = '' THEN ?3 ELSE from_email END \
                 WHERE id = ?4",
                rusqlite::params![subject, from_name, from_email, mail_id],
            )?;
        }

        let to_raw = super::api::get_header(payload, "To").unwrap_or("");
        let cc_raw = super::api::get_header(payload, "Cc").unwrap_or("");
        let to_json = super::sync::addresses_to_json_pub(to_raw);
        let cc_json = super::sync::addresses_to_json_pub(cc_raw);
        if to_json != "[]" || cc_json != "[]" {
            conn.execute(
                "UPDATE mails SET \
                 to_json = CASE WHEN to_json = '[]' AND ?1 != '[]' THEN ?1 ELSE to_json END, \
                 cc_json = CASE WHEN cc_json = '[]' AND ?2 != '[]' THEN ?2 ELSE cc_json END \
                 WHERE id = ?3",
                rusqlite::params![to_json, cc_json, mail_id],
            )?;
        }
    }

    // Download and save attachments BEFORE writing body to DB.
    // The dedup mechanism polls for non-empty body_text/body_html to detect completion,
    // so the body update must happen last to prevent premature cache hits while
    // attachments are still being downloaded.
    if !attachments.is_empty() {
        let data_dir = db.data_dir.clone();
        let attach_dir = data_dir.join("attachments").join(mail_id);
        tokio::fs::create_dir_all(&attach_dir).await?;

        struct DownloadedAttachment {
            filename: String,
            mime_type: Option<String>,
            data: Vec<u8>,
            content_id: Option<String>,
            is_inline: bool,
        }

        let mut downloaded: Vec<DownloadedAttachment> = Vec::new();

        for att in &attachments {
            let data = if let Some(ref inline_data) = att.data {
                match api::decode_base64url(inline_data) {
                    Ok(d) => d,
                    Err(e) => {
                        log::warn!("Failed to decode inline attachment '{}': {}", att.filename, e);
                        continue;
                    }
                }
            } else if let Some(ref att_id) = att.attachment_id {
                match client.get_attachment(gmail_id, att_id).await {
                    Ok(d) => d,
                    Err(e) => {
                        log::warn!("Failed to download attachment '{}': {}", att.filename, e);
                        continue;
                    }
                }
            } else {
                continue;
            };

            downloaded.push(DownloadedAttachment {
                filename: sanitize_filename(&att.filename),
                mime_type: att.mime_type.clone(),
                data,
                content_id: att.content_id.clone(),
                is_inline: att.is_inline,
            });
        }

        for att in &downloaded {
            let file_path = attach_dir.join(&att.filename);
            if let Err(e) = tokio::fs::write(&file_path, &att.data).await {
                log::error!("Failed to write attachment '{}' for mail {}: {}", att.filename, mail_id, e);
                continue;
            }

            let conn = db.lock_db();
            // Reuse existing ID if attachment already exists for this mail+filename (preserves UI references)
            let existing_id: Option<String> = conn.query_row(
                "SELECT id FROM attachments WHERE mail_id = ?1 AND filename = ?2",
                rusqlite::params![mail_id, att.filename],
                |row| row.get(0),
            ).ok();
            let att_db_id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if let Err(e) = conn.execute(
                "INSERT OR REPLACE INTO attachments (id, mail_id, filename, mime_type, size_bytes, content_id, is_inline, local_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    att_db_id, mail_id, att.filename, att.mime_type,
                    att.data.len() as i64, att.content_id,
                    att.is_inline as i32,
                    file_path.to_string_lossy().to_string(),
                ],
            ) {
                log::error!("Failed to insert attachment '{}' for mail {}: {}", att.filename, mail_id, e);
            }

            if att.is_inline {
                if let Some(ref cid) = &att.content_id {
                    let cid_clean = cid.trim_matches(|c| c == '<' || c == '>');
                    let local_url = format!("file:///{}", file_path.to_string_lossy().replace('\\', "/"));
                    body_html = body_html.replace(&format!("cid:{}", cid_clean), &local_url);
                }
            }
        }
    }

    // Write body LAST — this is what the dedup mechanism polls for, so it must happen
    // after all attachments are saved to ensure they're available when the UI queries them.
    {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE mails SET body_text = ?1, body_html = ?2, snippet = ?3, has_attachments = ?4 WHERE id = ?5",
            rusqlite::params![body_text, body_html, snippet, has_attachments as i32, mail_id],
        )?;

        let _ = conn.execute(
            "UPDATE mails_fts SET body_text = ?1 WHERE mail_id = ?2",
            rusqlite::params![body_text, mail_id],
        );
    }

    Ok(())
}

/// Send a message via Gmail API. Takes raw RFC 2822 bytes.
pub async fn send_message(client: &GmailClient, raw: &[u8]) -> Result<()> {
    client.send_message(raw).await?;
    Ok(())
}

/// Save a draft via Gmail API. Takes raw RFC 2822 bytes.
pub async fn save_draft(client: &GmailClient, raw: &[u8]) -> Result<()> {
    client.create_draft(raw).await
}

pub async fn toggle_star(client: &GmailClient, gmail_id: &str, currently_starred: bool) -> Result<()> {
    if currently_starred {
        client.modify_message(gmail_id, &[], &["STARRED"]).await
    } else {
        client.modify_message(gmail_id, &["STARRED"], &[]).await
    }
}

pub async fn toggle_read(client: &GmailClient, gmail_id: &str, currently_read: bool) -> Result<()> {
    if currently_read {
        // Mark as unread = add UNREAD label
        client.modify_message(gmail_id, &["UNREAD"], &[]).await
    } else {
        // Mark as read = remove UNREAD label
        client.modify_message(gmail_id, &[], &["UNREAD"]).await
    }
}

pub async fn mark_as_read(client: &GmailClient, gmail_id: &str) -> Result<()> {
    client.modify_message(gmail_id, &[], &["UNREAD"]).await
}

/// Batch mark multiple messages as read/unread in a single API call.
pub async fn batch_set_read(client: &GmailClient, gmail_ids: &[&str], is_read: bool) -> Result<()> {
    if is_read {
        client.batch_modify_messages(gmail_ids, &[], &["UNREAD"]).await
    } else {
        client.batch_modify_messages(gmail_ids, &["UNREAD"], &[]).await
    }
}

/// Batch star/unstar multiple messages in a single API call.
pub async fn batch_set_star(client: &GmailClient, gmail_ids: &[&str], starred: bool) -> Result<()> {
    if starred {
        client.batch_modify_messages(gmail_ids, &["STARRED"], &[]).await
    } else {
        client.batch_modify_messages(gmail_ids, &[], &["STARRED"]).await
    }
}

pub async fn trash_message(client: &GmailClient, gmail_id: &str) -> Result<()> {
    client.trash_message(gmail_id).await
}

pub async fn move_message(client: &GmailClient, gmail_id: &str, dest_label: &str, source_label: &str) -> Result<()> {
    client.modify_message(gmail_id, &[dest_label], &[source_label]).await
}

pub async fn archive_message(client: &GmailClient, gmail_id: &str) -> Result<()> {
    client.modify_message(gmail_id, &[], &["INBOX"]).await
}

pub async fn delete_message(client: &GmailClient, gmail_id: &str) -> Result<()> {
    client.delete_message(gmail_id).await
}

struct AttachmentInfo {
    filename: String,
    mime_type: Option<String>,
    _size: i64,
    attachment_id: Option<String>,
    data: Option<String>, // base64url-encoded inline data
    content_id: Option<String>,
    is_inline: bool,
}

/// Recursively extract text/html bodies and attachment info from a Gmail MIME payload.
fn extract_body_parts(
    payload: &GmailPayload,
    body_text: &mut String,
    body_html: &mut String,
    attachments: &mut Vec<AttachmentInfo>,
) {
    let mime = payload.mime_type.as_deref().unwrap_or("");
    let filename = payload.filename.as_deref().unwrap_or("");
    let has_data = payload.body.as_ref().and_then(|b| b.data.as_ref()).map(|d| d.len()).unwrap_or(0);
    let has_parts = payload.parts.as_ref().map(|p| p.len()).unwrap_or(0);
    log::debug!("extract_body_parts: mime={} filename='{}' data_len={} parts={}", mime, filename, has_data, has_parts);

    if !filename.is_empty() || payload.body.as_ref().and_then(|b| b.attachment_id.as_ref()).is_some() {
        let body = payload.body.as_ref();
        let content_id = api::get_header(payload, "Content-ID").map(|s| s.to_string());
        // Only images with Content-ID are truly inline (embedded in HTML).
        // Many clients mark PDFs and other files as Content-Disposition: inline.
        let is_image = mime.starts_with("image/");
        let is_inline = is_image && content_id.is_some();

        attachments.push(AttachmentInfo {
            filename: if filename.is_empty() { "attachment".to_string() } else { filename.to_string() },
            mime_type: Some(mime.to_string()),
            _size: body.and_then(|b| b.size).unwrap_or(0),
            attachment_id: body.and_then(|b| b.attachment_id.clone()),
            data: body.and_then(|b| b.data.clone()),
            content_id,
            is_inline,
        });
        return;
    }

    // Leaf node with body data
    if let Some(ref body) = payload.body {
        if let Some(data) = body.data.as_deref() {
            if !data.is_empty() {
                match api::decode_base64url(data) {
                    Ok(decoded) => {
                        match String::from_utf8(decoded) {
                            Ok(text) => {
                                if mime == "text/plain" && body_text.is_empty() {
                                    log::debug!("extract_body_parts: found text/plain ({} chars)", text.len());
                                    *body_text = text;
                                } else if mime == "text/html" && body_html.is_empty() {
                                    log::debug!("extract_body_parts: found text/html ({} chars)", text.len());
                                    *body_html = text;
                                }
                            }
                            Err(e) => log::warn!("extract_body_parts: UTF-8 decode failed for {}: {}", mime, e),
                        }
                    }
                    Err(e) => log::warn!("extract_body_parts: base64url decode failed for {} ({} bytes): {}", mime, data.len(), e),
                }
            }
        }
    }

    if let Some(ref parts) = payload.parts {
        for part in parts {
            extract_body_parts(part, body_text, body_html, attachments);
        }
    }
}

fn sanitize_filename(name: &str) -> String {
    let clean: String = name.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    if clean.is_empty() {
        "attachment".to_string()
    } else {
        clean
    }
}
