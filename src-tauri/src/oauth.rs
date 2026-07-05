//! OAuth 2.0 with PKCE for Google and Microsoft.
//! Desktop "installed app" flow: localhost callback server, no client secret.

use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

struct OAuthConfig {
    client_id: &'static str,
    client_secret: &'static str,  // required by Google, empty for Microsoft (pure PKCE)
    auth_url: &'static str,
    token_url: &'static str,
    scopes: &'static [&'static str],
}

fn google_config() -> OAuthConfig {
    OAuthConfig {
        client_id: "759670840729-n1d702agehiq37v6s91kstfabjlvd4fj.apps.googleusercontent.com",
        // Injected at compile time by build.rs; see README ("Gmail OAuth client secret")
        client_secret: env!("PRUDII_GOOGLE_CLIENT_SECRET"),
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scopes: &[
            "https://mail.google.com/",
            "openid",
            "email",
        ],
    }
}

fn microsoft_config() -> OAuthConfig {
    OAuthConfig {
        client_id: "f36e7ea4-f87e-4e7c-bcc3-7a4764f73f16",
        client_secret: "",  // Microsoft public client — pure PKCE, no secret
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes: &[
            "https://graph.microsoft.com/Mail.ReadWrite",
            "https://graph.microsoft.com/Mail.Send",
            "offline_access",
            "openid",
            "email",
        ],
    }
}

fn get_config(provider: &str) -> Result<OAuthConfig> {
    match provider {
        "google" => Ok(google_config()),
        "microsoft" => Ok(microsoft_config()),
        _ => bail!("Unsupported OAuth provider: {}", provider),
    }
}

fn generate_pkce() -> (String, String) {
    use rand::RngExt;
    let mut rng = rand::rng();
    let mut buf = [0u8; 32];
    rng.fill(&mut buf);

    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    let challenge = {
        let hash = Sha256::digest(verifier.as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
    };

    (verifier, challenge)
}

pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub email: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    email: Option<String>,
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

static TOKEN_CACHE: std::sync::LazyLock<Mutex<HashMap<String, CachedToken>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn get_cached_token(account_id: &str) -> Option<String> {
    let cache = TOKEN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.get(account_id) {
        // Return if still valid with 60s safety margin
        if entry.expires_at > Instant::now() + std::time::Duration::from_secs(60) {
            return Some(entry.access_token.clone());
        }
    }
    None
}

pub fn cache_token(account_id: &str, token: &str, expires_in: u64) {
    let mut cache = TOKEN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.insert(
        account_id.to_string(),
        CachedToken {
            access_token: token.to_string(),
            expires_at: Instant::now() + std::time::Duration::from_secs(expires_in),
        },
    );
}

/// Start the full OAuth flow: open browser, wait for callback, exchange code.
pub async fn start_oauth_flow(provider: &str) -> Result<OAuthTokens> {
    let config = get_config(provider)?;
    let (verifier, challenge) = generate_pkce();

    // Microsoft requires exact redirect_uri match — must use a fixed port
    // that's registered in the Azure app. Google allows any localhost port.
    let listener = if provider == "microsoft" {
        tokio::net::TcpListener::bind("127.0.0.1:8769")
            .await
            .context("Failed to bind localhost:8769 for Microsoft OAuth (is the port in use?)")?
    } else {
        tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .context("Failed to bind localhost listener")?
    };
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://localhost:{}/callback", port);

    // Generate random state for CSRF protection
    let state = {
        use rand::RngExt;
        let mut buf = [0u8; 16];
        rand::rng().fill(&mut buf);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    };

    let scopes = config.scopes.join(" ");
    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        config.auth_url,
        urlencod(&config.client_id),
        urlencod(&redirect_uri),
        urlencod(&scopes),
        urlencod(&challenge),
        urlencod(&state),
    );

    log::info!("OAuth: opening browser for {} on port {}", provider, port);
    if let Err(e) = open::that(&auth_url) {
        log::error!("Failed to open browser: {}", e);
        bail!("Could not open browser for authentication. URL: {}", auth_url);
    }

    let code = wait_for_callback(listener, std::time::Duration::from_secs(120), &state).await?;

    let tokens = exchange_code(&config, &code, &redirect_uri, &verifier).await?;

    Ok(tokens)
}

/// Wait for the OAuth callback on the localhost server.
/// Extracts the `code` query parameter and validates the `state` parameter.
async fn wait_for_callback(
    listener: tokio::net::TcpListener,
    timeout: std::time::Duration,
    expected_state: &str,
) -> Result<String> {
    let accept_result = tokio::time::timeout(timeout, listener.accept()).await;

    let (stream, _addr) = match accept_result {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => bail!("Failed to accept callback connection: {}", e),
        Err(_) => bail!("OAuth timeout: no callback received within {:?}", timeout),
    };

    let mut reader = tokio::io::BufReader::new(stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;

    // Parse: "GET /callback?code=xxx&... HTTP/1.1\r\n"
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default();

    let code = parse_query_param(path, "code");
    let error = parse_query_param(path, "error");
    let callback_state = parse_query_param(path, "state");

    // Validate state parameter to prevent CSRF
    if callback_state.as_deref() != Some(expected_state) {
        log::error!("OAuth CSRF check failed: state mismatch");
        bail!("OAuth security error: state parameter mismatch (possible CSRF attack)");
    }

    let (status, body) = if code.is_some() {
        ("200 OK", "<html><body style=\"font-family:sans-serif;text-align:center;padding:60px\"><h2>Authentication successful!</h2><p>You can close this window and return to Prudii Mail.</p></body></html>")
    } else {
        ("400 Bad Request", "<html><body style=\"font-family:sans-serif;text-align:center;padding:60px\"><h2>Authentication failed</h2><p>Please try again in Prudii Mail.</p></body></html>")
    };

    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body,
    );
    let stream = reader.into_inner();
    let mut write_half = stream;
    let _ = write_half.write_all(response.as_bytes()).await;
    let _ = write_half.flush().await;

    if let Some(err) = error {
        bail!("OAuth error: {}", err);
    }

    code.ok_or_else(|| anyhow::anyhow!("No authorization code in callback"))
}

fn parse_query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let k = parts.next()?;
        let v = parts.next().unwrap_or("");
        if k == key {
            // URL-decode the value (minimal: just + and %XX)
            return Some(urldecod(v));
        }
    }
    None
}

/// Exchange authorization code for access + refresh tokens.
async fn exchange_code(
    config: &OAuthConfig,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OAuthTokens> {
    let client = reqwest::Client::new();
    let mut params = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", config.client_id),
        ("code_verifier", verifier),
    ];
    if !config.client_secret.is_empty() {
        params.push(("client_secret", config.client_secret));
    }
    let resp = client
        .post(config.token_url)
        .form(&params)
        .send()
        .await
        .context("Token exchange request failed")?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        bail!("Token exchange failed: {}", body);
    }

    let token_resp: TokenResponse = resp.json().await.context("Failed to parse token response")?;

    let email = extract_email_from_id_token(token_resp.id_token.as_deref())
        .unwrap_or_default();

    let refresh_token = token_resp.refresh_token.unwrap_or_default();
    if refresh_token.is_empty() {
        bail!("No refresh token received — please revoke app access and try again");
    }

    Ok(OAuthTokens {
        access_token: token_resp.access_token,
        refresh_token,
        expires_in: token_resp.expires_in.unwrap_or(3600),
        email,
    })
}

/// Refresh an expired access token using the refresh token.
pub async fn refresh_access_token(provider: &str, refresh_token: &str) -> Result<OAuthTokens> {
    let config = get_config(provider)?;
    let client = reqwest::Client::new();

    let mut params = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", config.client_id),
    ];
    if !config.client_secret.is_empty() {
        params.push(("client_secret", config.client_secret));
    }
    let resp = client
        .post(config.token_url)
        .form(&params)
        .send()
        .await
        .context("Token refresh request failed")?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        bail!("Token refresh failed: {}", body);
    }

    let token_resp: TokenResponse = resp.json().await.context("Failed to parse refresh response")?;

    let email = extract_email_from_id_token(token_resp.id_token.as_deref())
        .unwrap_or_default();

    Ok(OAuthTokens {
        access_token: token_resp.access_token,
        // Some providers rotate refresh tokens
        refresh_token: token_resp.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_in: token_resp.expires_in.unwrap_or(3600),
        email,
    })
}

/// Extract email from JWT id_token (decode payload without verification — we trust the TLS channel).
fn extract_email_from_id_token(id_token: Option<&str>) -> Option<String> {
    let token = id_token?;
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    // Decode the payload (second segment)
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    let claims: IdTokenClaims = serde_json::from_slice(&payload).ok()?;
    claims.email
}

fn urlencod(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push('%');
                result.push_str(&format!("{:02X}", b));
            }
        }
    }
    result
}

fn urldecod(s: &str) -> String {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00"),
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            result.push(b' ');
            i += 1;
            continue;
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}
