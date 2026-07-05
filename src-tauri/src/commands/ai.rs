use crate::ai::OllamaClient;
use crate::ai::prompts;
use crate::db::Database;
use crate::models::AttachmentWithContext;
use super::sync::sanitize_fts_query;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaStatus {
    pub connected: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiStreamEvent {
    pub request_id: String,
    pub chunk: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    pub request_id: String,
    pub cached_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplySuggestion {
    pub tone: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiRepliesEvent {
    pub request_id: String,
    pub replies: Vec<ReplySuggestion>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSearchResultEvent {
    pub request_id: String,
    pub attachments: Vec<AttachmentWithContext>,
    pub parsed_query: String,
    pub error: Option<String>,
}

fn get_ai_settings(db: &Database) -> Result<(bool, String, String), String> {
    let conn = db.lock_db();

    fn get_bool(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true" || v == "1")
        .unwrap_or(default)
    }

    fn get_string(conn: &rusqlite::Connection, key: &str, default: &str) -> String {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| default.to_string())
    }

    let enabled = get_bool(&conn, "ai_enabled", false);
    let url = get_string(&conn, "ollama_url", "http://localhost:11434");
    let model = get_string(&conn, "ai_model", "");

    // Validate Ollama URL — only allow localhost to prevent SSRF
    if let Ok(parsed) = reqwest::Url::parse(&url) {
        match parsed.host_str() {
            Some("localhost") | Some("127.0.0.1") | Some("::1") => {}
            _ => return Err("Ollama URL must point to localhost (127.0.0.1 or localhost)".into()),
        }
    }

    Ok((enabled, url, model))
}

fn get_mail_text(db: &Database, mail_id: &str) -> Result<(String, String, String), String> {
    let conn = db.lock_db();
    conn.query_row(
        "SELECT subject, body_text, account_id FROM mails WHERE id = ?1",
        rusqlite::params![mail_id],
        |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, String>(1).unwrap_or_default(),
                row.get::<_, String>(2).unwrap_or_default(),
            ))
        },
    )
    .map_err(|e| format!("Mail not found: {}", e))
}

fn get_cached(db: &Database, mail_id: &str, cache_type: &str) -> Option<String> {
    let conn = db.lock_db();
    conn.query_row(
        "SELECT result FROM ai_cache WHERE mail_id = ?1 AND cache_type = ?2",
        rusqlite::params![mail_id, cache_type],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn set_cached(db: &Database, mail_id: &str, cache_type: &str, result: &str, model: &str) {
    let conn = db.lock_db();
    let id = Uuid::new_v4().to_string();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO ai_cache (id, mail_id, cache_type, result, model)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, mail_id, cache_type, result, model],
    );
}

#[tauri::command]
pub async fn check_ollama_status(db: State<'_, Database>) -> Result<OllamaStatus, String> {
    let (_, url, _) = get_ai_settings(&db)?;
    let client = OllamaClient::new(&url);
    let status = client.check_status().await;
    Ok(OllamaStatus {
        connected: status.connected,
        models: status.models,
        error: status.error,
    })
}

#[tauri::command]
pub async fn summarize_mail(
    app: AppHandle,
    db: State<'_, Database>,
    mail_id: String,
) -> Result<AiResponse, String> {
    let (enabled, url, model) = get_ai_settings(&db)?;
    if !enabled {
        return Err("AI is disabled".to_string());
    }
    if model.is_empty() {
        return Err("No AI model selected".to_string());
    }

    let request_id = Uuid::new_v4().to_string();

    // Check cache first — return directly to avoid event race condition
    if let Some(cached) = get_cached(&db, &mail_id, "summary") {
        return Ok(AiResponse {
            request_id,
            cached_text: Some(cached),
        });
    }

    let (subject, body_text, account_id) = get_mail_text(&db, &mail_id)?;
    let rid = request_id.clone();

    let db_clone_mail_id = mail_id.clone();
    let model_clone = model.clone();

    crate::task_registry::spawn_for_account(&account_id, async move {
        let client = OllamaClient::new(&url);
        let prompt = prompts::summarize_mail(&subject, &body_text);

        let app_ref = &app;
        let rid_ref = &rid;

        match client
            .generate_stream(&model, &prompt, |chunk, done| {
                let _ = app_ref.emit(
                    "ai-stream",
                    AiStreamEvent {
                        request_id: rid_ref.clone(),
                        chunk: chunk.to_string(),
                        done,
                        error: None,
                    },
                );
            })
            .await
        {
            Ok(full_text) => {
                let db: tauri::State<'_, Database> = app.state();
                set_cached(&db, &db_clone_mail_id, "summary", &full_text, &model_clone);
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-stream",
                    AiStreamEvent {
                        request_id: rid.clone(),
                        chunk: String::new(),
                        done: true,
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(AiResponse {
        request_id,
        cached_text: None,
    })
}

#[tauri::command]
pub async fn summarize_thread(
    app: AppHandle,
    db: State<'_, Database>,
    mail_id: String,
) -> Result<AiResponse, String> {
    let (enabled, url, model) = get_ai_settings(&db)?;
    if !enabled {
        return Err("AI is disabled".to_string());
    }
    if model.is_empty() {
        return Err("No AI model selected".to_string());
    }

    let request_id = Uuid::new_v4().to_string();

    // Check cache — return directly to avoid event race condition
    if let Some(cached) = get_cached(&db, &mail_id, "thread_summary") {
        return Ok(AiResponse {
            request_id,
            cached_text: Some(cached),
        });
    }

    let thread_texts = {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare(
                "SELECT from_name, from_email, body_text FROM mails
                 WHERE thread_id = (SELECT thread_id FROM mails WHERE id = ?1)
                    OR id = ?1
                 ORDER BY date ASC
                 LIMIT 20",
            )
            .map_err(|e| e.to_string())?;

        let rows: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![mail_id], |row| {
                let name: String = row.get(0).unwrap_or_default();
                let email: String = row.get(1).unwrap_or_default();
                let body: String = row.get(2).unwrap_or_default();
                let sender = if name.is_empty() { email } else { name };
                Ok((sender, body))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    if thread_texts.is_empty() {
        return Err("No thread mails found".to_string());
    }

    // Fetch account_id so the spawn can be routed through task_registry
    // and cancelled if the account is deleted mid-stream.
    let (_subject, _body_text, account_id) = get_mail_text(&db, &mail_id)?;

    let rid = request_id.clone();
    let db_clone_mail_id = mail_id.clone();
    let model_clone = model.clone();

    crate::task_registry::spawn_for_account(&account_id, async move {
        let client = OllamaClient::new(&url);
        let prompt = prompts::summarize_thread(&thread_texts);

        let app_ref = &app;
        let rid_ref = &rid;

        match client
            .generate_stream(&model, &prompt, |chunk, done| {
                let _ = app_ref.emit(
                    "ai-stream",
                    AiStreamEvent {
                        request_id: rid_ref.clone(),
                        chunk: chunk.to_string(),
                        done,
                        error: None,
                    },
                );
            })
            .await
        {
            Ok(full_text) => {
                let db: tauri::State<'_, Database> = app.state();
                set_cached(&db, &db_clone_mail_id, "thread_summary", &full_text, &model_clone);
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-stream",
                    AiStreamEvent {
                        request_id: rid.clone(),
                        chunk: String::new(),
                        done: true,
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(AiResponse {
        request_id,
        cached_text: None,
    })
}

#[tauri::command]
pub async fn suggest_replies(
    app: AppHandle,
    db: State<'_, Database>,
    mail_id: String,
) -> Result<AiResponse, String> {
    let (enabled, url, model) = get_ai_settings(&db)?;
    if !enabled {
        return Err("AI is disabled".to_string());
    }
    if model.is_empty() {
        return Err("No AI model selected".to_string());
    }

    let request_id = Uuid::new_v4().to_string();

    // Check cache — return directly to avoid event race condition
    if let Some(cached) = get_cached(&db, &mail_id, "replies") {
        return Ok(AiResponse {
            request_id,
            cached_text: Some(cached),
        });
    }

    let (subject, body_text, account_id) = get_mail_text(&db, &mail_id)?;

    let language = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = 'language'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "en".to_string())
    };

    let rid = request_id.clone();
    let db_clone_mail_id = mail_id.clone();
    let model_clone = model.clone();

    crate::task_registry::spawn_for_account(&account_id, async move {
        let client = OllamaClient::new(&url);
        let prompt = prompts::suggest_replies(&subject, &body_text, &language);

        // For replies we don't stream token-by-token, we collect the full response
        let mut full_text = String::new();
        match client
            .generate_stream(&model, &prompt, |chunk, _done| {
                full_text.push_str(chunk);
            })
            .await
        {
            Ok(response) => {
                // Use the returned full response (our closure also builds it but the return value is authoritative)
                let text = if response.is_empty() { &full_text } else { &response };

                let json_text = extract_json_array(text);

                match serde_json::from_str::<Vec<ReplySuggestion>>(&json_text) {
                    Ok(replies) => {
                        let db: tauri::State<'_, Database> = app.state();
                        set_cached(&db, &db_clone_mail_id, "replies", &json_text, &model_clone);

                        let _ = app.emit(
                            "ai-replies",
                            AiRepliesEvent {
                                request_id: rid.clone(),
                                replies,
                                error: None,
                            },
                        );
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "ai-replies",
                            AiRepliesEvent {
                                request_id: rid.clone(),
                                replies: vec![],
                                error: Some(format!("Failed to parse AI response: {}", e)),
                            },
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-replies",
                    AiRepliesEvent {
                        request_id: rid.clone(),
                        replies: vec![],
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(AiResponse {
        request_id,
        cached_text: None,
    })
}

#[tauri::command]
pub async fn suggest_thread_replies(
    app: AppHandle,
    db: State<'_, Database>,
    mail_id: String,
) -> Result<AiResponse, String> {
    let (enabled, url, model) = get_ai_settings(&db)?;
    if !enabled {
        return Err("AI is disabled".to_string());
    }
    if model.is_empty() {
        return Err("No AI model selected".to_string());
    }

    let request_id = Uuid::new_v4().to_string();

    if let Some(cached) = get_cached(&db, &mail_id, "thread_replies") {
        return Ok(AiResponse {
            request_id,
            cached_text: Some(cached),
        });
    }

    let (subject, _, account_id) = get_mail_text(&db, &mail_id)?;

    let thread_texts = {
        let conn = db.lock_db();
        let mut stmt = conn
            .prepare(
                "SELECT from_name, from_email, body_text FROM mails
                 WHERE thread_id = (SELECT thread_id FROM mails WHERE id = ?1)
                    OR id = ?1
                 ORDER BY date ASC
                 LIMIT 20",
            )
            .map_err(|e| e.to_string())?;

        let rows: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![mail_id], |row| {
                let name: String = row.get(0).unwrap_or_default();
                let email: String = row.get(1).unwrap_or_default();
                let body: String = row.get(2).unwrap_or_default();
                let sender = if name.is_empty() { email } else { name };
                Ok((sender, body))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    if thread_texts.is_empty() {
        return Err("No thread mails found".to_string());
    }

    let language = {
        let conn = db.lock_db();
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = 'language'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "en".to_string())
    };

    let rid = request_id.clone();
    let db_clone_mail_id = mail_id.clone();
    let model_clone = model.clone();

    crate::task_registry::spawn_for_account(&account_id, async move {
        let client = OllamaClient::new(&url);
        let prompt = prompts::suggest_thread_replies(&subject, &thread_texts, &language);

        let mut full_text = String::new();
        match client
            .generate_stream(&model, &prompt, |chunk, _done| {
                full_text.push_str(chunk);
            })
            .await
        {
            Ok(response) => {
                let text = if response.is_empty() { &full_text } else { &response };
                let json_text = extract_json_array(text);

                match serde_json::from_str::<Vec<ReplySuggestion>>(&json_text) {
                    Ok(replies) => {
                        let db: tauri::State<'_, Database> = app.state();
                        set_cached(&db, &db_clone_mail_id, "thread_replies", &json_text, &model_clone);

                        let _ = app.emit(
                            "ai-replies",
                            AiRepliesEvent {
                                request_id: rid.clone(),
                                replies,
                                error: None,
                            },
                        );
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "ai-replies",
                            AiRepliesEvent {
                                request_id: rid.clone(),
                                replies: vec![],
                                error: Some(format!("Failed to parse AI response: {}", e)),
                            },
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-replies",
                    AiRepliesEvent {
                        request_id: rid.clone(),
                        replies: vec![],
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(AiResponse {
        request_id,
        cached_text: None,
    })
}

/// Extract a JSON array from text that might have surrounding prose
fn extract_json_array(text: &str) -> String {
    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            if end > start {
                return text[start..=end].to_string();
            }
        }
    }
    text.to_string()
}

#[tauri::command]
pub fn clear_ai_cache(
    db: State<'_, Database>,
    mail_id: Option<String>,
) -> Result<(), String> {
    let conn = db.lock_db();
    match mail_id {
        Some(id) => {
            conn.execute("DELETE FROM ai_cache WHERE mail_id = ?1", rusqlite::params![id])
                .map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM ai_cache", [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Extract a JSON object from text that might have surrounding prose
fn extract_json_object(text: &str) -> String {
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if end > start {
                return text[start..=end].to_string();
            }
        }
    }
    text.to_string()
}

#[derive(Debug, Deserialize)]
struct ParsedAttachmentQuery {
    #[serde(default)]
    keywords: String,
    #[serde(default)]
    file_extensions: Vec<String>,
    #[serde(default)]
    exclude_extensions: Vec<String>,
}

/// Build a human-readable summary of the parsed query
fn build_parsed_summary(parsed: &ParsedAttachmentQuery) -> String {
    let mut parts = Vec::new();
    if !parsed.keywords.is_empty() {
        parts.push(parsed.keywords.clone());
    }
    if !parsed.file_extensions.is_empty() {
        let exts: Vec<String> = parsed.file_extensions.iter().map(|e| e.to_uppercase()).collect();
        parts.push(format!("({})", exts.join(", ")));
    }
    if parts.is_empty() {
        "All attachments".to_string()
    } else {
        parts.join(" ")
    }
}

fn run_attachment_search(
    db: &Database,
    keywords: &str,
    account_ids: Option<Vec<String>>,
    file_extensions: Option<Vec<String>>,
    exclude_extensions: Option<Vec<String>>,
) -> Result<Vec<AttachmentWithContext>, String> {
    let conn = db.lock_db();

    let safe_query = sanitize_fts_query(keywords);
    let has_query = !safe_query.is_empty();

    let mut conditions = vec!["a.is_inline = 0".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref aids) = account_ids {
        let filtered: Vec<&String> = aids.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            let placeholders: Vec<String> = filtered.iter().map(|_| {
                let p = format!("?{}", param_idx);
                param_idx += 1;
                p
            }).collect();
            conditions.push(format!("m.account_id IN ({})", placeholders.join(", ")));
            for aid in filtered {
                params.push(Box::new(aid.clone()));
            }
        }
    }

    if let Some(ref exts) = file_extensions {
        let filtered: Vec<&String> = exts.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            let like_clauses: Vec<String> = filtered.iter().map(|_| {
                let p = format!("LOWER(a.filename) LIKE ?{}", param_idx);
                param_idx += 1;
                p
            }).collect();
            conditions.push(format!("({})", like_clauses.join(" OR ")));
            for ext in filtered {
                params.push(Box::new(format!("%.{}", ext.to_lowercase())));
            }
        }
    }

    if let Some(ref exts) = exclude_extensions {
        let filtered: Vec<&String> = exts.iter().filter(|s| !s.is_empty()).collect();
        if !filtered.is_empty() {
            for ext in filtered {
                conditions.push(format!("LOWER(a.filename) NOT LIKE ?{}", param_idx));
                params.push(Box::new(format!("%.{}", ext.to_lowercase())));
                param_idx += 1;
            }
        }
    }

    let where_clause = conditions.join(" AND ");

    let sql = if has_query {
        let fts_param = param_idx;
        params.push(Box::new(safe_query.clone()));
        param_idx += 1;
        let like_param = param_idx;
        params.push(Box::new(format!("%{}%", keywords.trim())));
        param_idx += 1;
        let lim_param = param_idx;
        params.push(Box::new(200u32));

        format!(
            "SELECT DISTINCT a.id, a.mail_id, a.filename, a.mime_type, a.size_bytes, a.local_path,
                    m.subject, m.from_name, m.from_email, m.date, m.folder_id,
                    COALESCE(f.name, '') as folder_name, m.account_id
             FROM attachments a
             JOIN mails m ON m.id = a.mail_id
             LEFT JOIN folders f ON f.id = m.folder_id
             WHERE {where_clause}
               AND (a.mail_id IN (SELECT mail_id FROM mails_fts WHERE mails_fts MATCH ?{fts_param})
                    OR a.filename LIKE ?{like_param})
             ORDER BY m.date DESC
             LIMIT ?{lim_param}"
        )
    } else {
        let lim_param = param_idx;
        params.push(Box::new(200u32));

        format!(
            "SELECT a.id, a.mail_id, a.filename, a.mime_type, a.size_bytes, a.local_path,
                    m.subject, m.from_name, m.from_email, m.date, m.folder_id,
                    COALESCE(f.name, '') as folder_name, m.account_id
             FROM attachments a
             JOIN mails m ON m.id = a.mail_id
             LEFT JOIN folders f ON f.id = m.folder_id
             WHERE {where_clause}
             ORDER BY m.date DESC
             LIMIT ?{lim_param}"
        )
    };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let results = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(AttachmentWithContext {
                id: row.get(0)?,
                mail_id: row.get(1)?,
                filename: row.get(2)?,
                mime_type: row.get(3)?,
                size_bytes: row.get(4)?,
                local_path: row.get(5)?,
                mail_subject: row.get(6)?,
                mail_from_name: row.get(7)?,
                mail_from_email: row.get(8)?,
                mail_date: row.get(9)?,
                mail_folder_id: row.get(10)?,
                folder_name: row.get(11)?,
                account_id: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(results)
}

#[tauri::command]
pub async fn ai_search_attachments(
    app: AppHandle,
    db: State<'_, Database>,
    query: String,
    account_id: Option<String>,
) -> Result<AiResponse, String> {
    let (enabled, url, model) = get_ai_settings(&db)?;
    if !enabled {
        return Err("AI is disabled".to_string());
    }
    if model.is_empty() {
        return Err("No AI model selected".to_string());
    }

    let request_id = Uuid::new_v4().to_string();
    let rid = request_id.clone();

    tauri::async_runtime::spawn(async move {
        let client = OllamaClient::new(&url);
        let prompt = prompts::parse_attachment_query(&query);

        let mut full_text = String::new();
        match client
            .generate_stream(&model, &prompt, |chunk, _done| {
                full_text.push_str(chunk);
            })
            .await
        {
            Ok(response) => {
                let text = if response.is_empty() { &full_text } else { &response };
                let json_text = extract_json_object(text);

                match serde_json::from_str::<ParsedAttachmentQuery>(&json_text) {
                    Ok(parsed) => {
                        let summary = build_parsed_summary(&parsed);
                        let account_ids = account_id.map(|id| vec![id]);
                        let file_exts = if parsed.file_extensions.is_empty() { None } else { Some(parsed.file_extensions) };
                        let exclude_exts = if parsed.exclude_extensions.is_empty() { None } else { Some(parsed.exclude_extensions) };

                        let db: tauri::State<'_, Database> = app.state();
                        match run_attachment_search(&db, &parsed.keywords, account_ids, file_exts, exclude_exts) {
                            Ok(attachments) => {
                                let _ = app.emit(
                                    "ai-search-result",
                                    AiSearchResultEvent {
                                        request_id: rid.clone(),
                                        attachments,
                                        parsed_query: summary,
                                        error: None,
                                    },
                                );
                            }
                            Err(e) => {
                                let _ = app.emit(
                                    "ai-search-result",
                                    AiSearchResultEvent {
                                        request_id: rid.clone(),
                                        attachments: vec![],
                                        parsed_query: String::new(),
                                        error: Some(format!("Search failed: {}", e)),
                                    },
                                );
                            }
                        }
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "ai-search-result",
                            AiSearchResultEvent {
                                request_id: rid.clone(),
                                attachments: vec![],
                                parsed_query: String::new(),
                                error: Some(format!("Failed to parse AI response: {}", e)),
                            },
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-search-result",
                    AiSearchResultEvent {
                        request_id: rid.clone(),
                        attachments: vec![],
                        parsed_query: String::new(),
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(AiResponse {
        request_id,
        cached_text: None,
    })
}
