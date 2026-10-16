//! Read-only calendar subscriptions: link handling, fetching and scheduling.

use chrono::{DateTime, Duration, Utc};
use std::sync::LazyLock;
use std::time::Duration as StdDuration;

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
}
