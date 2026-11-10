//! The inbox can leave starred mails to the Starred view (setting `hide_starred_in_inbox`).

use rusqlite::Connection;

pub const SETTING: &str = "hide_starred_in_inbox";

pub fn hides_starred(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [SETTING], |row| row.get::<_, String>(0))
        .map(|value| value == "true" || value == "1")
        .unwrap_or(false)
}

/// Condition for inbox lists and counters. The "starred" pill asks for exactly these mails, so it still gets them.
pub fn star_clause(conn: &Connection, filter: Option<&str>, prefix: &str) -> String {
    if filter == Some("starred") || !hides_starred(conn) {
        String::new()
    } else {
        format!(" AND {}is_starred = 0", prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categorize::store::category_counts;
    use crate::commands::accounts::list_folders_inner;
    use crate::commands::mails::list_mails_inner;
    use crate::db::Database;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};

    struct Mailbox {
        db: Database,
        account: String,
        inbox: String,
        archive: String,
    }

    fn mailbox() -> Mailbox {
        let db = temp_db();
        let (account, inbox, archive) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "anna@studio-halde.example");
            let inbox = seed_folder(&conn, &account, "inbox");
            let archive = seed_folder(&conn, &account, "archive");
            for (folder, subject, starred) in [(&inbox, "plain", 0), (&inbox, "starred", 1), (&archive, "filed", 1)] {
                let id = seed_mail(&conn, &SeedMail { account_id: &account, folder_id: folder, from_email: "post@kunde.example", subject, ..Default::default() });
                conn.execute("UPDATE mails SET is_starred = ?1, category = 'important' WHERE id = ?2", rusqlite::params![starred, id]).unwrap();
            }
            conn.execute("UPDATE folders SET unread_count = 2 WHERE id = ?1", [&inbox]).unwrap();
            conn.execute("UPDATE folders SET unread_count = 1 WHERE id = ?1", [&archive]).unwrap();
            (account, inbox, archive)
        };
        Mailbox { db, account, inbox, archive }
    }

    fn hide(m: &Mailbox) {
        m.db.lock_db().execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, 'true')", [SETTING]).unwrap();
    }

    fn subjects(m: &Mailbox, folder: &str, filter: Option<&str>) -> Vec<String> {
        let conn = m.db.lock_db();
        let mut subjects: Vec<String> = list_mails_inner(&conn, folder, None, None, &filter.map(str::to_string), None)
            .unwrap()
            .into_iter()
            .map(|mail| mail.subject)
            .collect();
        subjects.sort();
        subjects
    }

    fn unread(m: &Mailbox, folder: &str) -> i64 {
        let conn = m.db.lock_db();
        list_folders_inner(&conn, &m.account).unwrap().into_iter().find(|f| f.id == folder).unwrap().unread_count as i64
    }

    #[test]
    fn the_inbox_lists_starred_mails_by_default() {
        let m = mailbox();
        assert_eq!(subjects(&m, &m.inbox, None), vec!["plain", "starred"]);
    }

    #[test]
    fn the_inbox_leaves_starred_mails_out_when_asked() {
        let m = mailbox();
        hide(&m);
        assert_eq!(subjects(&m, &m.inbox, None), vec!["plain"]);
    }

    #[test]
    fn other_folders_keep_their_starred_mails() {
        let m = mailbox();
        hide(&m);
        assert_eq!(subjects(&m, &m.archive, None), vec!["filed"]);
    }

    #[test]
    fn the_starred_pill_still_shows_them_in_the_inbox() {
        let m = mailbox();
        hide(&m);
        assert_eq!(subjects(&m, &m.inbox, Some("starred")), vec!["starred"]);
    }

    #[test]
    fn the_inbox_counter_follows_what_the_inbox_shows() {
        let m = mailbox();
        assert_eq!(unread(&m, &m.inbox), 2);
        hide(&m);
        assert_eq!(unread(&m, &m.inbox), 1);
        assert_eq!(unread(&m, &m.archive), 1);
    }

    #[test]
    fn the_category_counters_follow_too() {
        let m = mailbox();
        let count = |m: &Mailbox| category_counts(&m.db.lock_db()).unwrap().iter().map(|c| c.unread as i64).sum::<i64>();
        assert_eq!(count(&m), 2);
        hide(&m);
        assert_eq!(count(&m), 1);
    }

    #[test]
    fn the_condition_carries_the_table_prefix() {
        let m = mailbox();
        let conn = m.db.lock_db();
        assert_eq!(star_clause(&conn, None, "m."), "");
        conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, 'true')", [SETTING]).unwrap();
        assert_eq!(star_clause(&conn, None, "m."), " AND m.is_starred = 0");
        assert_eq!(star_clause(&conn, Some("unread"), ""), " AND is_starred = 0");
        assert_eq!(star_clause(&conn, Some("starred"), "m."), "");
    }
}
