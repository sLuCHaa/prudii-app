//! Microsoft Graph Mail API HTTP client.
//! Stateless HTTP calls — no persistent connections or pools needed.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const BASE_URL: &str = "https://graph.microsoft.com/v1.0/me";

/// Percent-encode a string for use as a URL query parameter value.
/// Encodes everything except RFC 3986 unreserved characters (A-Z a-z 0-9 - . _ ~).
fn percent_encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Lightweight Graph API client wrapping a reqwest client + access token.
pub struct OutlookClient {
    http: reqwest::Client,
    token: String,
}

static SHARED_HTTP: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("failed to build Outlook HTTP client")
});

impl OutlookClient {
    pub fn new(access_token: &str) -> Self {
        Self {
            http: SHARED_HTTP.clone(),
            token: access_token.to_string(),
        }
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn is_retryable(status: reqwest::StatusCode) -> bool {
        status.as_u16() == 429 || status.is_server_error()
    }

    pub async fn list_folders(&self) -> Result<Vec<GraphFolder>> {
        let mut all_folders = Vec::new();
        let mut url = format!("{}/mailFolders?$top=100", BASE_URL);

        loop {
            let result: GraphFolderListResponse = {
                let mut attempt = 0u32;
                loop {
                    let resp = self.http
                        .get(&url)
                        .header("Authorization", self.auth_header())
                        .send()
                        .await
                        .context("list_folders request failed")?;

                    let status = resp.status();
                    if status.is_success() {
                        break resp.json().await.context("list_folders parse failed")?;
                    }

                    attempt += 1;
                    if Self::is_retryable(status) && attempt <= 3 {
                        let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                        log::warn!("list_folders: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                        tokio::time::sleep(delay).await;
                        continue;
                    }

                    let body = resp.text().await.unwrap_or_default();
                    bail!("list_folders failed ({}): {}", status, body);
                }
            };

            all_folders.extend(result.value);

            match result.next_link {
                Some(next) if !next.is_empty() => url = next,
                _ => break,
            }
        }

        Ok(all_folders)
    }

    /// Create a new mail folder.
    /// POST /me/mailFolders { displayName: name }
    pub async fn create_folder(&self, name: &str) -> Result<GraphFolder> {
        let url = format!("{}/mailFolders", BASE_URL);
        let body = serde_json::json!({ "displayName": name });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(&body)
                .send()
                .await
                .context("create_folder request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("create_folder parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("create_folder: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("create_folder failed ({}): {}", status, body);
        }
    }

    /// Delete a mail folder by its Graph folder ID.
    /// DELETE /me/mailFolders/{folder_id}
    pub async fn delete_folder(&self, folder_id: &str) -> Result<()> {
        let url = format!("{}/mailFolders/{}", BASE_URL, folder_id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .delete(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("delete_folder request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("delete_folder {}: {} on attempt {}, retrying in {:?}", folder_id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("delete_folder {} failed ({}): {}", folder_id, status, body);
        }
    }

    /// Rename a mail folder by its Graph folder ID.
    /// PATCH /me/mailFolders/{folder_id} { displayName: new_name }
    pub async fn rename_folder(&self, folder_id: &str, new_name: &str) -> Result<()> {
        let url = format!("{}/mailFolders/{}", BASE_URL, folder_id);
        let body = serde_json::json!({ "displayName": new_name });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .patch(&url)
                .header("Authorization", self.auth_header())
                .json(&body)
                .send()
                .await
                .context("rename_folder request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("rename_folder {}: {} on attempt {}, retrying in {:?}", folder_id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("rename_folder {} failed ({}): {}", folder_id, status, body);
        }
    }

    /// List messages in a folder (paginated via @odata.nextLink).
    /// On first call pass `next_link = None` to start from the beginning.
    /// On subsequent calls pass the `next_link` from the previous response.
    /// Returns (response, had_retry) so callers can adapt their pacing.
    pub async fn list_messages(&self, folder_id: &str, next_link: Option<&str>, top: u32) -> Result<(GraphMessageListResponse, bool)> {
        let url = if let Some(link) = next_link {
            link.to_string()
        } else {
            let select = "subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,hasAttachments,internetMessageId,conversationId,bodyPreview,importance,parentFolderId,internetMessageHeaders";
            format!(
                "{}/mailFolders/{}/messages?$select={}&$top={}&$orderby=receivedDateTime%20desc",
                BASE_URL, folder_id, select, top
            )
        };

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
                let had_retry = attempt > 0;
                let parsed = resp.json().await.context("list_messages parse failed")?;
                return Ok((parsed, had_retry));
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

    /// Get a single message with full body.
    pub async fn get_message(&self, id: &str) -> Result<GraphMessage> {
        let url = format!("{}/messages/{}?$select=subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,flag,hasAttachments,internetMessageId,conversationId,body,bodyPreview,importance,parentFolderId", BASE_URL, id);

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

    /// Find a message by its RFC 5322 internetMessageId, searching all folders.
    /// Graph message IDs are mutable — they change whenever a message moves folders —
    /// so this is the recovery path when a stored ID returns 404 ErrorItemNotFound.
    pub async fn find_message_by_internet_id(&self, internet_message_id: &str) -> Result<Option<GraphMessage>> {
        let filter = format!("internetMessageId eq '{}'", internet_message_id.replace('\'', "''"));
        let url = format!(
            "{}/messages?$filter={}&$select=id,parentFolderId,internetMessageId&$top=1",
            BASE_URL,
            percent_encode_query(&filter)
        );

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("find_message_by_internet_id request failed")?;

            let status = resp.status();
            if status.is_success() {
                let result: GraphMessageListResponse = resp.json().await
                    .context("find_message_by_internet_id parse failed")?;
                return Ok(result.value.into_iter().next());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("find_message_by_internet_id: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("find_message_by_internet_id failed ({}): {}", status, body);
        }
    }

    /// Batch-get up to 15 messages in a single HTTP request.
    /// Uses Graph $batch endpoint with JSON.
    /// Returns OutlookBatchResult with rate_limited count so callers can adapt pacing.
    /// Graph API has a per-batch concurrency limit similar to Gmail (~20),
    /// so we cap at 15 to stay safely under the limit.
    pub async fn batch_get_messages(&self, ids: &[&str], select: &str) -> Result<OutlookBatchResult> {
        if ids.is_empty() {
            return Ok(OutlookBatchResult { messages: Vec::new(), rate_limited: 0 });
        }
        if ids.len() > 15 {
            bail!("batch_get_messages: max 15 per batch, got {}", ids.len());
        }

        let requests: Vec<serde_json::Value> = ids.iter().enumerate().map(|(i, id)| {
            serde_json::json!({
                "id": format!("{}", i),
                "method": "GET",
                "url": format!("/me/messages/{}?$select={}", id, select),
            })
        }).collect();

        let batch_body = serde_json::json!({ "requests": requests });

        let batch_resp: GraphBatchResponse = {
            let mut attempt = 0u32;
            loop {
                let resp = self.http
                    .post("https://graph.microsoft.com/v1.0/$batch")
                    .header("Authorization", self.auth_header())
                    .header("Content-Type", "application/json")
                    .json(&batch_body)
                    .send()
                    .await
                    .context("batch_get_messages request failed")?;

                let status = resp.status();
                if status.is_success() {
                    break resp.json().await.context("batch_get_messages parse failed")?;
                }

                attempt += 1;
                if Self::is_retryable(status) && attempt <= 3 {
                    let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                    log::warn!("batch_get_messages: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                    tokio::time::sleep(delay).await;
                    continue;
                }

                let body = resp.text().await.unwrap_or_default();
                bail!("batch_get_messages failed ({}): {}", status, body);
            }
        };

        let mut messages = Vec::new();
        let mut rate_limited: u32 = 0;
        let mut parse_errors: u32 = 0;

        for response in batch_resp.responses {
            if response.status == 200 {
                if let Some(body) = response.body {
                    if let Ok(msg) = serde_json::from_value::<GraphMessage>(body) {
                        messages.push(msg);
                    } else {
                        parse_errors += 1;
                    }
                }
            } else if response.status == 429 {
                rate_limited += 1;
            } else {
                parse_errors += 1;
                if parse_errors <= 3 {
                    log::warn!("Outlook batch part error: status {}", response.status);
                }
            }
        }

        if rate_limited > 0 {
            log::warn!("Outlook batch: {}/{} rate-limited (429)", rate_limited, ids.len());
        }
        if parse_errors > 0 {
            log::warn!("Outlook batch: {}/{} parse errors", parse_errors, ids.len());
        }

        Ok(OutlookBatchResult { messages, rate_limited })
    }

    pub async fn list_attachments(&self, message_id: &str) -> Result<Vec<GraphAttachment>> {
        let url = format!("{}/messages/{}/attachments", BASE_URL, message_id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("list_attachments request failed")?;

            let status = resp.status();
            if status.is_success() {
                let result: GraphAttachmentListResponse = resp.json().await
                    .context("list_attachments parse failed")?;
                return Ok(result.value);
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("list_attachments {}: {} on attempt {}, retrying in {:?}", message_id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("list_attachments failed ({}): {}", status, body);
        }
    }

    /// Get delta changes for a folder. Pass None for initial delta request.
    pub async fn get_delta(&self, folder_id: &str, delta_link: Option<&str>) -> Result<GraphDeltaResponse> {
        let select = "subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,hasAttachments,internetMessageId,conversationId,bodyPreview,importance,parentFolderId,internetMessageHeaders";

        let url = if let Some(link) = delta_link {
            link.to_string()
        } else {
            format!(
                "{}/mailFolders/{}/messages/delta?$select={}",
                BASE_URL, folder_id, select
            )
        };

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .get(&url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .context("get_delta request failed")?;

            let status = resp.status();
            if status.as_u16() == 410 {
                bail!("delta_expired");
            }
            if status.is_success() {
                return resp.json().await.context("get_delta parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("get_delta: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("get_delta failed ({}): {}", status, body);
        }
    }

    /// Update message properties (isRead, flag, etc.).
    pub async fn update_message(&self, id: &str, props: &serde_json::Value) -> Result<()> {
        let url = format!("{}/messages/{}", BASE_URL, id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .patch(&url)
                .header("Authorization", self.auth_header())
                .json(props)
                .send()
                .await
                .context("update_message request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("update_message {}: {} on attempt {}, retrying in {:?}", id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("update_message {} failed ({}): {}", id, status, body);
        }
    }

    pub async fn move_message(&self, id: &str, destination_folder_id: &str) -> Result<GraphMessage> {
        let url = format!("{}/messages/{}/move", BASE_URL, id);

        let payload = serde_json::json!({
            "destinationId": destination_folder_id,
        });

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(&payload)
                .send()
                .await
                .context("move_message request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("move_message parse failed");
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("move_message {}: {} on attempt {}, retrying in {:?}", id, status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("move_message {} failed ({}): {}", id, status, body);
        }
    }

    /// Permanently delete a message.
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

    /// Create a draft message in the Drafts folder.
    /// POST /me/messages with the message JSON (without sending).
    pub async fn create_draft(&self, message: &SendMessage) -> Result<GraphMessage> {
        let url = format!("{}/messages", BASE_URL);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(message)
                .send()
                .await
                .context("create_draft request failed")?;

            let status = resp.status();
            if status.is_success() {
                return resp.json().await.context("create_draft parse failed");
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

    /// Send a mail via Graph API. Automatically saved to Sent Items.
    pub async fn send_mail(&self, message: &SendMailPayload) -> Result<()> {
        let url = format!("{}/sendMail", BASE_URL);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(message)
                .send()
                .await
                .context("send_mail request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("send_mail: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("send_mail failed ({}): {}", status, body);
        }
    }

    /// Reply to a message via Graph API. Handles threading automatically.
    pub async fn reply_mail(&self, original_graph_id: &str, payload: &ReplyPayload) -> Result<()> {
        let url = format!("{}/messages/{}/reply", BASE_URL, original_graph_id);

        let mut attempt = 0u32;
        loop {
            let resp = self.http
                .post(&url)
                .header("Authorization", self.auth_header())
                .json(payload)
                .send()
                .await
                .context("reply_mail request failed")?;

            let status = resp.status();
            if status.is_success() {
                return Ok(());
            }

            attempt += 1;
            if Self::is_retryable(status) && attempt <= 3 {
                let delay = std::time::Duration::from_millis(1000 * 2u64.pow(attempt - 1));
                log::warn!("reply_mail: {} on attempt {}, retrying in {:?}", status, attempt, delay);
                tokio::time::sleep(delay).await;
                continue;
            }

            let body = resp.text().await.unwrap_or_default();
            bail!("reply_mail failed ({}): {}", status, body);
        }
    }
}

/// Result of a batch request with rate-limiting feedback.
/// Separates 429s from parse errors so callers can adapt pacing.
pub struct OutlookBatchResult {
    pub messages: Vec<GraphMessage>,
    pub rate_limited: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphFolderListResponse {
    value: Vec<GraphFolder>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFolder {
    pub id: String,
    pub display_name: String,
    pub parent_folder_id: Option<String>,
    pub child_folder_count: Option<i32>,
    pub total_item_count: Option<i32>,
    pub unread_item_count: Option<i32>,
}

/// wellKnownName is only present on system folders in some responses.
/// We match by displayName patterns instead.
impl GraphFolder {
    /// Map a Graph folder to our folder_type based on well-known folder display names.
    /// Microsoft Graph uses localized names, but `wellKnownName` isn't in the
    /// default response. Instead we check common English/German names.
    pub fn folder_type(&self) -> &'static str {
        let name_lower = self.display_name.to_lowercase();
        match name_lower.as_str() {
            "inbox" | "posteingang" => "inbox",
            "sent items" | "gesendete elemente" | "sent" => "sent",
            "drafts" | "entwürfe" => "drafts",
            "deleted items" | "gelöschte elemente" | "trash" => "trash",
            "junk email" | "junk-e-mail" | "junk" | "spam" => "spam",
            "archive" | "archiv" => "archive",
            _ => "custom",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMessageListResponse {
    pub value: Vec<GraphMessage>,
    #[serde(rename = "@odata.nextLink")]
    pub next_link: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMessage {
    pub id: String,
    pub subject: Option<String>,
    pub from: Option<GraphRecipient>,
    pub to_recipients: Option<Vec<GraphRecipient>>,
    pub cc_recipients: Option<Vec<GraphRecipient>>,
    pub bcc_recipients: Option<Vec<GraphRecipient>>,
    pub body: Option<GraphBody>,
    pub body_preview: Option<String>,
    pub received_date_time: Option<String>,
    pub is_read: Option<bool>,
    pub flag: Option<GraphFlag>,
    pub has_attachments: Option<bool>,
    pub internet_message_id: Option<String>,
    pub conversation_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub importance: Option<String>,
    pub parent_folder_id: Option<String>,
    pub internet_message_headers: Option<Vec<GraphInternetMessageHeader>>,
    /// Present in delta responses when a message was removed.
    #[serde(rename = "@removed")]
    pub removed: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GraphInternetMessageHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRecipient {
    pub email_address: GraphEmailAddress,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GraphEmailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBody {
    pub content_type: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFlag {
    pub flag_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAttachment {
    pub id: Option<String>,
    pub name: Option<String>,
    pub content_type: Option<String>,
    pub size: Option<i64>,
    pub is_inline: Option<bool>,
    pub content_id: Option<String>,
    pub content_bytes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphAttachmentListResponse {
    value: Vec<GraphAttachment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDeltaResponse {
    pub value: Vec<GraphMessage>,
    #[serde(rename = "@odata.nextLink")]
    pub next_link: Option<String>,
    #[serde(rename = "@odata.deltaLink")]
    pub delta_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphBatchResponse {
    responses: Vec<GraphBatchResponseItem>,
}

#[derive(Debug, Deserialize)]
struct GraphBatchResponseItem {
    status: u16,
    body: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMailPayload {
    pub message: SendMessage,
    pub save_to_sent_items: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessage {
    pub subject: String,
    pub body: SendBody,
    pub to_recipients: Vec<GraphRecipient>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cc_recipients: Vec<GraphRecipient>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bcc_recipients: Vec<GraphRecipient>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<SendAttachment>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub internet_message_headers: Vec<InternetMessageHeader>,
}

#[derive(Debug, Serialize)]
pub struct InternetMessageHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendBody {
    pub content_type: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAttachment {
    #[serde(rename = "@odata.type")]
    pub odata_type: String,
    pub name: String,
    pub content_type: String,
    pub content_bytes: String, // base64
}

/// Payload for POST /me/messages/{id}/reply
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyPayload {
    pub message: SendMessage,
}
