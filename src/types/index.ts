export type AccountProvider = "google" | "microsoft" | "apple" | "fastmail" | "protonmail" | "webde" | "gmx" | "custom";
export type SmtpSecurity = "starttls" | "ssl";

export interface Account {
  id: string;
  email: string;
  display_name: string;
  provider: AccountProvider;
  color: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  smtp_security: SmtpSecurity;
  auth_type: string;
  signature_html: string;
  signature_text: string;
  signature_on_compose: boolean;
  signature_on_reply: boolean;
  sync_interval_minutes: number;
  load_external_images: string;
  created_at: string;
  updated_at: string;
}

export interface CreateAccountRequest {
  email: string;
  display_name: string;
  provider: string;
  color: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  smtp_security: SmtpSecurity;
  password: string;
  auth_type: string;
}

export type FolderType = "inbox" | "sent" | "drafts" | "trash" | "spam" | "archive" | "custom";

export interface Folder {
  id: string;
  account_id: string;
  name: string;
  folder_type: FolderType;
  path: string;
  unread_count: number;
  total_count: number;
  is_local: boolean;
  color: string;
}

export interface MailAddress {
  name: string;
  email: string;
}

export interface Mail {
  id: string;
  account_id: string;
  folder_id: string;
  message_id: string;
  uid: number | null;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  date: string;
  snippet: string;
  body_text: string;
  body_html: string;
  is_read: boolean;
  is_starred: boolean;
  is_flagged: boolean;
  is_replied: boolean;
  is_forwarded: boolean;
  has_attachments: boolean;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string;
  size_bytes: number | null;
  flags: string[];
  list_unsubscribe: string | null;
  reply_to: MailAddress[];
  is_pinned: boolean;
  snoozed_until: string | null;
}

export type MailFlag = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export const MAIL_FLAG_COLORS: Record<MailFlag, { bg: string; text: string; nameKey: string }> = {
  red: { bg: "#ef4444", text: "white", nameKey: "flags.red" },
  orange: { bg: "#f97316", text: "white", nameKey: "flags.orange" },
  yellow: { bg: "#eab308", text: "black", nameKey: "flags.yellow" },
  green: { bg: "#22c55e", text: "white", nameKey: "flags.green" },
  blue: { bg: "#3b82f6", text: "white", nameKey: "flags.blue" },
  purple: { bg: "#8b5cf6", text: "white", nameKey: "flags.purple" },
  gray: { bg: "#6b7280", text: "white", nameKey: "flags.gray" },
};

export type DensityMode = "compact" | "comfortable" | "spacious";
export type AccentColor = "blue" | "purple" | "green" | "orange" | "pink" | "red" | "teal" | "amber";

export interface AppSettings {
  launch_on_startup: boolean;
  show_in_tray: boolean;
  use_24h_clock: boolean;
  show_all_unread_counts: boolean;
  notifications_enabled: boolean;
  notification_sound: boolean;
  language: string;
  density: DensityMode;
  accent_color: AccentColor;
  ai_enabled: boolean;
  ollama_url: string;
  ai_model: string;
  undo_send_delay: number;
  theme_mode: string;
  transparent_sidebar: boolean;
  strip_tracking_params: boolean;
}

export interface OllamaStatus {
  connected: boolean;
  models: string[];
  error: string | null;
}

export interface AiStreamEvent {
  request_id: string;
  chunk: string;
  done: boolean;
  error: string | null;
}

export interface AiResponse {
  request_id: string;
  cached_text: string | null;
}

export interface ReplySuggestion {
  tone: string;
  text: string;
}

export interface AiRepliesEvent {
  request_id: string;
  replies: ReplySuggestion[];
  error: string | null;
}

export interface UnsubscribeResult {
  method: string;
  success: boolean;
  url: string;
}

export interface SyncStats {
  new_mails: number;
  folder_name: string;
}

export interface Attachment {
  id: string;
  mail_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  content_id: string | null;
  is_inline: boolean;
  local_path: string | null;
}

export interface SyncProgress {
  account_id: string;
  status: "connecting" | "syncing_folders" | "syncing_mails" | "done" | "error" | "skipped";
  folder_name: string | null;
  folder_index: number;
  folder_count: number;
  new_mails: number;
  message: string;
}

export interface Contact {
  email: string;
  name: string;
  frequency: number;
}

export interface SearchResult {
  mail_id: string;
  subject: string;
  snippet: string;
  from_name: string;
  from_email: string;
  date: string;
  folder_id: string;
  folder_name: string;
  is_read: boolean;
  has_attachments: boolean;
  rank: number;
}

export interface SendAttachment {
  name: string;
  mime_type: string;
  data: string; // base64
  /// Expected byte length after decoding. The backend refuses to send an attachment
  /// whose payload does not match, so truncation cannot pass unnoticed.
  size?: number;
}

export interface SendMailRequest {
  account_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  in_reply_to?: string;
  references?: string;
  attachments?: SendAttachment[];
}

export interface BackupOptions {
  include_settings: boolean;
  include_accounts: boolean;
  include_folders: boolean;
  include_mails: boolean;
  include_attachments: boolean;
}

export interface BackupProgress {
  status: string;
  message: string;
  current_step: number;
  total_steps: number;
}

export interface BackupManifest {
  version: number;
  schema_version: number;
  created_at: string;
  includes: { app_settings: boolean; accounts: boolean; folders: boolean; mails: boolean; attachments: boolean };
  stats: { account_count: number; folder_count: number; mail_count: number; attachment_count: number };
}

export interface BackfillProgress {
  account_id: string;
  processed: number;
  total: number;
}

export interface RestorePreview {
  file_path: string;
  manifest: BackupManifest;
  existing_account_emails: string[];
}

export interface OAuthResult {
  email: string;
  access_token: string;
  refresh_token: string;
}

export interface MailRule {
  id: string;
  account_id: string;
  name: string;
  enabled: boolean;
  priority: number;
  from_contains: string | null;
  to_contains: string | null;
  subject_contains: string | null;
  has_attachments: boolean | null;
  action_move_to_folder: string | null;
  action_mark_read: boolean | null;
  action_star: boolean | null;
  action_trash: boolean | null;
  action_archive: boolean | null;
  created_at: string;
}

export interface LicenseInfo {
  user_email: string;
  plan: "free" | "premium" | "team";
  license_key: string;
  valid_until: string;
  features: string[];
  last_verified: string;
  device_id: string;
  logged_in: boolean;
  /** True when the user is still known locally but the auth token was rejected by
   * the server (e.g. after a PocketBase update). The UI prompts a re-login. */
  session_expired?: boolean;
}

export interface InboxSplit {
  id: string;
  name: string;
  position: number;
  icon: string;
  conditions: string;
  is_default: boolean;
}

export interface ScheduledMail {
  id: string;
  account_id: string;
  subject: string;
  to_addresses: string;
  scheduled_at: string;
  created_at: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
  created_at: string;
  updated_at: string;
}

export interface AiSearchResultEvent {
  request_id: string;
  attachments: AttachmentWithContext[];
  parsed_query: string;
  error: string | null;
}

export interface AttachmentWithContext {
  id: string;
  mail_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  local_path: string | null;
  mail_subject: string;
  mail_from_name: string;
  mail_from_email: string;
  mail_date: string;
  mail_folder_id: string;
  folder_name: string;
  account_id: string;
}

export interface BulkSaveResult {
  saved: number;
  failed: number;
  dest_path: string;
}

export interface CreateRuleRequest {
  account_id: string;
  name: string;
  enabled: boolean;
  priority: number;
  from_contains: string | null;
  to_contains: string | null;
  subject_contains: string | null;
  has_attachments: boolean | null;
  action_move_to_folder: string | null;
  action_mark_read: boolean | null;
  action_star: boolean | null;
  action_trash: boolean | null;
  action_archive: boolean | null;
}

export interface AppConfig {
  oauthSignupGoogle: boolean;
  oauthSignupMicrosoft: boolean;
}
