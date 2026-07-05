//! Real network reachability check, independent of OS `navigator.onLine`.
//! Hits a neutral, unauthenticated endpoint with a short timeout so the
//! frontend can confirm actual connectivity rather than trust the OS flag.

use std::sync::LazyLock;
use std::time::Duration;

/// Neutral connectivity endpoint that returns HTTP 204 with an empty body.
const CHECK_URL: &str = "https://connectivitycheck.gstatic.com/generate_204";

static CHECK_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build connectivity HTTP client")
});

/// Returns true if the neutral endpoint is reachable within the timeout.
/// Any error (DNS, connect, timeout) is treated as "offline" → Ok(false).
#[tauri::command]
pub async fn check_connectivity() -> Result<bool, String> {
    match CHECK_HTTP.get(CHECK_URL).send().await {
        Ok(resp) => Ok(resp.status().is_success() || resp.status().as_u16() == 204),
        Err(_) => Ok(false),
    }
}
