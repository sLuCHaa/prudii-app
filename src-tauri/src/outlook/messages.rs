//! Outlook message body fetching, attachment handling, send, and mail operations.

use crate::db::Database;
use crate::outlook::api::{
    GraphRecipient, GraphEmailAddress, OutlookClient,
    SendMailPayload, SendMessage, SendBody, SendAttachment, ReplyPayload,
};
use anyhow::Result;
use base64::Engine;

/// Parse a recipient string like "Name <email>" or plain "email" into a GraphRecipient.
fn parse_recipient(raw: &str) -> GraphRecipient {
    let trimmed = raw.trim();
    if let Some(lt) = trimmed.rfind('<') {
        if let Some(gt) = trimmed.rfind('>') {
            if gt > lt {
                let name = trimmed[..lt].trim();
                let addr = trimmed[lt + 1..gt].trim();
                return GraphRecipient {
                    email_address: GraphEmailAddress {
                        name: if name.is_empty() { None } else { Some(name.to_string()) },
                        address: Some(addr.to_string()),
                    },
                };
            }
        }
    }
    GraphRecipient {
        email_address: GraphEmailAddress {
            name: None,
            address: Some(trimmed.to_string()),
        },
    }
}

/// Re-resolve a mail's current Graph message ID via its internetMessageId.
/// Graph IDs are mutable — they change on every folder move — so a stored ID goes
/// stale when the message is moved (by another client, a rule, or Prudii itself).
/// On success updates mails.message_id and returns the fresh ID; returns None when
/// the message no longer exists on the server or no internetMessageId is stored.
pub async fn resolve_stale_graph_id(
    client: &OutlookClient,
    db: &Database,
    mail_id: &str,
) -> Result<Option<String>> {
    let internet_id: Option<String> = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT COALESCE(\"references\", '') FROM mails WHERE id = ?1",
            rusqlite::params![mail_id],
            |row| row.get(0),
        ).ok().filter(|s: &String| !s.is_empty())
    };
    let Some(internet_id) = internet_id else { return Ok(None) };

    let Some(found) = client.find_message_by_internet_id(&internet_id).await? else {
        return Ok(None);
    };

    {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE mails SET message_id = ?1 WHERE id = ?2",
            rusqlite::params![found.id, mail_id],
        );
    }
    log::info!("Outlook: re-resolved stale graph id for mail {} via internetMessageId", mail_id);
    Ok(Some(found.id))
}

/// Fetch the full body of an Outlook message and store it in the DB.
pub async fn fetch_message_body(
    client: &OutlookClient,
    graph_id: &str,
    mail_id: &str,
    db: &Database,
) -> Result<()> {
    // Graph message IDs are mutable — a 404 usually means the message was moved
    // (new ID assigned) after we stored the old one. Re-resolve and retry once.
    let (msg, resolved_id) = match client.get_message(graph_id).await {
        Ok(m) => (m, graph_id.to_string()),
        Err(e) if e.to_string().contains("(404") => {
            match resolve_stale_graph_id(client, db, mail_id).await? {
                Some(new_id) => {
                    let m = client.get_message(&new_id).await?;
                    (m, new_id)
                }
                None => return Err(e),
            }
        }
        Err(e) => return Err(e),
    };
    let graph_id = resolved_id.as_str();

    let mut body_text = String::new();
    let mut body_html = String::new();

    if let Some(ref body) = msg.body {
        let content = body.content.as_deref().unwrap_or("");
        let is_html = body.content_type.as_deref()
            .map(|ct| ct.eq_ignore_ascii_case("html"))
            .unwrap_or(false);
        if is_html {
            body_html = content.to_string();
            body_text = strip_html_tags(content);
        } else if !content.is_empty() {
            // Check if content looks like HTML even when contentType says "text"
            let trimmed = content.trim();
            if trimmed.starts_with('<') && trimmed.contains("</") {
                body_html = content.to_string();
                body_text = strip_html_tags(content);
            } else {
                body_text = content.to_string();
            }
        }
    }

    let snippet = msg.body_preview.as_deref().unwrap_or("");
    let has_attachments_from_body = msg.has_attachments.unwrap_or(false);

    log::info!(
        "fetch_message_body {}: text={} chars, html={} chars, has_attachments={}",
        graph_id, body_text.len(), body_html.len(), has_attachments_from_body
    );

    // Backfill empty metadata early (safe — doesn't set body_text/body_html which the
    // dedup mechanism polls for, so this won't cause premature cache hits)
    {
        let conn = db.lock_db();

        let subject = msg.subject.as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        let (from_name, from_email) = msg.from.as_ref()
            .map(|r| {
                let name = r.email_address.name.as_deref().unwrap_or("");
                let addr = r.email_address.address.as_deref().unwrap_or("");
                (name.to_string(), addr.to_string())
            })
            .unwrap_or_default();
        if !subject.is_empty() || !from_email.is_empty() {
            conn.execute(
                "UPDATE mails SET subject = CASE WHEN (subject = '' OR subject = '(No Subject)') AND ?1 != '' THEN ?1 ELSE subject END, \
                 from_name = CASE WHEN from_name = '' THEN ?2 ELSE from_name END, \
                 from_email = CASE WHEN from_email = '' THEN ?3 ELSE from_email END \
                 WHERE id = ?4",
                rusqlite::params![subject, from_name, from_email, mail_id],
            )?;
        }

        let to_json = crate::outlook::sync::recipients_to_json_pub(msg.to_recipients.as_deref().unwrap_or(&[]));
        let cc_json = crate::outlook::sync::recipients_to_json_pub(msg.cc_recipients.as_deref().unwrap_or(&[]));
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
    let mut has_real_attachments = has_attachments_from_body;
    if has_attachments_from_body {
        let attachments = client.list_attachments(graph_id).await?;

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
                let filename = sanitize_filename(att.name.as_deref().unwrap_or("attachment"));
                let data = if let Some(ref content_bytes) = att.content_bytes {
                    base64::engine::general_purpose::STANDARD
                        .decode(content_bytes)
                        .unwrap_or_default()
                } else {
                    continue;
                };

                if data.is_empty() {
                    continue;
                }

                downloaded.push(DownloadedAttachment {
                    filename,
                    mime_type: att.content_type.clone(),
                    data,
                    content_id: att.content_id.clone(),
                    // Only images with Content-ID are truly inline (embedded in HTML).
                    // Outlook Graph API marks PDFs and other files as isInline too.
                    is_inline: att.is_inline.unwrap_or(false)
                        && att.content_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false)
                        && att.content_id.is_some(),
                });
            }

            for att in &downloaded {
                let file_path = attach_dir.join(&att.filename);
                if let Err(e) = tokio::fs::write(&file_path, &att.data).await {
                    log::error!("Failed to write attachment '{}' for mail {}: {}", att.filename, mail_id, e);
                    continue;
                }

                let conn = db.lock_db();
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
                    if let Some(ref cid) = att.content_id {
                        let cid_clean = cid.trim_matches(|c| c == '<' || c == '>');
                        let local_url = format!("file:///{}", file_path.to_string_lossy().replace('\\', "/"));
                        body_html = body_html.replace(&format!("cid:{}", cid_clean), &local_url);
                    }
                }
            }

            has_real_attachments = downloaded.iter().any(|a| !a.is_inline);
        }
    }

    // Write body LAST — this is what the dedup mechanism polls for, so it must happen
    // after all attachments are saved to ensure they're available when the UI queries them.
    {
        let conn = db.lock_db();
        conn.execute(
            "UPDATE mails SET body_text = ?1, body_html = ?2, snippet = ?3, has_attachments = ?4 WHERE id = ?5",
            rusqlite::params![body_text, body_html, snippet, has_real_attachments as i32, mail_id],
        )?;

        let _ = conn.execute(
            "UPDATE mails_fts SET body_text = ?1 WHERE mail_id = ?2",
            rusqlite::params![body_text, mail_id],
        );
    }

    Ok(())
}

pub async fn send_mail(
    client: &OutlookClient,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body_text: &str,
    body_html: Option<&str>,
    attachments: &[(String, String, Vec<u8>)], // (name, mime_type, data)
) -> Result<()> {
    let to_recipients: Vec<GraphRecipient> = to.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let cc_recipients: Vec<GraphRecipient> = cc.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let bcc_recipients: Vec<GraphRecipient> = bcc.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let (content_type, content) = if let Some(html) = body_html {
        ("HTML".to_string(), html.to_string())
    } else {
        ("Text".to_string(), body_text.to_string())
    };

    let graph_attachments: Option<Vec<SendAttachment>> = if attachments.is_empty() {
        None
    } else {
        Some(attachments.iter().map(|(name, mime_type, data)| {
            SendAttachment {
                odata_type: "#microsoft.graph.fileAttachment".to_string(),
                name: name.clone(),
                content_type: mime_type.clone(),
                content_bytes: base64::engine::general_purpose::STANDARD.encode(data),
            }
        }).collect())
    };

    // Note: Graph API only allows custom x-headers in internetMessageHeaders.
    // Standard headers like In-Reply-To and References are rejected with 400.
    // Reply threading is handled automatically by Graph via conversationId.
    let headers = Vec::new();

    let payload = SendMailPayload {
        message: SendMessage {
            subject: subject.to_string(),
            body: SendBody { content_type, content },
            to_recipients,
            cc_recipients,
            bcc_recipients,
            attachments: graph_attachments,
            internet_message_headers: headers,
        },
        save_to_sent_items: true,
    };

    client.send_mail(&payload).await
}

/// Reply to an existing message via Microsoft Graph API.
/// Uses POST /me/messages/{id}/reply which handles threading automatically.
pub async fn reply_mail(
    client: &OutlookClient,
    original_graph_id: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body_text: &str,
    body_html: Option<&str>,
    attachments: &[(String, String, Vec<u8>)],
) -> Result<()> {
    let to_recipients: Vec<GraphRecipient> = to.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let cc_recipients: Vec<GraphRecipient> = cc.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let bcc_recipients: Vec<GraphRecipient> = bcc.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let (content_type, content) = if let Some(html) = body_html {
        ("HTML".to_string(), html.to_string())
    } else {
        ("Text".to_string(), body_text.to_string())
    };

    let graph_attachments: Option<Vec<SendAttachment>> = if attachments.is_empty() {
        None
    } else {
        Some(attachments.iter().map(|(name, mime_type, data)| {
            SendAttachment {
                odata_type: "#microsoft.graph.fileAttachment".to_string(),
                name: name.clone(),
                content_type: mime_type.clone(),
                content_bytes: base64::engine::general_purpose::STANDARD.encode(data),
            }
        }).collect())
    };

    let payload = ReplyPayload {
        message: SendMessage {
            subject: subject.to_string(),
            body: SendBody { content_type, content },
            to_recipients,
            cc_recipients,
            bcc_recipients,
            attachments: graph_attachments,
            internet_message_headers: Vec::new(),
        },
    };

    client.reply_mail(original_graph_id, &payload).await
}

pub async fn save_draft(
    client: &OutlookClient,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body_text: &str,
    body_html: Option<&str>,
    attachments: &[(String, String, Vec<u8>)], // (name, mime_type, data)
) -> Result<()> {
    let to_recipients: Vec<GraphRecipient> = to.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let cc_recipients: Vec<GraphRecipient> = cc.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let bcc_recipients: Vec<GraphRecipient> = bcc.iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| parse_recipient(a))
        .collect();

    let (content_type, content) = if let Some(html) = body_html {
        ("HTML".to_string(), html.to_string())
    } else {
        ("Text".to_string(), body_text.to_string())
    };

    let graph_attachments: Option<Vec<SendAttachment>> = if attachments.is_empty() {
        None
    } else {
        Some(attachments.iter().map(|(name, mime_type, data)| {
            SendAttachment {
                odata_type: "#microsoft.graph.fileAttachment".to_string(),
                name: name.clone(),
                content_type: mime_type.clone(),
                content_bytes: base64::engine::general_purpose::STANDARD.encode(data),
            }
        }).collect())
    };

    let message = SendMessage {
        subject: subject.to_string(),
        body: SendBody { content_type, content },
        to_recipients,
        cc_recipients,
        bcc_recipients,
        attachments: graph_attachments,
        internet_message_headers: Vec::new(),
    };

    client.create_draft(&message).await?;
    Ok(())
}

pub async fn toggle_star(client: &OutlookClient, graph_id: &str, currently_starred: bool) -> Result<()> {
    let flag_status = if currently_starred { "notFlagged" } else { "flagged" };
    let props = serde_json::json!({
        "flag": { "flagStatus": flag_status }
    });
    client.update_message(graph_id, &props).await
}

pub async fn toggle_read(client: &OutlookClient, graph_id: &str, currently_read: bool) -> Result<()> {
    let props = serde_json::json!({
        "isRead": !currently_read,
    });
    client.update_message(graph_id, &props).await
}

pub async fn mark_as_read(client: &OutlookClient, graph_id: &str) -> Result<()> {
    let props = serde_json::json!({
        "isRead": true,
    });
    client.update_message(graph_id, &props).await
}

/// Move a message. Returns the message's NEW Graph ID — Graph IDs are mutable and
/// change on every folder move, so callers must persist the returned ID or the
/// stored one goes stale (404 on the next body fetch or mail op).
pub async fn move_message(client: &OutlookClient, graph_id: &str, dest_folder_id: &str) -> Result<String> {
    let moved = client.move_message(graph_id, dest_folder_id).await?;
    Ok(moved.id)
}

/// Move a message to trash. Returns the message's new Graph ID (see move_message).
pub async fn trash_message(client: &OutlookClient, graph_id: &str, trash_folder_id: &str) -> Result<String> {
    move_message(client, graph_id, trash_folder_id).await
}

/// Move a message to the archive folder. Returns the message's new Graph ID (see move_message).
pub async fn archive_message(client: &OutlookClient, graph_id: &str, archive_folder_id: &str) -> Result<String> {
    move_message(client, graph_id, archive_folder_id).await
}

pub async fn delete_message(client: &OutlookClient, graph_id: &str) -> Result<()> {
    client.delete_message(graph_id).await
}

/// Strip HTML tags to extract plain text (simple implementation).
fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(c),
            _ => {}
        }
    }
    result
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
