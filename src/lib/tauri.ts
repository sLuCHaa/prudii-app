import { invoke } from "@tauri-apps/api/core";
import type { Account, AiResponse, Attachment, AttachmentWithContext, AppConfig, AppSettings, BackupOptions, BulkSaveResult, Contact, CreateAccountRequest, CreateRuleRequest, EmailTemplate, Folder, InboxSplit, LicenseInfo, Mail, MailRule, OAuthResult, OllamaStatus, RestorePreview, ScheduledMail, SearchResult, SendMailRequest, UnsubscribeResult } from "../types";

export async function listAccounts(): Promise<Account[]> {
  return invoke("list_accounts");
}

export async function createAccount(request: CreateAccountRequest): Promise<Account> {
  return invoke("create_account", { request });
}

export async function storeAccountPassword(accountId: string, password: string): Promise<void> {
  return invoke("store_account_password", { accountId, password });
}

export async function deleteAccount(accountId: string): Promise<void> {
  return invoke("delete_account", { accountId });
}

export async function updateAccountSignature(
  accountId: string,
  signatureHtml: string,
  signatureText: string,
  signatureOnCompose: boolean,
  signatureOnReply: boolean,
): Promise<void> {
  return invoke("update_account_signature", { accountId, signatureHtml, signatureText, signatureOnCompose, signatureOnReply });
}

export async function updateAccountSyncInterval(
  accountId: string,
  syncIntervalMinutes: number,
): Promise<void> {
  return invoke("update_account_sync_interval", { accountId, syncIntervalMinutes });
}

export async function updateAccountSettings(
  accountId: string,
  displayName: string,
  color: string,
  imapHost: string,
  imapPort: number,
  smtpHost: string,
  smtpPort: number,
  smtpSecurity: string,
  loadExternalImages: string,
): Promise<void> {
  return invoke("update_account_settings", {
    accountId,
    displayName,
    color,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    smtpSecurity,
    loadExternalImages,
  });
}

export async function listFolders(accountId: string): Promise<Folder[]> {
  return invoke("list_folders", { accountId });
}

export async function createFolder(
  accountId: string,
  name: string,
  isLocal: boolean,
): Promise<Folder> {
  return invoke("create_folder", { accountId, name, isLocal });
}

export async function deleteFolder(folderId: string): Promise<void> {
  return invoke("delete_folder", { folderId });
}

export async function renameFolder(folderId: string, newName: string): Promise<void> {
  return invoke("rename_folder", { folderId, newName });
}

export async function updateFolderColor(folderId: string, color: string): Promise<void> {
  return invoke("update_folder_color", { folderId, color });
}

export async function listMails(folderId: string, limit?: number, offset?: number, folderFilter?: string): Promise<Mail[]> {
  return invoke("list_mails", { folderId, limit: limit ?? null, offset: offset ?? null, folderFilter: folderFilter ?? null });
}

export async function listFilteredMails(filterType: string, accountId?: string, limit?: number, offset?: number, folderFilter?: string): Promise<Mail[]> {
  return invoke("list_filtered_mails", { filterType, accountId: accountId ?? null, limit: limit ?? null, offset: offset ?? null, folderFilter: folderFilter ?? null });
}

export async function listAllInboxMails(limit?: number, offset?: number, folderFilter?: string): Promise<Mail[]> {
  return invoke("list_all_inbox_mails", { limit: limit ?? null, offset: offset ?? null, folderFilter: folderFilter ?? null });
}

export async function getMail(mailId: string): Promise<Mail | null> {
  return invoke("get_mail", { mailId });
}

export async function fetchMailBody(mailId: string): Promise<Mail> {
  return invoke("fetch_mail_body", { mailId });
}

export async function prefetchFolder(folderId: string): Promise<void> {
  return invoke("prefetch_folder", { folderId });
}

export async function testImapConnection(
  host: string,
  port: number,
  email: string,
  password: string,
  authType?: string,
): Promise<string> {
  return invoke("test_imap_connection", { host, port, email, password, authType: authType ?? null });
}

export async function syncAccount(accountId: string, password?: string): Promise<void> {
  return invoke("sync_account", { accountId, password: password ?? null });
}

export async function syncAllAccounts(): Promise<void> {
  return invoke("sync_all_accounts");
}

export async function forceResyncAccount(accountId: string): Promise<void> {
  return invoke("force_resync_account", { accountId });
}

export async function syncFolder(accountId: string, folderId: string): Promise<void> {
  return invoke("sync_folder", { accountId, folderId });
}

export async function listAttachments(mailId: string): Promise<Attachment[]> {
  return invoke("list_attachments", { mailId });
}

export async function getAttachmentPreview(attachmentId: string): Promise<string | null> {
  return invoke("get_attachment_preview", { attachmentId });
}

export async function openAttachment(attachmentId: string): Promise<string> {
  return invoke("open_attachment", { attachmentId });
}

export async function saveAttachment(attachmentId: string): Promise<string | null> {
  return invoke("save_attachment", { attachmentId });
}

export async function searchMails(
  query: string,
  accountId?: string,
): Promise<SearchResult[]> {
  return invoke("search_mails", { query, accountId: accountId ?? null });
}

export async function toggleStar(mailId: string): Promise<boolean> {
  return invoke("toggle_star", { mailId });
}

export async function toggleRead(mailId: string): Promise<boolean> {
  return invoke("toggle_read", { mailId });
}

export async function markAsRead(mailId: string): Promise<void> {
  return invoke("mark_as_read", { mailId });
}

export async function trashMail(mailId: string): Promise<void> {
  return invoke("trash_mail", { mailId });
}

export async function moveMail(mailId: string, destFolderId: string): Promise<void> {
  return invoke("move_mail", { mailId, destFolderId });
}

export async function archiveMail(mailId: string): Promise<void> {
  return invoke("archive_mail", { mailId });
}

export async function getThreadMails(mailId: string): Promise<Mail[]> {
  return invoke("get_thread_mails", { mailId });
}

export async function setMailFlags(mailId: string, flags: string[]): Promise<string[]> {
  return invoke("set_mail_flags", { mailId, flags });
}

export async function toggleMailFlag(mailId: string, flag: string): Promise<string[]> {
  return invoke("toggle_mail_flag", { mailId, flag });
}

export async function getAppSettings(): Promise<AppSettings> {
  return invoke("get_app_settings");
}

export async function updateAppSettings(settings: AppSettings): Promise<void> {
  return invoke("update_app_settings", { settings });
}

export async function getAppConfig(): Promise<AppConfig> {
  return invoke("get_app_config");
}

export async function sendMail(request: SendMailRequest): Promise<void> {
  return invoke("send_mail", { request });
}

export async function saveDraft(request: SendMailRequest): Promise<void> {
  return invoke("save_draft", { request });
}

export async function backfillBodies(accountId: string): Promise<void> {
  return invoke("backfill_bodies", { accountId });
}

export async function testSmtpConnection(
  host: string,
  port: number,
  email: string,
  password: string,
  security?: string,
  authType?: string,
): Promise<string> {
  return invoke("test_smtp_connection", { host, port, email, password, security: security ?? null, authType: authType ?? null });
}

export async function startOAuth(provider: string): Promise<OAuthResult> {
  return invoke("start_oauth", { provider });
}

export async function hideToTray(): Promise<void> {
  return invoke("hide_to_tray");
}

export async function quitApp(): Promise<void> {
  return invoke("quit_app");
}

export async function listCombinedFolderMails(folderType: string, limit?: number, offset?: number, folderFilter?: string): Promise<Mail[]> {
  return invoke("list_combined_folder_mails", { folderType, limit: limit ?? null, offset: offset ?? null, folderFilter: folderFilter ?? null });
}

export async function countFolderMails(folderId: string): Promise<number> {
  return invoke("count_folder_mails", { folderId });
}

export async function emptyTrash(accountId: string): Promise<number> {
  return invoke("empty_trash", { accountId });
}

export async function emptySpam(accountId: string): Promise<number> {
  return invoke("empty_spam", { accountId });
}

export async function countCombinedFolderMails(folderType: string): Promise<number> {
  return invoke("count_combined_folder_mails", { folderType });
}

export async function countSearchableMails(accountId?: string): Promise<number> {
  return invoke("count_searchable_mails", { accountId: accountId ?? null });
}

export async function emptyAllTrash(): Promise<number> {
  return invoke("empty_all_trash");
}

export async function emptyAllSpam(): Promise<number> {
  return invoke("empty_all_spam");
}

export async function createBackup(options: BackupOptions): Promise<void> {
  return invoke("create_backup", { options });
}

export async function previewRestore(): Promise<RestorePreview | null> {
  return invoke("preview_restore");
}

export async function restoreBackup(filePath: string, strategy: string): Promise<void> {
  return invoke("restore_backup", { filePath, strategy });
}

export async function searchContacts(query: string, accountId?: string): Promise<Contact[]> {
  return invoke("search_contacts", { query, accountId: accountId ?? null });
}

export async function listRules(accountId: string): Promise<MailRule[]> {
  return invoke("list_rules", { accountId });
}

export async function createRule(request: CreateRuleRequest): Promise<MailRule> {
  return invoke("create_rule", { request });
}

export async function updateRule(rule: MailRule): Promise<void> {
  return invoke("update_rule", { rule });
}

export async function deleteRule(ruleId: string): Promise<void> {
  return invoke("delete_rule", { ruleId });
}

export async function applyRulesNow(accountId: string): Promise<number> {
  return invoke("apply_rules_now", { accountId });
}

export async function unsubscribeMail(mailId: string): Promise<UnsubscribeResult> {
  return invoke("unsubscribe_mail", { mailId });
}

export async function registerMailtoHandler(): Promise<void> {
  return invoke("register_mailto_handler");
}

export async function unregisterMailtoHandler(): Promise<void> {
  return invoke("unregister_mailto_handler");
}

export async function isMailtoHandler(): Promise<boolean> {
  return invoke("is_mailto_handler");
}

export async function getStartupMailto(): Promise<string | null> {
  return invoke("get_startup_mailto");
}

export async function checkOllamaStatus(): Promise<OllamaStatus> {
  return invoke("check_ollama_status");
}

export async function summarizeMail(mailId: string): Promise<AiResponse> {
  return invoke("summarize_mail", { mailId });
}

export async function summarizeThread(mailId: string): Promise<AiResponse> {
  return invoke("summarize_thread", { mailId });
}

export async function suggestReplies(mailId: string): Promise<AiResponse> {
  return invoke("suggest_replies", { mailId });
}

export async function suggestThreadReplies(mailId: string): Promise<AiResponse> {
  return invoke("suggest_thread_replies", { mailId });
}

export async function aiSearchAttachments(query: string, accountId?: string): Promise<AiResponse> {
  return invoke("ai_search_attachments", { query, accountId: accountId ?? null });
}

export async function scheduleSend(request: SendMailRequest, scheduledAt: string): Promise<string> {
  return invoke("schedule_send", { request, scheduledAt });
}

export async function cancelScheduledSend(draftId: string): Promise<void> {
  return invoke("cancel_scheduled_send", { draftId });
}

export async function listScheduledMails(): Promise<ScheduledMail[]> {
  return invoke("list_scheduled_mails");
}

export async function checkScheduledMails(): Promise<number> {
  return invoke("check_scheduled_mails");
}

export async function listInboxSplits(): Promise<InboxSplit[]> {
  return invoke("list_inbox_splits");
}

export async function createInboxSplit(name: string, icon: string, conditions: string): Promise<InboxSplit> {
  return invoke("create_inbox_split", { name, icon, conditions });
}

export async function updateInboxSplit(id: string, name: string, icon: string, conditions: string, position: number): Promise<void> {
  return invoke("update_inbox_split", { id, name, icon, conditions, position });
}

export async function deleteInboxSplit(id: string): Promise<void> {
  return invoke("delete_inbox_split", { id });
}

export async function listSplitInboxMails(splitId: string, limit?: number, offset?: number): Promise<Mail[]> {
  return invoke("list_split_inbox_mails", { splitId, limit: limit ?? null, offset: offset ?? null });
}

export async function classifyUnclassifiedMails(): Promise<number> {
  return invoke("classify_unclassified_mails");
}

export async function clearAiCache(mailId?: string): Promise<void> {
  return invoke("clear_ai_cache", { mailId: mailId ?? null });
}

export async function togglePin(mailId: string): Promise<boolean> {
  return invoke("toggle_pin", { mailId });
}

export async function snoozeMail(mailId: string, until: string): Promise<void> {
  return invoke("snooze_mail", { mailId, until });
}

export async function unsnoozeMail(mailId: string): Promise<void> {
  return invoke("unsnooze_mail", { mailId });
}

export async function listSnoozedMails(accountId?: string): Promise<Mail[]> {
  return invoke("list_snoozed_mails", { accountId: accountId ?? null });
}

export async function checkSnoozedMails(): Promise<number> {
  return invoke("check_snoozed_mails");
}

export async function countSnoozedMails(): Promise<number> {
  return invoke("count_snoozed_mails");
}

export async function listTemplates(): Promise<EmailTemplate[]> {
  return invoke("list_templates");
}

export async function createTemplate(name: string, subject: string, bodyHtml: string, bodyText: string): Promise<EmailTemplate> {
  return invoke("create_template", { name, subject, bodyHtml, bodyText });
}

export async function updateTemplate(id: string, name: string, subject: string, bodyHtml: string, bodyText: string): Promise<void> {
  return invoke("update_template", { id, name, subject, bodyHtml, bodyText });
}

export async function deleteTemplate(id: string): Promise<void> {
  return invoke("delete_template", { id });
}

export interface ReleaseInfo {
  version: string;
  file_url: string;
  checksum: string;
  release_id: string;
  file_name: string;
}

export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  return invoke("check_for_update");
}

export async function downloadAndInstallUpdate(release: ReleaseInfo): Promise<void> {
  return invoke("download_and_install_update", { release });
}

export async function batchUpdateMails(mailIds: string[], action: string): Promise<void> {
  return invoke("batch_update_mails", { mailIds, action });
}

export async function licenseLogin(email: string, password: string): Promise<LicenseInfo> {
  return invoke("license_login", { email, password });
}

export async function licenseLogout(): Promise<void> {
  return invoke("license_logout");
}

export async function getLicenseInfo(): Promise<LicenseInfo> {
  return invoke("get_license_info");
}

export async function verifyLicense(): Promise<LicenseInfo> {
  return invoke("verify_license");
}

export async function activateLicenseKey(key: string, email: string): Promise<LicenseInfo> {
  return invoke("activate_license_key", { key, email });
}

export async function checkFeature(feature: string): Promise<boolean> {
  return invoke("check_feature", { feature });
}

export async function getDeviceId(): Promise<string> {
  return invoke("get_device_id");
}

export async function checkLicenseStartup(): Promise<LicenseInfo> {
  return invoke("check_license_startup");
}

export async function searchAttachments(params: {
  query: string;
  accountIds?: string[];
  folderId?: string;
  fileExtensions?: string[];
  excludeExtensions?: string[];
  sortBy?: string;
  sortOrder?: string;
  limit?: number;
  offset?: number;
}): Promise<AttachmentWithContext[]> {
  return invoke("search_attachments", {
    query: params.query,
    accountIds: params.accountIds ?? null,
    folderId: params.folderId ?? null,
    fileExtensions: params.fileExtensions ?? null,
    excludeExtensions: params.excludeExtensions ?? null,
    sortBy: params.sortBy ?? null,
    sortOrder: params.sortOrder ?? null,
    limit: params.limit ?? null,
    offset: params.offset ?? null,
  });
}

export async function countAttachments(params: {
  query: string;
  accountIds?: string[];
  folderId?: string;
  fileExtensions?: string[];
  excludeExtensions?: string[];
}): Promise<number> {
  return invoke("count_attachments", {
    query: params.query,
    accountIds: params.accountIds ?? null,
    folderId: params.folderId ?? null,
    fileExtensions: params.fileExtensions ?? null,
    excludeExtensions: params.excludeExtensions ?? null,
  });
}

export async function bulkSaveAttachments(attachmentIds: string[]): Promise<BulkSaveResult> {
  return invoke("bulk_save_attachments", { attachmentIds });
}

export async function checkConnectivity(): Promise<boolean> {
  return invoke("check_connectivity");
}

export async function invalidateConnections(): Promise<void> {
  return invoke("invalidate_connections");
}

