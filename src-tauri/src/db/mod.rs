use anyhow::Result;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

const SCHEMA_VERSION: u32 = 34;

pub struct Database {
    pub conn: Mutex<Connection>,
    pub data_dir: PathBuf,
}

impl Database {
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&app_data_dir)?;
        let db_path = app_data_dir.join("prudii.db");

        // Migration is fully incremental — never delete the DB.
        // schema.sql uses CREATE TABLE IF NOT EXISTS, ALTER TABLE migrations
        // silently ignore "duplicate column" errors, and version is bumped last.

        let conn = Connection::open(&db_path)?;
        // WAL mode allows concurrent readers with one writer, preventing UI freezes during sync
        // busy_timeout prevents immediate SQLITE_BUSY errors during concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;")?;

        let db = Self {
            conn: Mutex::new(conn),
            data_dir: app_data_dir,
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Lock the database connection, recovering from a poisoned mutex.
    /// If a previous thread panicked while holding the lock, we recover
    /// instead of propagating the panic.
    pub fn lock_db(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| {
            log::warn!("Database mutex was poisoned, recovering...");
            poisoned.into_inner()
        })
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.lock_db();
        let schema = include_str!("schema.sql");
        conn.execute_batch(schema)?;

        // Read the current schema version once before running any migrations.
        // Individual versioned migrations and expensive cleanup are gated on this value.
        let prev_version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap_or(0);

        // Run all ALTER TABLE migrations (silently ignore "duplicate column" errors)
        // Legacy: stored_password column kept for schema compat but no longer used (keyring only)
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN stored_password TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN signature_html TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN signature_text TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN sync_interval_minutes INTEGER DEFAULT 5;");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN signature_on_compose INTEGER DEFAULT 1;");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN signature_on_reply INTEGER DEFAULT 1;");
        let _ = conn.execute_batch("ALTER TABLE folders ADD COLUMN is_local INTEGER DEFAULT 0;");
        let _ = conn.execute_batch("ALTER TABLE folders ADD COLUMN color TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE mails ADD COLUMN flags TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN smtp_security TEXT DEFAULT 'ssl';");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN load_external_images TEXT NOT NULL DEFAULT 'always';");
        let _ = conn.execute_batch("ALTER TABLE folders ADD COLUMN uid_validity INTEGER DEFAULT 0;");
        let _ = conn.execute_batch("ALTER TABLE folders ADD COLUMN uid_next INTEGER DEFAULT 0;");
        let _ = conn.execute_batch("ALTER TABLE accounts ADD COLUMN gmail_history_id TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE folders ADD COLUMN delta_link TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE mails ADD COLUMN list_unsubscribe TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE mails ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;");
        let _ = conn.execute_batch("ALTER TABLE mails ADD COLUMN snoozed_until TEXT DEFAULT '';");
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_mails_pinned ON mails(is_pinned) WHERE is_pinned = 1;");
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_mails_snoozed ON mails(snoozed_until) WHERE snoozed_until != '';");
        // Composite indexes for common query patterns (folder listing, starred view)
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_mails_folder_date ON mails(folder_id, date DESC);");
        let _ = conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_mails_starred_date ON mails(is_starred, date DESC) WHERE is_starred = 1;");

        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_cache (
                id TEXT PRIMARY KEY,
                mail_id TEXT NOT NULL,
                cache_type TEXT NOT NULL,
                result TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(mail_id, cache_type)
            );"
        );

        // Clean up duplicate attachments and add unique constraint
        let att_dupes: usize = conn.execute(
            "DELETE FROM attachments WHERE rowid NOT IN (
                SELECT MIN(rowid) FROM attachments GROUP BY mail_id, filename
            )",
            [],
        ).unwrap_or(0);
        if att_dupes > 0 {
            log::info!("DB cleanup: removed {} duplicate attachments", att_dupes);
        }
        let _ = conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_unique ON attachments(mail_id, filename);"
        );

        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        );

        // License cache table (singleton: id=1 enforced)
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS license_cache (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                user_email TEXT NOT NULL DEFAULT '',
                plan TEXT NOT NULL DEFAULT 'free',
                license_key TEXT NOT NULL DEFAULT '',
                valid_until TEXT NOT NULL DEFAULT '',
                features TEXT NOT NULL DEFAULT '[]',
                signature TEXT NOT NULL DEFAULT '',
                last_verified TEXT NOT NULL DEFAULT '',
                device_id TEXT NOT NULL DEFAULT '',
                pb_auth_token TEXT NOT NULL DEFAULT ''
            );"
        );
        let _ = conn.execute_batch(
            "INSERT OR IGNORE INTO license_cache (id) VALUES (1);"
        );

        // Reply-To header support (RFC 2822)
        let _ = conn.execute_batch("ALTER TABLE mails ADD COLUMN reply_to_json TEXT DEFAULT '[]';");
        // Auto-labels column for rule-based mail classification
        let _ = conn.execute_batch("ALTER TABLE mails ADD COLUMN auto_labels TEXT DEFAULT '';");
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_mails_auto_labels ON mails(auto_labels) WHERE auto_labels != '';"
        );

        // Inbox splits table for split inbox feature
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS inbox_splits (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                icon TEXT NOT NULL DEFAULT 'inbox',
                conditions TEXT NOT NULL DEFAULT '{}',
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        );

        let split_count: i32 = conn.query_row("SELECT COUNT(*) FROM inbox_splits", [], |r| r.get(0)).unwrap_or(0);
        if split_count == 0 {
            let _ = conn.execute_batch(
                "INSERT INTO inbox_splits (id, name, position, icon, conditions, is_default) VALUES
                ('primary', 'Primary', 0, 'inbox', '{}', 1),
                ('notifications', 'Notifications', 1, 'bell', '{\"from_contains\":[\"noreply@\",\"notifications@\",\"no-reply@\"]}', 1),
                ('newsletters', 'Newsletters', 2, 'newspaper', '{\"has_auto_label\":[\"newsletter\"]}', 1);"
            );
        }

        // Drafts table: add missing columns for scheduled sends
        let _ = conn.execute_batch("ALTER TABLE drafts ADD COLUMN attachments_json TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE drafts ADD COLUMN references_header TEXT DEFAULT '';");
        let _ = conn.execute_batch("ALTER TABLE drafts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;");

        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS email_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                body_html TEXT NOT NULL DEFAULT '',
                body_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );"
        );

        // Always log total mail count for diagnostics (fast, always runs)
        let total_mails: i32 = conn.query_row("SELECT COUNT(*) FROM mails", [], |row| row.get(0)).unwrap_or(0);
        log::info!("DB startup: {} total mails (schema v{}, prev v{})", total_mails, SCHEMA_VERSION, prev_version);

        // Expensive duplicate diagnostic: only run during schema upgrades
        if prev_version < SCHEMA_VERSION {
            let dup_count: i32 = conn.query_row(
                "SELECT COUNT(*) FROM mails WHERE rowid NOT IN (
                    SELECT MIN(rowid) FROM mails
                    GROUP BY account_id, folder_id, COALESCE(NULLIF(message_id, ''), id)
                )",
                [],
                |row| row.get(0),
            ).unwrap_or(0);
            log::info!("DB upgrade: {} duplicates found (schema v{})", dup_count, SCHEMA_VERSION);
        }

        // Fix mails with empty date (caused by Outlook messages missing receivedDateTime).
        // Set to current UTC time so the frontend doesn't crash on Invalid Date.
        // Use RFC3339 with `T` and `Z` so parseISO interprets it as UTC, not local time.
        let fixed_dates: usize = conn.execute(
            "UPDATE mails SET date = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE date IS NULL OR date = ''",
            [],
        ).unwrap_or(0);
        if fixed_dates > 0 {
            log::info!("DB cleanup: fixed {} mails with empty date", fixed_dates);
        }

        // v33 fix: rewrite Gmail/Outlook mail dates from "YYYY-MM-DD HH:MM:SS" (UTC values
        // without a timezone marker) to RFC3339 "YYYY-MM-DDTHH:MM:SSZ". The old format was
        // parsed as local time by the frontend, causing UTC numbers to be displayed
        // verbatim (e.g. an email arriving 16:30 CEST showed as 14:30).
        if prev_version < 33 {
            let fixed_tz: usize = conn.execute(
                "UPDATE mails SET date = REPLACE(date, ' ', 'T') || 'Z' \
                 WHERE date GLOB '????-??-?? ??:??:??'",
                [],
            ).unwrap_or(0);
            if fixed_tz > 0 {
                log::info!("DB v33 fix: normalized {} mail dates to RFC3339 UTC (T...Z)", fixed_tz);
            }
        }

        // v27 one-time recovery: clear all Outlook delta_links and Gmail history_ids
        // to force a full re-sync. Recovers mails lost by a buggy v26 migration.
        {
            if prev_version < 27 {
                let cleared_delta: usize = conn.execute(
                    "UPDATE folders SET delta_link = '' WHERE account_id IN \
                     (SELECT id FROM accounts WHERE provider = 'microsoft' AND auth_type = 'oauth')",
                    [],
                ).unwrap_or(0);
                let cleared_gmail: usize = conn.execute(
                    "UPDATE accounts SET gmail_history_id = '' WHERE provider = 'google' AND auth_type = 'oauth'",
                    [],
                ).unwrap_or(0);
                if cleared_delta > 0 || cleared_gmail > 0 {
                    log::info!("DB v27 recovery: cleared {} Outlook delta_links and {} Gmail history_ids — full re-sync will run",
                        cleared_delta, cleared_gmail);
                }
            }
        }

        // v28 one-time fix: scheduled drafts had attachments_json stored in in_reply_to column.
        // Move JSON data from in_reply_to → attachments_json where it looks like JSON.
        {
            if prev_version < 28 {
                let fixed: usize = conn.execute(
                    "UPDATE drafts SET attachments_json = in_reply_to, in_reply_to = '' \
                     WHERE in_reply_to LIKE '[%' AND scheduled_at IS NOT NULL AND scheduled_at != ''",
                    [],
                ).unwrap_or(0);
                if fixed > 0 {
                    log::info!("DB v28 fix: moved attachments from in_reply_to to attachments_json for {} scheduled drafts", fixed);
                }
            }
        }

        // v29 one-time fix: clear Outlook delta_links that were acquired with $select=id.
        // These delta_links cause incremental sync to return messages with only the id field,
        // resulting in empty subject/from/to. Clearing forces re-acquisition with full field list.
        {
            if prev_version < 29 {
                let cleared: usize = conn.execute(
                    "UPDATE folders SET delta_link = '' WHERE delta_link LIKE '%$select=id%' OR delta_link LIKE '%select=id&%'",
                    [],
                ).unwrap_or(0);
                if cleared > 0 {
                    log::info!("DB v29 fix: cleared {} Outlook delta_links with $select=id — will re-acquire with full fields", cleared);
                }
            }
        }

        // v31 fix: re-run the v29 delta_link cleanup for databases that were already at v29+.
        // The v29 fix only ran for prev_version < 29, so databases upgraded past v29 before
        // the fix shipped still have corrupted delta_links with $select=id.
        // Note: delta_links are opaque tokens — we can only match the known broken pattern,
        // NOT check for the presence of field names (they may be encoded in the token).
        {
            if prev_version < 31 {
                let cleared: usize = conn.execute(
                    "UPDATE folders SET delta_link = '' WHERE delta_link LIKE '%$select=id%' OR delta_link LIKE '%select=id&%'",
                    [],
                ).unwrap_or(0);
                if cleared > 0 {
                    log::info!("DB v31 fix: cleared {} corrupted Outlook delta_links with $select=id", cleared);
                }
            }
        }

        // Expensive cleanup: only run when schema version has changed (i.e., on upgrade).
        // On normal startup (prev_version == SCHEMA_VERSION) these are skipped entirely.
        if prev_version < SCHEMA_VERSION {
            // Clean up duplicate API mails (Gmail/Outlook where uid IS NULL).
            // UNIQUE(account_id, folder_id, uid) does NOT prevent NULL uid duplicates.
            // Keep the earliest inserted row per (account_id, folder_id, message_id).
            // Safety: only target mails that actually have a message_id (never group NULLs).
            let api_dupes: usize = conn.execute(
                "DELETE FROM mails WHERE uid IS NULL AND message_id IS NOT NULL AND message_id != '' AND rowid NOT IN (
                    SELECT MIN(rowid) FROM mails WHERE uid IS NULL AND message_id IS NOT NULL AND message_id != ''
                    GROUP BY account_id, folder_id, message_id
                )",
                [],
            ).unwrap_or(0);
            // Also clean duplicates where message_id matches across same folder (catches uid != NULL edge cases too)
            // COALESCE(message_id, id) ensures mails without message_id keep their unique primary key as group key.
            let general_dupes: usize = conn.execute(
                "DELETE FROM mails WHERE rowid NOT IN (
                    SELECT MIN(rowid) FROM mails
                    GROUP BY account_id, folder_id, COALESCE(NULLIF(message_id, ''), id)
                )",
                [],
            ).unwrap_or(0);
            if api_dupes > 0 || general_dupes > 0 {
                log::info!("DB cleanup: removed {} API duplicates + {} general duplicates", api_dupes, general_dupes);
            }
            // Clean up orphaned FTS entries from deleted duplicates
            let fts_orphans: usize = conn.execute(
                "DELETE FROM mails_fts WHERE mail_id NOT IN (SELECT id FROM mails)",
                [],
            ).unwrap_or(0);
            if fts_orphans > 0 {
                log::info!("DB cleanup: removed {} orphaned FTS entries", fts_orphans);
            }
            // Backfill missing FTS entries for mails that were never indexed
            let fts_backfill: usize = conn.execute(
                "INSERT INTO mails_fts (mail_id, subject, from_email, from_name, body_text)
                 SELECT id, subject, from_email, from_name, COALESCE(body_text, '')
                 FROM mails WHERE id NOT IN (SELECT mail_id FROM mails_fts)",
                [],
            ).unwrap_or(0);
            if fts_backfill > 0 {
                log::info!("DB cleanup: backfilled {} missing FTS entries", fts_backfill);
            }
        }
        // Ensure the API dedup index exists (recreate if it failed before due to duplicates).
        // Mails without a Message-ID are excluded: SQLite treats empty strings as equal, so
        // two Message-ID-less mails (drafts) in one folder would collide once uid is NULL.
        let _ = conn.execute_batch("DROP INDEX IF EXISTS idx_mails_gmail_dedup;");
        let _ = conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_gmail_dedup ON mails(account_id, folder_id, message_id) \
             WHERE uid IS NULL AND message_id IS NOT NULL AND message_id != '';"
        );
        // Ensure IMAP UID dedup index exists — the table-level UNIQUE(account_id, folder_id, uid)
        // is not applied to databases created before it was added (CREATE TABLE IF NOT EXISTS
        // does not alter existing tables). This explicit index enforces uniqueness retroactively.
        let _ = conn.execute_batch("DROP INDEX IF EXISTS idx_mails_imap_uid_dedup;");
        let _ = conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_mails_imap_uid_dedup ON mails(account_id, folder_id, uid) WHERE uid IS NOT NULL;"
        );

        // Fix attachments incorrectly marked as inline — many email clients
        // set Content-Disposition: inline for PDFs and other file attachments.
        // Only images with a Content-ID are genuinely inline (embedded in HTML).
        let fixed_inline = conn.execute(
            "UPDATE attachments SET is_inline = 0 WHERE is_inline = 1 AND (mime_type IS NULL OR mime_type NOT LIKE 'image/%')",
            [],
        ).unwrap_or(0);
        if fixed_inline > 0 {
            log::info!("DB cleanup: fixed {} non-image attachments incorrectly marked as inline", fixed_inline);
        }

        // Only bump version AFTER all migrations have run
        conn.pragma_update(None, "user_version", &SCHEMA_VERSION)?;

        Ok(())
    }

}
