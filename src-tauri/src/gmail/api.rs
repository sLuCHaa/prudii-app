//! Gmail REST API HTTP client.
//! Stateless HTTP calls — no persistent connections or pools needed.

use anyhow::{bail, Context, Result};
use serde::Deserialize;

const BASE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// Lightweight Gmail API client wrapping a reqwest client + access token.
pub struct GmailClient {
    http: reqwest::Client,
    token: String,
}

static SHARED_HTTP: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("failed to build Gmail HTTP client")
});

static DOWNLOAD_HTTP: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("failed to build download client")
});

impl GmailClient {
    pub fn new(access_token: &str) -> Self {
        Self {
            http: SHARED_HTTP.clone(),
            token: access_token.to_string(),
        }
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub async fn list_labels(&self) -> Result<Vec<GmailLabel>> {
        let resp = self.http
            .get(format!("{}/labels", BASE_URL))
            .header("Authorization", self.auth_header())
            .send()
            .await
            .context("list_labels request failed")?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            bail!("list_labels failed ({}): {}", status, body);
        }

        let result: LabelsResponse = resp.json().await.context("list_labels parse failed")?;
        Ok(result.labels.unwrap_or_default())
    }

    /// Create a new user label. Returns the label ID.
    /// POST /gmail/v1/users/me/labels { name: name, labelListVisibility: "labelShow", messageListVisibility: "show" }
    pub async fn create_label(&self, name: &str) -> Result<GmailLabel> {
        let url = format!("{}/labels", BASE_URL);
        let body = serde_json::json!({
            "name": name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show"
        });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(&body)
                .send()
                .await
                .context("create_label request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("create_label parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("create_label: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("create_label failed ({}): {}", status, body);
        }
    }

    /// Delete a user label by its label ID.
    /// DELETE /gmail/v1/users/me/labels/{label_id}
    pub async fn delete_label(&self, label_id: &str) -> Result<()> {
        let url = format!("{}/labels/{}", BASE_URL, label_id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .delete(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("delete_label request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("delete_label {}: {} on attempt {}, retrying in {:?}", label_id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("delete_label {} failed ({}): {}", label_id, status, body);
        }
    }

    /// Rename a user label by its label ID.
    /// PATCH /gmail/v1/users/me/labels/{label_id} { name: new_name }
    pub async fn rename_label(&self, label_id: &str, new_name: &str) -> Result<()> {
        let url = format!("{}/labels/{}", BASE_URL, label_id);
        let body = serde_json::json!({ "name": new_name });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .patch(&url)
                .header("Authorization", self.auth_header())
                .json(&body)
                .send()
                .await
                .context("rename_label request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("rename_label {}: {} on attempt {}, retrying in {:?}", label_id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("rename_label {} failed ({}): {}", label_id, status, body);
        }
    }

    /// List message IDs in a label (paginated).
    /// Pass empty string for label_id to list ALL messages (for All Mail).
    pub async fn list_messages(&self, label_id: &str, page_token: Option<&str>, max_results: u32) -> Result<MessageListResponse> {
        let mut url = if label_id.is_empty() {
            format!("{}/messages?maxResults={}", BASE_URL, max_results)
        } else {
            format!("{}/messages?labelIds={}&maxResults={}", BASE_URL, label_id, max_results)
        };
        if let Some(token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("list_messages request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("list_messages parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("list_messages: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("list_messages failed ({}): {}", status, body);
        }
    }

    fn is_retryable(status: reqwest::StatusCode) -> bool {
        status.as_u16() == 429 || status.is_server_error()
    }

    /// Get a single message. format = "metadata", "full", or "minimal".
    pub async fn get_message(&self, id: &str, format: &str) -> Result<GmailMessage> {
        let url = format!("{}/messages/{}?format={}", BASE_URL, id, format);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("get_message request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("get_message parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("get_message {}: {} on attempt {}, retrying in {:?}", id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("get_message {} failed ({}): {}", id, status, body);
        }
    }

    /// Batch-get up to 50 messages in a single HTTP request.
    /// Uses Gmail's batch endpoint with multipart/mixed.
    /// Returns (messages, rate_limited_count) so callers can adapt their pacing.
    pub async fn batch_get_messages(&self, ids: &[&str], format: &str) -> Result<BatchResult> {
        if ids.is_empty() {
            return Ok(BatchResult { messages: Vec::new(), rate_limited: 0 });
        }
        if ids.len() > 50 {
            bail!("batch_get_messages: max 50 per batch, got {}", ids.len());
        }

        let boundary = "batch_prudii_gmail";
        let mut body = String::new();
        for id in ids {
            body.push_str(&format!("--{}\r\n", boundary));
            body.push_str("Content-Type: application/http\r\n");
            body.push_str("Content-ID: <item>\r\n\r\n");
            body.push_str(&format!("GET /gmail/v1/users/me/messages/{}?format={}\r\n\r\n", id, format));
        }
        body.push_str(&format!("--{}--\r\n", boundary));

        let mut attempt = 0u32;
        let (content_type, resp_body) = loop {
            let resp = self.http
                .post("https://www.googleapis.com/batch/gmail/v1")
                .header("Authorization", self.auth_header())
                .header("Content-Type", format!("multipart/mixed; boundary={}", boundary))
                .body(body.clone())
                .send()
                .await
                .context("batch_get_messages request failed")?;

            let status = resp.status();
            if status.is_success() {
                let ct = resp.headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let rb = resp.text().await.context("batch_get_messages body read failed")?;
                break (ct, rb);
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("batch_get_messages: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body_text = resp.text().await.unwrap_or_default();
            bail!("batch_get_messages failed ({}): {}", status, body_text);
        };

        parse_batch_response(&content_type, &resp_body)
    }

    pub async fn get_attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
        let url = format!("{}/messages/{}/attachments/{}", BASE_URL, message_id, attachment_id);

        let mut attempt = 0u32;
        loop {
            let resp = DOWNLOAD_HTTP
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("get_attachment request failed")?;

            let status = resp.status();
            if status.is_success() {
                let att: AttachmentResponse = resp.json().await.context("get_attachment parse failed")?;
                return decode_base64url(&att.data.unwrap_or_default());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("get_attachment: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("get_attachment failed ({}): {}", status, body);
        }
    }

    pub async fn list_history(&self, start_history_id: &str, page_token: Option<&str>) -> Result<GmailHistoryResponse> {
        let mut url = format!(
            "{}/history?startHistoryId={}&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved",
            BASE_URL, start_history_id
        );
        if let Some(token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("list_history request failed")?;

            let status = resp.status();
            if status.as_u16() == 404 {
                bail!("history_expired");
            }
            if status.is_success() {
                return resp.json().await.context("list_history parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("list_history: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("list_history failed ({}): {}", status, body);
        }
    }

    pub async fn modify_message(&self, id: &str, add_labels: &[&str], remove_labels: &[&str]) -> Result<()> {
        let url = format!("{}/messages/{}/modify", BASE_URL, id);

        let payload = serde_json::json!({
            "addLabelIds": add_labels,
            "removeLabelIds": remove_labels,
        });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(&payload)
                .send()
                .await
                .context("modify_message request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("modify_message {}: {} on attempt {}, retrying in {:?}", id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("modify_message {} failed ({}): {}", id, status, body);
        }
    }

    /// Batch modify labels on multiple messages at once (single API call).
    /// Gmail API: POST /messages/batchModify
    pub async fn batch_modify_messages(&self, ids: &[&str], add_labels: &[&str], remove_labels: &[&str]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let url = format!("{}/messages/batchModify", BASE_URL);
        let payload = serde_json::json!({
            "ids": ids,
            "addLabelIds": add_labels,
            "removeLabelIds": remove_labels,
        });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(&payload)
                .send()
                .await
                .context("batch_modify_messages request failed")?;

            let status = resp.status();
            if status.is_success() {
                log::info!("batch_modify_messages: {} messages updated", ids.len());
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("batch_modify_messages: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("batch_modify_messages failed ({}): {}", status, body);
        }
    }

    pub async fn trash_message(&self, id: &str) -> Result<()> {
        let url = format!("{}/messages/{}/trash", BASE_URL, id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .header("Content-Length", "0")
                .send()
                .await
                .context("trash_message request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("trash_message {}: {} on attempt {}, retrying in {:?}", id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("trash_message {} failed ({}): {}", id, status, body);
        }
    }

    pub async fn delete_message(&self, id: &str) -> Result<()> {
        let url = format!("{}/messages/{}", BASE_URL, id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .delete(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("delete_message request failed")?;

            let status = resp.status();
            // 404 = the item is already gone on the server, which is exactly the
            // goal of a delete. Treat it as success so we don't pointlessly retry.
            if status.is_success() || status.as_u16() == 404 {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("delete_message {}: {} on attempt {}, retrying in {:?}", id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("delete_message {} failed ({}): {}", id, status, body);
        }
    }

    /// Create a draft via Gmail API. `raw` = RFC 2822 bytes.
    pub async fn create_draft(&self, raw: &[u8]) -> Result<()> {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);

        let payload = serde_json::json!({
            "message": { "raw": encoded }
        });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(format!("{}/drafts", BASE_URL))
                .header("Authorization", self.auth_header())
                .json(&payload)
                .send()
                .await
                .context("create_draft request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("create_draft: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("create_draft failed ({}): {}", status, body);
        }
    }

    /// Send a message via Gmail API. `raw` = RFC 2822 bytes.
    pub async fn send_message(&self, raw: &[u8]) -> Result<GmailMessage> {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);

        let payload = serde_json::json!({ "raw": encoded });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(format!("{}/messages/send", BASE_URL))
                .header("Authorization", self.auth_header())
                .json(&payload)
                .send()
                .await
                .context("send_message request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("send_message parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("send_message: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("send_message failed ({}): {}", status, body);
        }
    }
}

#[derive(Debug, Deserialize)]
struct LabelsResponse {
    labels: Option<Vec<GmailLabel>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub label_type: Option<String>,
    pub messages_total: Option<u32>,
    pub messages_unread: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageListResponse {
    pub messages: Option<Vec<MessageRef>>,
    pub next_page_token: Option<String>,
    pub result_size_estimate: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct MessageRef {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub thread_id: Option<String>,
    pub label_ids: Option<Vec<String>>,
    pub snippet: Option<String>,
    pub history_id: Option<String>,
    pub internal_date: Option<String>,
    pub payload: Option<GmailPayload>,
    pub size_estimate: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailPayload {
    pub mime_type: Option<String>,
    pub headers: Option<Vec<GmailHeader>>,
    pub body: Option<GmailBody>,
    pub parts: Option<Vec<GmailPayload>>,
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GmailHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailBody {
    pub attachment_id: Option<String>,
    pub size: Option<i64>,
    pub data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AttachmentResponse {
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailHistoryResponse {
    pub history: Option<Vec<GmailHistoryRecord>>,
    pub history_id: Option<String>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailHistoryRecord {
    pub id: Option<String>,
    pub messages_added: Option<Vec<HistoryMessageEntry>>,
    pub messages_deleted: Option<Vec<HistoryMessageEntry>>,
    pub labels_added: Option<Vec<HistoryLabelEntry>>,
    pub labels_removed: Option<Vec<HistoryLabelEntry>>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessageEntry {
    pub message: MessageRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLabelEntry {
    pub message: MessageRef,
    pub label_ids: Vec<String>,
}


/// Decode base64url (Gmail's encoding).
/// Gmail may include whitespace/newlines and optional padding — strip both.
pub fn decode_base64url(input: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    let clean: String = input
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .trim_end_matches('=')
        .to_string();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&clean)
        .context("base64url decode failed")
}

pub fn get_header<'a>(payload: &'a GmailPayload, name: &str) -> Option<&'a str> {
    payload.headers.as_ref()?.iter()
        .find(|h| h.name.eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// Result of a batch request — includes rate limit info for adaptive pacing.
pub struct BatchResult {
    pub messages: Vec<GmailMessage>,
    pub rate_limited: u32,
}

/// Parse a multipart/mixed batch response into individual JSON objects.
fn parse_batch_response(content_type: &str, body: &str) -> Result<BatchResult> {
    let boundary = content_type
        .split("boundary=")
        .nth(1)
        .map(|b| b.trim_matches('"').trim())
        .ok_or_else(|| anyhow::anyhow!("No boundary in batch response"))?;

    let mut messages = Vec::new();
    let mut parts_total: u32 = 0;
    let mut rate_limited: u32 = 0;
    let mut parse_errors: u32 = 0;

    for part in body.split(&format!("--{}", boundary)) {
        // Skip preamble and closing
        if part.trim().is_empty() || part.trim() == "--" {
            continue;
        }

        parts_total += 1;

        // Check for per-part HTTP error status (e.g. "HTTP/1.1 429 Too Many Requests")
        if let Some(status_line) = part.lines().find(|l| l.starts_with("HTTP/")) {
            if status_line.contains("429") {
                rate_limited += 1;
                continue;
            }
            if !status_line.contains("200") {
                parse_errors += 1;
                if parse_errors <= 3 {
                    log::warn!("Gmail batch part error: {}", status_line.trim());
                }
                continue;
            }
        }

        // Find the JSON body (after the empty line separating HTTP headers from body within each part)
        // Each part has: MIME headers, blank line, HTTP status line, HTTP headers, blank line, JSON body
        let json_start = part.find("\r\n{").or_else(|| part.find("\n{"));
        if let Some(pos) = json_start {
            let json_str = &part[pos..].trim();
            if let Ok(msg) = serde_json::from_str::<GmailMessage>(json_str) {
                messages.push(msg);
            } else {
                if let Some(end) = find_json_end(json_str) {
                    if let Ok(msg) = serde_json::from_str::<GmailMessage>(&json_str[..=end]) {
                        messages.push(msg);
                    } else {
                        parse_errors += 1;
                    }
                } else {
                    parse_errors += 1;
                }
            }
        } else {
            parse_errors += 1;
        }
    }

    if rate_limited > 0 || parse_errors > 0 {
        log::warn!("Gmail batch: {}/{} rate-limited, {}/{} parse errors", rate_limited, parts_total, parse_errors, parts_total);
    }

    Ok(BatchResult { messages, rate_limited })
}

/// Find the index of the closing brace for a top-level JSON object.
fn find_json_end(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;

    for (i, c) in s.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if c == '\\' && in_string {
            escape = true;
            continue;
        }
        if c == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}
