CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3b82f6',
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL DEFAULT 993,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL DEFAULT 587,
    auth_type TEXT NOT NULL DEFAULT 'password',
    last_sync DATETIME,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    folder_type TEXT NOT NULL DEFAULT 'custom',
    path TEXT NOT NULL,
    unread_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    last_sync DATETIME,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, path)
);

CREATE TABLE IF NOT EXISTS mails (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    message_id TEXT,
    uid INTEGER,
    subject TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL DEFAULT (datetime('now')),
    snippet TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    is_replied INTEGER NOT NULL DEFAULT 0,
    is_forwarded INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT,
    in_reply_to TEXT,
    "references" TEXT,
    raw_headers TEXT,
    labels TEXT,
    size_bytes INTEGER,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    UNIQUE(account_id, folder_id, uid)
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    mail_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    content_id TEXT,
    is_inline INTEGER NOT NULL DEFAULT 0,
    local_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (mail_id) REFERENCES mails(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    subject TEXT,
    to_addresses TEXT,
    cc_addresses TEXT,
    bcc_addresses TEXT,
    body_text TEXT,
    body_html TEXT,
    in_reply_to TEXT,
    scheduled_at DATETIME,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Full-Text Search (standalone table, not external content)
CREATE VIRTUAL TABLE IF NOT EXISTS mails_fts USING fts5(
    mail_id UNINDEXED,
    subject,
    from_email,
    from_name,
    body_text,
    tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS mail_rules (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    from_contains TEXT,
    to_contains TEXT,
    subject_contains TEXT,
    has_attachments INTEGER,
    action_move_to_folder TEXT,
    action_mark_read INTEGER,
    action_star INTEGER,
    action_trash INTEGER,
    action_archive INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Pending operations queue: reliable server sync for flag changes and mail moves.
-- Operations are inserted before the server call and deleted on success.
-- Failed operations are retried on the next account sync.
CREATE TABLE IF NOT EXISTS pending_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    mail_id TEXT NOT NULL,
    op_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_ops_dedup ON pending_ops(mail_id, op_type);
CREATE INDEX IF NOT EXISTS idx_pending_ops_account ON pending_ops(account_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);
CREATE INDEX IF NOT EXISTS idx_folders_type ON folders(account_id, folder_type);
CREATE INDEX IF NOT EXISTS idx_mails_folder ON mails(folder_id);
CREATE INDEX IF NOT EXISTS idx_mails_account ON mails(account_id);
CREATE INDEX IF NOT EXISTS idx_mails_date ON mails(date DESC);
CREATE INDEX IF NOT EXISTS idx_mails_folder_date ON mails(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_mails_starred_date ON mails(is_starred, date DESC) WHERE is_starred = 1;
CREATE INDEX IF NOT EXISTS idx_mails_thread ON mails(thread_id);
CREATE INDEX IF NOT EXISTS idx_mails_unread ON mails(is_read) WHERE is_read = 0;
CREATE INDEX IF NOT EXISTS idx_mails_folder_unread ON mails(folder_id, is_read);
CREATE INDEX IF NOT EXISTS idx_mails_message_id ON mails(account_id, message_id);
-- API dedup index (idx_mails_gmail_dedup) is created in run_migrations() AFTER
-- cleaning up existing duplicates, to avoid schema.sql failing on dirty data.
CREATE INDEX IF NOT EXISTS idx_attachments_mail ON attachments(mail_id);
-- idx_mails_pinned and idx_mails_snoozed are created in run_migrations() AFTER
-- ALTER TABLE adds those columns, to avoid failing on existing DBs.
