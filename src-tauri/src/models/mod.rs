use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub provider: String,
    pub color: String,
    pub imap_host: String,
    pub imap_port: i32,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_security: String, // "ssl" or "starttls"
    pub auth_type: String,
    pub signature_html: String,
    pub signature_text: String,
    pub signature_on_compose: bool,
    pub signature_on_reply: bool,
    pub sync_interval_minutes: i32,
    pub load_external_images: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CreateAccountRequest {
    pub email: String,
    pub display_name: String,
    pub provider: String,
    pub color: String,
    pub imap_host: String,
    pub imap_port: i32,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_security: String, // "ssl" or "starttls"
    pub password: String,
    pub auth_type: String,
}

// Custom Debug impl to avoid logging passwords
impl std::fmt::Debug for CreateAccountRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateAccountRequest")
            .field("email", &self.email)
            .field("provider", &self.provider)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub folder_type: String,
    pub path: String,
    pub unread_count: i32,
    pub total_count: i32,
    pub is_local: bool,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateFolderRequest {
    pub account_id: String,
    pub name: String,
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailAddress {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mail {
    pub id: String,
    pub account_id: String,
    pub folder_id: String,
    pub message_id: String,
    pub uid: Option<u32>,
    pub subject: String,
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub date: String,
    pub snippet: String,
    pub body_text: String,
    pub body_html: String,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_flagged: bool,
    pub is_replied: bool,
    pub is_forwarded: bool,
    pub has_attachments: bool,
    pub thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: String,
    pub size_bytes: Option<i64>,
    pub flags: Vec<String>,
    pub list_unsubscribe: Option<String>,
    pub reply_to: Vec<MailAddress>,
    pub is_pinned: bool,
    pub snoozed_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub launch_on_startup: bool,
    pub show_in_tray: bool,
    pub use_24h_clock: bool,
    pub show_all_unread_counts: bool,
    pub notifications_enabled: bool,
    pub notification_sound: bool,
    pub language: String,
    pub density: String,
    pub accent_color: String,
    pub ai_enabled: bool,
    pub ollama_url: String,
    pub ai_model: String,
    pub undo_send_delay: u32,
    pub theme_mode: String,
    pub transparent_sidebar: bool,
    pub strip_tracking_params: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStats {
    pub new_mails: u32,
    pub folder_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub mail_id: String,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub content_id: Option<String>,
    pub is_inline: bool,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub account_id: String,
    pub status: String, // "connecting", "syncing_folders", "syncing_mails", "done", "error"
    pub folder_name: Option<String>,
    pub folder_index: u32,
    pub folder_count: u32,
    pub new_mails: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendAttachment {
    pub name: String,
    pub mime_type: String,
    pub data: String, // base64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMailRequest {
    pub account_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Option<Vec<SendAttachment>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub email: String,
    pub name: String,
    pub frequency: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub mail_id: String,
    pub subject: String,
    pub snippet: String,
    pub from_name: String,
    pub from_email: String,
    pub date: String,
    pub folder_id: String,
    pub folder_name: String,
    pub is_read: bool,
    pub has_attachments: bool,
    pub rank: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupOptions {
    pub include_settings: bool,
    pub include_accounts: bool,
    pub include_folders: bool,
    pub include_mails: bool,
    pub include_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupProgress {
    pub status: String, // "preparing"|"exporting_*"|"restoring_*"|"done"|"error"
    pub message: String,
    pub current_step: u32,
    pub total_steps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u32,
    pub schema_version: u32,
    pub created_at: String,
    pub includes: BackupIncludes,
    pub stats: BackupStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupIncludes {
    pub app_settings: bool,
    pub accounts: bool,
    pub folders: bool,
    pub mails: bool,
    pub attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupStats {
    pub account_count: u64,
    pub folder_count: u64,
    pub mail_count: u64,
    pub attachment_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestorePreview {
    pub file_path: String,
    pub manifest: BackupManifest,
    pub existing_account_emails: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailRule {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub from_contains: Option<String>,
    pub to_contains: Option<String>,
    pub subject_contains: Option<String>,
    pub has_attachments: Option<bool>,
    pub action_move_to_folder: Option<String>,
    pub action_mark_read: Option<bool>,
    pub action_star: Option<bool>,
    pub action_trash: Option<bool>,
    pub action_archive: Option<bool>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailTemplate {
    pub id: String,
    pub name: String,
    pub subject: String,
    pub body_html: String,
    pub body_text: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRuleRequest {
    pub account_id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub from_contains: Option<String>,
    pub to_contains: Option<String>,
    pub subject_contains: Option<String>,
    pub has_attachments: Option<bool>,
    pub action_move_to_folder: Option<String>,
    pub action_mark_read: Option<bool>,
    pub action_star: Option<bool>,
    pub action_trash: Option<bool>,
    pub action_archive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxSplit {
    pub id: String,
    pub name: String,
    pub position: i32,
    pub icon: String,
    pub conditions: String, // JSON
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitConditions {
    #[serde(default)]
    pub from_domain: Vec<String>,
    #[serde(default)]
    pub from_contains: Vec<String>,
    #[serde(default)]
    pub subject_contains: Vec<String>,
    #[serde(default)]
    pub has_auto_label: Vec<String>,
    #[serde(default)]
    pub negate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentWithContext {
    pub id: String,
    pub mail_id: String,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub local_path: Option<String>,
    pub mail_subject: String,
    pub mail_from_name: String,
    pub mail_from_email: String,
    pub mail_date: String,
    pub mail_folder_id: String,
    pub folder_name: String,
    pub account_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulkSaveResult {
    pub saved: u32,
    pub failed: u32,
    pub dest_path: String,
}
