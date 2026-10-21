use crate::models::ContactDomain;
use rusqlite::Connection;

/// Every domain the mailbox has exchanged mail with, most frequent first, for the
/// compose window's typo check on recipient domains.
pub fn contact_domains(conn: &Connection) -> rusqlite::Result<Vec<ContactDomain>> {
    let mut stmt = conn.prepare(
        "SELECT LOWER(SUBSTR(email, INSTR(email, '@') + 1)) AS domain, SUM(frequency) AS total
         FROM contacts
         WHERE INSTR(email, '@') > 0
         GROUP BY domain
         ORDER BY total DESC, domain",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ContactDomain {
            domain: r.get(0)?,
            frequency: r.get(1)?,
        })
    })?;
    rows.collect()
}

/// Fold mail rows that arrived since the last scan into the contacts table.
///
/// Recipient autocomplete used to LIKE-scan the whole mails table (senders plus
/// two json_each expansions) on every keystroke; the contacts table keeps that
/// query on a few thousand rows. The high-water mark lives in app_settings so
/// each run only touches new mail; the first run after the migration folds the
/// whole mailbox once, in the background.
pub fn update_contacts_incremental(conn: &Connection) {
    let last: i64 = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'contacts_scan_rowid'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let max: i64 = conn
        .query_row("SELECT COALESCE(MAX(rowid), 0) FROM mails", [], |r| r.get(0))
        .unwrap_or(0);
    if max <= last {
        return;
    }

    let t0 = std::time::Instant::now();

    // Senders
    let _ = conn.execute(
        "INSERT INTO contacts (account_id, email, name, last_seen, frequency)
         SELECT m.account_id, LOWER(m.from_email), COALESCE(m.from_name, ''), MAX(m.date), COUNT(*)
         FROM mails m
         WHERE m.rowid > ?1 AND m.rowid <= ?2 AND m.from_email != ''
         GROUP BY m.account_id, LOWER(m.from_email)
         ON CONFLICT(account_id, email) DO UPDATE SET
           name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
           last_seen = MAX(contacts.last_seen, excluded.last_seen),
           frequency = contacts.frequency + excluded.frequency",
        rusqlite::params![last, max],
    );

    // To / Cc recipients (stored as JSON arrays of {name, email})
    for column in ["to_json", "cc_json"] {
        let sql = format!(
            "INSERT INTO contacts (account_id, email, name, last_seen, frequency)
             SELECT m.account_id, LOWER(json_extract(j.value, '$.email')),
                    COALESCE(json_extract(j.value, '$.name'), ''), MAX(m.date), COUNT(*)
             FROM mails m, json_each(m.{column}) j
             WHERE m.rowid > ?1 AND m.rowid <= ?2
               AND json_extract(j.value, '$.email') IS NOT NULL
               AND json_extract(j.value, '$.email') != ''
             GROUP BY m.account_id, LOWER(json_extract(j.value, '$.email'))
             ON CONFLICT(account_id, email) DO UPDATE SET
               name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
               last_seen = MAX(contacts.last_seen, excluded.last_seen),
               frequency = contacts.frequency + excluded.frequency"
        );
        let _ = conn.execute(&sql, rusqlite::params![last, max]);
    }

    let _ = conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('contacts_scan_rowid', ?1)",
        rusqlite::params![max.to_string()],
    );

    log::debug!(
        "contacts: folded mail rows {}..{} in {:?}",
        last + 1,
        max,
        t0.elapsed()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn groups_contacts_by_domain_most_frequent_first() {
        let db = Database::new(std::env::temp_dir().join(format!("prudii-contacts-{}", uuid::Uuid::new_v4()))).unwrap();
        let conn = db.lock_db();
        for (account, email, frequency) in [
            ("a", "anna@messtex.de", 5),
            ("b", "bernd@Messtex.de", 2),
            ("a", "info@gmail.com", 3),
            ("a", "no-address", 9),
        ] {
            conn.execute(
                "INSERT INTO contacts (account_id, email, frequency) VALUES (?1, ?2, ?3)",
                rusqlite::params![account, email, frequency],
            )
            .unwrap();
        }
        let domains: Vec<(String, i64)> = contact_domains(&conn).unwrap().into_iter().map(|d| (d.domain, d.frequency)).collect();
        assert_eq!(domains, vec![("messtex.de".to_string(), 7), ("gmail.com".to_string(), 3)]);
    }
}
