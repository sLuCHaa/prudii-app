//! Read-only calendar subscriptions: link handling, fetching and scheduling.

use super::ical::parse_calendar;
use super::store::{fetch_calendar, is_valid_color, mirror_ics_impl, DEFAULT_COLOR};
use super::tz::{fmt_utc, parse_utc};
use super::{Calendar, FeedMeta, SubscribeResult, REFRESH_CHOICES, SUBSCRIPTION};
use crate::db::Database;
use chrono::{DateTime, Duration, Utc};
use rusqlite::params;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, Manager};

pub const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

/// `webcal://` is https in disguise; plain http is refused.
pub fn normalize_feed_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = ["webcals://", "webcal://", "https://"].iter().find_map(|p| lower.starts_with(p).then(|| &trimmed[p.len()..]));
    let Some(rest) = rest else {
        let key = if lower.starts_with("http://") { "calendar.errors.httpsOnly" } else { "calendar.errors.invalidUrl" };
        return Err(key.into());
    };
    let url = reqwest::Url::parse(&format!("https://{}", rest)).map_err(|_| "calendar.errors.invalidUrl".to_string())?;
    if url.host_str().is_none_or(str::is_empty) {
        return Err("calendar.errors.invalidUrl".into());
    }
    Ok(url.to_string())
}

#[derive(Debug, PartialEq)]
pub enum StatusClass {
    Body,
    NotModified,
}

pub fn classify_status(status: u16) -> Result<StatusClass, String> {
    match status {
        304 => Ok(StatusClass::NotModified),
        200..=299 => Ok(StatusClass::Body),
        401 | 403 => Err("calendar.errors.feedForbidden".into()),
        404 | 410 => Err("calendar.errors.feedNotFound".into()),
        _ => Err("calendar.errors.feedUnreachable".into()),
    }
}

#[derive(Debug, PartialEq)]
pub enum FetchOutcome {
    NotModified,
    Body { text: String, etag: Option<String> },
}

pub fn build_feed_client(timeout: StdDuration) -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS || attempt.url().scheme() != "https" {
            attempt.error("refusing an insecure or endless redirect")
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(policy)
        .user_agent(concat!("Prudii/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build the calendar feed HTTP client")
}

static FEED_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| build_feed_client(StdDuration::from_secs(30)));

pub fn feed_client() -> &'static reqwest::Client {
    &FEED_CLIENT
}

pub async fn fetch_feed(client: &reqwest::Client, url: &str, etag: Option<&str>) -> Result<FetchOutcome, String> {
    let offline = |_: reqwest::Error| "calendar.errors.feedUnreachable".to_string();
    let mut request = client.get(url);
    if let Some(tag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    let mut response = request.send().await.map_err(offline)?;
    if classify_status(response.status().as_u16())? == StatusClass::NotModified {
        return Ok(FetchOutcome::NotModified);
    }
    if response.content_length().is_some_and(|n| n > MAX_FEED_BYTES as u64) {
        return Err("calendar.errors.fileTooLarge".into());
    }
    let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(offline)? {
        if body.len() + chunk.len() > MAX_FEED_BYTES {
            return Err("calendar.errors.fileTooLarge".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(FetchOutcome::Body { text: String::from_utf8_lossy(&body).into_owned(), etag })
}

pub fn content_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

/// The feed's own name, else the host without `www.`.
pub fn feed_name(calendar_name: Option<&str>, url: &str) -> String {
    if let Some(name) = calendar_name.map(str::trim).filter(|n| !n.is_empty()) {
        return name.chars().take(100).collect();
    }
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_else(|| "Calendar".into())
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionState {
    pub id: String,
    pub refresh_minutes: i64,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub failing: bool,
}

/// Ids whose interval has passed; a failing feed retries at least hourly.
pub fn due_subscriptions(subs: &[SubscriptionState], now: DateTime<Utc>) -> Vec<String> {
    subs.iter()
        .filter(|s| {
            let every = if s.failing { s.refresh_minutes.min(60) } else { s.refresh_minutes };
            s.last_attempt_at.is_none_or(|at| now - at >= Duration::minutes(every))
        })
        .map(|s| s.id.clone())
        .collect()
}

/// Where subscription links live: the keyring in the app, memory in tests.
pub trait LinkStore {
    fn get(&self, calendar_id: &str) -> Result<String, String>;
    fn set(&self, calendar_id: &str, url: &str) -> Result<(), String>;
    fn delete(&self, calendar_id: &str);
}

pub struct KeyringLinks;

impl LinkStore for KeyringLinks {
    fn get(&self, calendar_id: &str) -> Result<String, String> {
        crate::credentials::get_calendar_link(calendar_id).map_err(|e| e.to_string())
    }

    fn set(&self, calendar_id: &str, url: &str) -> Result<(), String> {
        crate::credentials::store_calendar_link(calendar_id, url).map_err(|e| e.to_string())
    }

    fn delete(&self, calendar_id: &str) {
        crate::credentials::delete_calendar_link(calendar_id)
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryLinks {
    pub links: Mutex<std::collections::HashMap<String, String>>,
    pub fail_writes: bool,
}

#[cfg(test)]
impl LinkStore for MemoryLinks {
    fn get(&self, calendar_id: &str) -> Result<String, String> {
        self.links.lock().unwrap().get(calendar_id).cloned().ok_or_else(|| "missing".to_string())
    }

    fn set(&self, calendar_id: &str, url: &str) -> Result<(), String> {
        if self.fail_writes {
            return Err("keyring unavailable".into());
        }
        self.links.lock().unwrap().insert(calendar_id.to_string(), url.to_string());
        Ok(())
    }

    fn delete(&self, calendar_id: &str) {
        self.links.lock().unwrap().remove(calendar_id);
    }
}

static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// One fetch per feed at a time, whether from the tick or "Refresh now".
struct InFlight(String);

impl InFlight {
    fn claim(id: &str) -> Option<InFlight> {
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string()).then(|| InFlight(id.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Stored ETag and content hash; errors unless `id` is a subscription.
fn feed_state(db: &Database, id: &str) -> Result<(Option<String>, Option<String>), String> {
    let conn = db.lock_db();
    let (etag, hash, source): (Option<String>, Option<String>, String) = conn
        .query_row("SELECT sync_token, content_hash, source FROM calendars WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|_| "calendar.errors.notFound".to_string())?;
    if source != SUBSCRIPTION {
        return Err("calendar.errors.notFound".into());
    }
    Ok((etag, hash))
}

pub(crate) fn ensure_subscription(db: &Database, id: &str) -> Result<(), String> {
    feed_state(db, id).map(|_| ())
}

pub(crate) fn subscription_states(db: &Database) -> Result<Vec<SubscriptionState>, String> {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare("SELECT id, refresh_minutes, last_attempt_at, last_error IS NOT NULL FROM calendars WHERE source = ?1")
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![SUBSCRIPTION], |r| {
            Ok(SubscriptionState {
                id: r.get(0)?,
                refresh_minutes: r.get::<_, Option<i64>>(1)?.unwrap_or(60),
                last_attempt_at: r.get::<_, Option<String>>(2)?.as_deref().and_then(parse_utc),
                failing: r.get(3)?,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err);
    rows
}

fn record_success(db: &Database, id: &str, etag: Option<&str>) -> Result<(), String> {
    let now = fmt_utc(Utc::now());
    db.lock_db()
        .execute(
            "UPDATE calendars SET last_attempt_at = ?1, last_synced_at = ?1, last_error = NULL, sync_token = COALESCE(?2, sync_token) WHERE id = ?3",
            params![now, etag, id],
        )
        .map(|_| ())
        .map_err(db_err)
}

fn record_failure(db: &Database, id: &str, key: &str) -> Result<(), String> {
    db.lock_db()
        .execute("UPDATE calendars SET last_attempt_at = ?1, last_error = ?2 WHERE id = ?3", params![fmt_utc(Utc::now()), key, id])
        .map(|_| ())
        .map_err(db_err)
}

fn insert_subscription(db: &Database, name: &str, color: &str, refresh_minutes: i64) -> Result<Calendar, String> {
    let color = if is_valid_color(color) { color } else { DEFAULT_COLOR };
    let conn = db.lock_db();
    let next: f64 = conn.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM calendars", [], |r| r.get(0)).map_err(db_err)?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO calendars (id, name, color, is_default, sort_order, source, refresh_minutes) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)",
        params![id, name, color, next, SUBSCRIPTION, refresh_minutes],
    )
    .map_err(db_err)?;
    fetch_calendar(&conn, &id)
}

fn remove_subscription(db: &Database, links: &(dyn LinkStore + Sync), id: &str) {
    let _ = db.lock_db().execute("DELETE FROM calendars WHERE id = ?1", params![id]);
    links.delete(id);
}

async fn fetch_body(client: &reqwest::Client, url: &str) -> Result<(String, Option<String>), String> {
    match fetch_feed(client, url, None).await? {
        FetchOutcome::Body { text, etag } => Ok((text, etag)),
        FetchOutcome::NotModified => Err("calendar.errors.feedUnreachable".into()),
    }
}

/// `url` must already be normalized; the command does that.
pub(crate) async fn subscribe_impl(
    db: &Database,
    links: &(dyn LinkStore + Sync),
    client: &reqwest::Client,
    url: &str,
    color: &str,
    refresh_minutes: i64,
) -> Result<SubscribeResult, String> {
    if !REFRESH_CHOICES.contains(&refresh_minutes) {
        return Err("calendar.errors.invalidSettings".into());
    }
    let (text, etag) = fetch_body(client, url).await?;
    let parsed = parse_calendar(&text);
    if !parsed.has_calendar {
        return Err("calendar.errors.notCalendar".into());
    }
    let calendar = insert_subscription(db, &feed_name(parsed.name.as_deref(), url), color, refresh_minutes)?;
    if let Err(e) = links.set(&calendar.id, url) {
        log::warn!("storing a calendar subscription link failed: {}", e);
        remove_subscription(db, links, &calendar.id);
        return Err("calendar.errors.linkStoreFailed".into());
    }
    let mirrored = match mirror_ics_impl(db, &calendar.id, &parsed, &FeedMeta { etag, hash: content_hash(&text) }) {
        Ok(r) => r,
        Err(e) => {
            remove_subscription(db, links, &calendar.id);
            return Err(e);
        }
    };
    let calendar = fetch_calendar(&db.lock_db(), &calendar.id)?;
    Ok(SubscribeResult { calendar, events: mirrored.imported + mirrored.updated })
}

async fn sync_once(
    db: &Database,
    links: &(dyn LinkStore + Sync),
    client: &reqwest::Client,
    id: &str,
    etag: Option<&str>,
    hash: Option<&str>,
) -> Result<(), String> {
    let url = links.get(id).map_err(|_| "calendar.errors.linkMissing".to_string())?;
    match fetch_feed(client, &url, etag).await? {
        FetchOutcome::NotModified => record_success(db, id, None),
        FetchOutcome::Body { text, etag } => {
            let digest = content_hash(&text);
            if hash == Some(digest.as_str()) {
                return record_success(db, id, etag.as_deref());
            }
            mirror_ics_impl(db, id, &parse_calendar(&text), &FeedMeta { etag, hash: digest }).map(|_| ())
        }
    }
}

/// Fetches now regardless of the interval; a failure is kept on the calendar and returned.
pub(crate) async fn refresh_impl(db: &Database, links: &(dyn LinkStore + Sync), client: &reqwest::Client, id: &str) -> Result<Calendar, String> {
    let Some(_claim) = InFlight::claim(id) else {
        return fetch_calendar(&db.lock_db(), id);
    };
    let (etag, hash) = feed_state(db, id)?;
    if let Err(key) = sync_once(db, links, client, id, etag.as_deref(), hash.as_deref()).await {
        record_failure(db, id, &key)?;
        return Err(key);
    }
    fetch_calendar(&db.lock_db(), id)
}

/// `url` must already be normalized; the command does that.
pub(crate) async fn update_url_impl(
    db: &Database,
    links: &(dyn LinkStore + Sync),
    client: &reqwest::Client,
    id: &str,
    url: &str,
) -> Result<Calendar, String> {
    ensure_subscription(db, id)?;
    let (text, etag) = fetch_body(client, url).await?;
    let parsed = parse_calendar(&text);
    if !parsed.has_calendar {
        return Err("calendar.errors.notCalendar".into());
    }
    links.set(id, url).map_err(|e| {
        log::warn!("storing a calendar subscription link failed: {}", e);
        "calendar.errors.linkStoreFailed".to_string()
    })?;
    mirror_ics_impl(db, id, &parsed, &FeedMeta { etag, hash: content_hash(&text) })?;
    fetch_calendar(&db.lock_db(), id)
}

/// Spawned from the 60-second loop so slow feeds never delay reminders.
pub async fn run_due_subscriptions(app: AppHandle) {
    let db = app.state::<Database>();
    let states = match subscription_states(&db) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("calendar subscription check failed: {}", e);
            return;
        }
    };
    let due = due_subscriptions(&states, Utc::now());
    if due.is_empty() {
        return;
    }
    for id in &due {
        if let Err(e) = refresh_impl(&db, &KeyringLinks, feed_client(), id).await {
            log::warn!("calendar subscription {} not refreshed: {}", id, e);
        }
    }
    let _ = app.emit("calendar-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    pub(crate) const FEED: &str = "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nUID:one@test\r\n\
DTSTART:20261015T090000Z\r\nDTEND:20261015T100000Z\r\nSUMMARY:One\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:two@test\r\n\
DTSTART:20261016T090000Z\r\nDTEND:20261016T100000Z\r\nSUMMARY:Two\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    /// Serves one canned response per connection, in order, and records each request head.
    pub(crate) fn serve(responses: Vec<String>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                log.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (base, seen)
    }

    pub(crate) fn ok(body: &str, etag: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/calendar\r\nETag: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            etag,
            body.len(),
            body
        )
    }

    pub(crate) const NOT_MODIFIED: &str = "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n";

    fn client() -> reqwest::Client {
        build_feed_client(StdDuration::from_secs(5))
    }

    #[test]
    fn webcal_links_become_https_and_plain_http_is_refused() {
        assert_eq!(
            normalize_feed_url("webcal://p01-caldav.icloud.com/published/2/abc").unwrap(),
            "https://p01-caldav.icloud.com/published/2/abc"
        );
        assert_eq!(normalize_feed_url("  WEBCALS://Example.com/cal.ics ").unwrap(), "https://example.com/cal.ics");
        let google = "https://calendar.google.com/calendar/ical/me%40example.com/private-1a2b/basic.ics";
        assert_eq!(normalize_feed_url(google).unwrap(), google);
        assert_eq!(normalize_feed_url("http://example.com/a.ics").unwrap_err(), "calendar.errors.httpsOnly");
        for bad in ["ftp://example.com/a.ics", "just text", "https://", ""] {
            assert_eq!(normalize_feed_url(bad).unwrap_err(), "calendar.errors.invalidUrl", "{}", bad);
        }
    }

    #[test]
    fn statuses_map_to_outcomes_and_keys() {
        assert_eq!(classify_status(200), Ok(StatusClass::Body));
        assert_eq!(classify_status(203), Ok(StatusClass::Body));
        assert_eq!(classify_status(304), Ok(StatusClass::NotModified));
        assert_eq!(classify_status(401).unwrap_err(), "calendar.errors.feedForbidden");
        assert_eq!(classify_status(403).unwrap_err(), "calendar.errors.feedForbidden");
        assert_eq!(classify_status(404).unwrap_err(), "calendar.errors.feedNotFound");
        assert_eq!(classify_status(410).unwrap_err(), "calendar.errors.feedNotFound");
        assert_eq!(classify_status(500).unwrap_err(), "calendar.errors.feedUnreachable");
    }

    #[test]
    fn names_come_from_the_feed_or_the_host() {
        assert_eq!(feed_name(Some("  Team  "), "https://x.example.com/a.ics"), "Team");
        let long = "n".repeat(150);
        assert_eq!(feed_name(Some(long.as_str()), "https://x.example.com/a.ics").chars().count(), 100);
        assert_eq!(feed_name(None, "https://www.example.com/a.ics"), "example.com");
        assert_eq!(feed_name(Some("   "), "https://cal.example.org/a.ics"), "cal.example.org");
    }

    #[test]
    fn due_feeds_follow_their_interval_and_failures_retry_hourly() {
        let now = DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z").unwrap().with_timezone(&Utc);
        let sub = |id: &str, every: i64, ago: Option<i64>, failing: bool| SubscriptionState {
            id: id.into(),
            refresh_minutes: every,
            last_attempt_at: ago.map(|m| now - Duration::minutes(m)),
            failing,
        };
        let subs = vec![
            sub("never", 60, None, false),
            sub("fresh", 60, Some(30), false),
            sub("stale", 60, Some(60), false),
            sub("daily-ok", 1440, Some(120), false),
            sub("daily-failing", 1440, Some(61), true),
        ];
        assert_eq!(due_subscriptions(&subs, now), vec!["never", "stale", "daily-failing"]);
    }

    #[test]
    fn content_hashes_are_hex_sha256() {
        assert_eq!(content_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[tokio::test]
    async fn fetches_bodies_and_honours_etags() {
        let (base, seen) = serve(vec![ok(FEED, "\"v1\""), NOT_MODIFIED.to_string()]);
        let url = format!("{}/cal.ics", base);
        let first = fetch_feed(&client(), &url, None).await.unwrap();
        assert_eq!(first, FetchOutcome::Body { text: FEED.to_string(), etag: Some("\"v1\"".into()) });
        assert_eq!(fetch_feed(&client(), &url, Some("\"v1\"")).await.unwrap(), FetchOutcome::NotModified);
        let heads = seen.lock().unwrap();
        assert!(heads[0].contains("user-agent: prudii/"), "{}", heads[0]);
        assert!(heads[1].contains("if-none-match: \"v1\""), "{}", heads[1]);
    }

    #[tokio::test]
    async fn redirects_to_plain_http_are_refused() {
        let (base, target_seen) = serve(vec![ok(FEED, "\"v1\"")]);
        let (redirector, _) = serve(vec![format!("HTTP/1.1 302 Found\r\nLocation: {}/cal.ics\r\nConnection: close\r\n\r\n", base)]);
        let err = fetch_feed(&client(), &format!("{}/start", redirector), None).await.unwrap_err();
        assert_eq!(err, "calendar.errors.feedUnreachable");
        assert!(target_seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn oversized_feeds_are_rejected() {
        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\nBEGIN", MAX_FEED_BYTES + 1);
        let (base, _) = serve(vec![head]);
        assert_eq!(fetch_feed(&client(), &format!("{}/big.ics", base), None).await.unwrap_err(), "calendar.errors.fileTooLarge");
    }

    #[tokio::test]
    async fn error_statuses_and_dead_hosts_return_keys() {
        let (base, _) = serve(vec!["HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()]);
        assert_eq!(fetch_feed(&client(), &format!("{}/gone.ics", base), None).await.unwrap_err(), "calendar.errors.feedNotFound");
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let dead = format!("http://127.0.0.1:{}/cal.ics", port);
        assert_eq!(fetch_feed(&client(), &dead, None).await.unwrap_err(), "calendar.errors.feedUnreachable");
    }

    use crate::calendar::store::{list_calendars_impl, list_occurrences_impl};
    use crate::db::Database;

    fn temp_db() -> Database {
        let db = Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap();
        list_calendars_impl(&db, "Mine").unwrap();
        db
    }

    fn titles(db: &Database, calendar_id: &str) -> Vec<String> {
        let mut t: Vec<String> = list_occurrences_impl(db, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", Some(vec![calendar_id.to_string()]))
            .unwrap()
            .into_iter()
            .map(|o| o.title)
            .collect();
        t.sort();
        t
    }

    fn subscriptions(db: &Database) -> Vec<crate::calendar::Calendar> {
        list_calendars_impl(db, "Mine").unwrap().into_iter().filter(|c| c.read_only).collect()
    }

    #[tokio::test]
    async fn subscribing_mirrors_the_feed_and_stores_the_link() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, _) = serve(vec![ok(FEED, "\"v1\"")]);
        let url = format!("{}/team.ics", base);
        let result = subscribe_impl(&db, &links, &client(), &url, "#ef4444", 360).await.unwrap();
        assert_eq!(result.events, 2);
        assert_eq!(result.calendar.name, "Team");
        assert_eq!(result.calendar.color, "#ef4444");
        assert_eq!(result.calendar.refresh_minutes, Some(360));
        assert!(result.calendar.read_only && !result.calendar.is_default);
        assert_eq!(links.get(&result.calendar.id).unwrap(), url);
        assert_eq!(titles(&db, &result.calendar.id), vec!["One", "Two"]);
    }

    #[tokio::test]
    async fn feeds_with_a_byte_order_mark_subscribe() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, _) = serve(vec![ok(&format!("\u{feff}{}", FEED), "\"v1\"")]);
        let result = subscribe_impl(&db, &links, &client(), &format!("{}/team.ics", base), "#ef4444", 60).await.unwrap();
        assert_eq!(result.events, 2);
    }

    #[tokio::test]
    async fn failed_subscriptions_leave_nothing_behind() {
        let db = temp_db();
        let (base, _) = serve(vec![
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            ok("<html>Sign in</html>", "\"x\""),
            ok(FEED, "\"v1\""),
        ]);
        let links = MemoryLinks::default();
        let url = format!("{}/cal.ics", base);
        assert_eq!(subscribe_impl(&db, &links, &client(), &url, "#ef4444", 60).await.unwrap_err(), "calendar.errors.feedNotFound");
        assert_eq!(subscribe_impl(&db, &links, &client(), &url, "#ef4444", 60).await.unwrap_err(), "calendar.errors.notCalendar");
        let failing = MemoryLinks { fail_writes: true, ..Default::default() };
        assert_eq!(subscribe_impl(&db, &failing, &client(), &url, "#ef4444", 60).await.unwrap_err(), "calendar.errors.linkStoreFailed");
        assert!(subscriptions(&db).is_empty());
        assert_eq!(subscribe_impl(&db, &links, &client(), &url, "#ef4444", 7).await.unwrap_err(), "calendar.errors.invalidSettings");
    }

    #[tokio::test]
    async fn html_pages_keep_the_mirrored_events() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, _) = serve(vec![ok(FEED, "\"v1\""), ok("<html>Sign in</html>", "\"v2\"")]);
        let sub = subscribe_impl(&db, &links, &client(), &format!("{}/cal.ics", base), "#ef4444", 60).await.unwrap().calendar;
        assert_eq!(refresh_impl(&db, &links, &client(), &sub.id).await.unwrap_err(), "calendar.errors.notCalendar");
        assert_eq!(titles(&db, &sub.id), vec!["One", "Two"]);
        let after = subscriptions(&db).remove(0);
        assert_eq!(after.last_error.as_deref(), Some("calendar.errors.notCalendar"));
        assert!(after.last_synced_at.is_some());
    }

    #[tokio::test]
    async fn not_modified_and_unchanged_feeds_only_touch_the_status() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, seen) = serve(vec![ok(FEED, "\"v1\""), NOT_MODIFIED.to_string(), ok(FEED, "\"v2\"")]);
        let sub = subscribe_impl(&db, &links, &client(), &format!("{}/cal.ics", base), "#ef4444", 60).await.unwrap().calendar;
        refresh_impl(&db, &links, &client(), &sub.id).await.unwrap();
        refresh_impl(&db, &links, &client(), &sub.id).await.unwrap();
        assert!(seen.lock().unwrap()[1].contains("if-none-match: \"v1\""));
        let etag: String = db.lock_db().query_row("SELECT sync_token FROM calendars WHERE id = ?1", [&sub.id], |r| r.get(0)).unwrap();
        assert_eq!(etag, "\"v2\"");
        assert_eq!(titles(&db, &sub.id), vec!["One", "Two"]);
    }

    #[tokio::test]
    async fn a_refresh_already_running_is_not_started_twice() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, _) = serve(vec![ok(FEED, "\"v1\"")]);
        let sub = subscribe_impl(&db, &links, &client(), &format!("{}/cal.ics", base), "#ef4444", 60).await.unwrap().calendar;
        let held = InFlight::claim(&sub.id).unwrap();
        let unchanged = refresh_impl(&db, &links, &client(), &sub.id).await.unwrap();
        assert_eq!(unchanged.last_synced_at, sub.last_synced_at, "no second fetch while one runs");
        drop(held);
        assert!(InFlight::claim(&sub.id).is_some());
    }

    #[tokio::test]
    async fn a_missing_link_is_reported_on_the_calendar() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, _) = serve(vec![ok(FEED, "\"v1\"")]);
        let sub = subscribe_impl(&db, &links, &client(), &format!("{}/cal.ics", base), "#ef4444", 60).await.unwrap().calendar;
        let empty = MemoryLinks::default();
        assert_eq!(refresh_impl(&db, &empty, &client(), &sub.id).await.unwrap_err(), "calendar.errors.linkMissing");
        assert_eq!(subscriptions(&db).remove(0).last_error.as_deref(), Some("calendar.errors.linkMissing"));
    }

    #[tokio::test]
    async fn changing_the_link_switches_the_feed() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let other = FEED.replace("SUMMARY:One", "SUMMARY:Uno").replace("UID:two@test", "UID:three@test").replace("SUMMARY:Two", "SUMMARY:Tres");
        let (base, _) = serve(vec![ok(FEED, "\"v1\""), ok(&other, "\"w1\"")]);
        let sub = subscribe_impl(&db, &links, &client(), &format!("{}/a.ics", base), "#ef4444", 60).await.unwrap().calendar;
        let new_url = format!("{}/b.ics", base);
        update_url_impl(&db, &links, &client(), &sub.id, &new_url).await.unwrap();
        assert_eq!(links.get(&sub.id).unwrap(), new_url);
        assert_eq!(titles(&db, &sub.id), vec!["Tres", "Uno"]);
    }

    #[tokio::test]
    async fn states_list_only_subscriptions() {
        let db = temp_db();
        let links = MemoryLinks::default();
        let (base, _) = serve(vec![ok(FEED, "\"v1\"")]);
        let sub = subscribe_impl(&db, &links, &client(), &format!("{}/cal.ics", base), "#ef4444", 360).await.unwrap().calendar;
        let states = subscription_states(&db).unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!((states[0].id.as_str(), states[0].refresh_minutes, states[0].failing), (sub.id.as_str(), 360, false));
        assert!(states[0].last_attempt_at.is_some());
        assert!(ensure_subscription(&db, &sub.id).is_ok());
        let local = list_calendars_impl(&db, "Mine").unwrap().into_iter().find(|c| !c.read_only).unwrap();
        assert!(ensure_subscription(&db, &local.id).is_err());
    }
}
