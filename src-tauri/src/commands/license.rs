use crate::db::Database;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::State;

const PB_URL: &str = "https://api.prudii.com";

/// Ed25519 public key (hex) used to verify server-signed license responses.
/// The matching PRIVATE key lives only on the license server and is never
/// shipped; a public key cannot forge signatures, so this is safe to publish.
const LICENSE_PUBLIC_KEY_HEX: &str =
    "fa2c74ad9c9fa5293ab2221fb038ae0a4e00fa870bb34fcc2d2d1d792473475f";

fn license_public_key() -> Option<VerifyingKey> {
    let bytes = hex_to_bytes(LICENSE_PUBLIC_KEY_HEX)?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub user_email: String,
    pub plan: String,
    pub license_key: String,
    pub valid_until: String,
    pub features: Vec<String>,
    pub last_verified: String,
    pub device_id: String,
    pub logged_in: bool,
    /// True when the user is still known locally (email cached) but the auth token
    /// is gone — it expired or was rejected by a reachable server. This is a SOFT
    /// hint only: paid features stay available under the grace period (server-signed
    /// `valid_until` + 30-day staleness), and the UI shows a gentle "sign in again to
    /// keep your license in sync" prompt. It does NOT lock features on its own.
    #[serde(default)]
    pub session_expired: bool,
}

#[derive(Debug, Deserialize)]
struct PbAuthResponse {
    token: String,
    record: PbUserRecord,
}

#[derive(Debug, Deserialize)]
struct PbUserRecord {
    email: String,
}

#[derive(Debug, Deserialize)]
struct VerifyResponse {
    #[allow(dead_code)]
    valid: bool,
    plan: String,
    features: Vec<String>,
    valid_until: String,
    license_key: String,
    signature: String,
    verified_at: String,
}

#[derive(Debug, Deserialize)]
struct ActivateResponse {
    #[allow(dead_code)]
    valid: bool,
    plan: String,
    features: Vec<String>,
    valid_until: String,
    license_key: String,
    signature: String,
    auth_token: String,
    user_email: String,
    verified_at: String,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Decode a hex string to bytes. Returns None on odd length or non-hex input.
fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Verify the Ed25519 signature the server produced over
/// JSON.stringify({valid: true, plan, valid_until, verified_at}).
fn verify_signature(plan: &str, valid_until: &str, verified_at: &str, signature: &str) -> bool {
    match license_public_key() {
        Some(vk) => verify_with_key(&vk, plan, valid_until, verified_at, signature),
        None => {
            log::error!("[license] embedded license public key is invalid");
            false
        }
    }
}

fn verify_with_key(
    vk: &VerifyingKey,
    plan: &str,
    valid_until: &str,
    verified_at: &str,
    signature: &str,
) -> bool {
    if signature.is_empty() {
        return false;
    }

    // Byte-identical to the server's JS: JSON.stringify({valid: true, plan, valid_until, verified_at})
    let payload = format!(
        r#"{{"valid":true,"plan":"{}","valid_until":"{}","verified_at":"{}"}}"#,
        plan, valid_until, verified_at
    );

    let Some(sig_bytes) = hex_to_bytes(signature) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes) else {
        return false;
    };
    vk.verify_strict(payload.as_bytes(), &Signature::from_bytes(&sig_arr))
        .is_ok()
}

/// Verify a cached license's HMAC signature (includes last_verified = verified_at).
/// Returns false if the cache has been tampered with.
fn verify_cache_integrity(conn: &rusqlite::Connection) -> bool {
    let result: Result<(String, String, String, String), _> = conn.query_row(
        "SELECT plan, valid_until, signature, last_verified FROM license_cache WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    );

    match result {
        Ok((plan, valid_until, sig, last_verified)) => {
            if plan == "free" && sig.is_empty() {
                return true; // Free plan doesn't need a signature
            }
            verify_signature(&plan, &valid_until, &last_verified, &sig)
        }
        Err(_) => true, // No cache yet
    }
}

/// Get a stable device ID using SHA-256 of a platform-specific machine identifier.
/// - Windows: Registry MachineGuid
/// - macOS: IOPlatformUUID from ioreg
/// - Linux: /etc/machine-id
fn compute_device_id() -> String {
    use sha2::Digest;

    let raw_id = get_raw_machine_id();
    if raw_id.is_empty() {
        log::warn!("[license] Could not determine machine ID, using hostname fallback");
        let hostname = get_device_name();
        let salted = format!("prudii-device-v1:hostname:{}", hostname);
        let hash = Sha256::digest(salted.as_bytes());
        return to_hex(&hash)[..16].to_string();
    }

    let salted = format!("prudii-device-v1:{}", raw_id);
    let hash = Sha256::digest(salted.as_bytes());
    to_hex(&hash)[..16].to_string()
}

#[cfg(windows)]
fn get_raw_machine_id() -> String {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, HKEY_LOCAL_MACHINE, KEY_READ, REG_VALUE_TYPE,
    };

    let mut hkey = windows::Win32::System::Registry::HKEY::default();
    let result = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Cryptography"),
            Some(0),
            KEY_READ,
            &mut hkey,
        )
    };

    if result.is_err() {
        log::warn!("[license] Failed to open registry key for MachineGuid");
        return String::new();
    }

    let mut buf = [0u16; 256];
    let mut buf_len = (buf.len() * 2) as u32;
    let mut reg_type = REG_VALUE_TYPE::default();
    let result = unsafe {
        RegQueryValueExW(
            hkey,
            w!("MachineGuid"),
            None,
            Some(&mut reg_type),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut buf_len),
        )
    };

    if result.is_err() {
        log::warn!("[license] Failed to read MachineGuid");
        return String::new();
    }

    String::from_utf16_lossy(&buf[..buf_len as usize / 2])
        .trim_end_matches('\0')
        .to_string()
}

/// macOS: read IOPlatformUUID via ioreg command.
#[cfg(target_os = "macos")]
fn get_raw_machine_id() -> String {
    // ioreg -rd1 -c IOPlatformExpertDevice outputs the Hardware UUID
    match std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Parse: "IOPlatformUUID" = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            for line in stdout.lines() {
                if line.contains("IOPlatformUUID") {
                    if let Some(uuid) = line.split('"').nth(3) {
                        return uuid.trim().to_string();
                    }
                }
            }
            log::warn!("[license] IOPlatformUUID not found in ioreg output");
            String::new()
        }
        Err(e) => {
            log::warn!("[license] Failed to run ioreg: {}", e);
            String::new()
        }
    }
}

/// Linux: read /etc/machine-id (standard on systemd systems).
#[cfg(all(not(windows), not(target_os = "macos")))]
fn get_raw_machine_id() -> String {
    // /etc/machine-id is present on all systemd-based distros (Debian, Ubuntu, Fedora, Arch, etc.)
    match std::fs::read_to_string("/etc/machine-id") {
        Ok(id) => {
            let id = id.trim().to_string();
            if !id.is_empty() {
                return id;
            }
            log::warn!("[license] /etc/machine-id is empty");
        }
        Err(_) => {
            log::warn!("[license] /etc/machine-id not found, trying /var/lib/dbus/machine-id");
        }
    }
    // Fallback for non-systemd systems
    match std::fs::read_to_string("/var/lib/dbus/machine-id") {
        Ok(id) => id.trim().to_string(),
        Err(e) => {
            log::warn!("[license] No machine-id found: {}", e);
            String::new()
        }
    }
}

fn get_device_name() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        return name;
    }
    if let Ok(name) = std::env::var("HOSTNAME") {
        return name;
    }
    // Fallback: run `hostname` command (works on macOS and Linux)
    if let Ok(output) = std::process::Command::new("hostname").output() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    "Unknown Device".to_string()
}

/// Store PB auth token in license_cache (DPAPI encrypted on Windows).
fn store_token(conn: &rusqlite::Connection, token: &str) {
    let value: String;
    #[cfg(windows)]
    {
        value = crate::credentials::dpapi::encrypt(token).unwrap_or_else(|| {
            log::error!("[license] DPAPI encrypt failed for auth token");
            String::new()
        });
    }
    #[cfg(not(windows))]
    {
        value = token.to_string();
    }

    let _ = conn.execute(
        "UPDATE license_cache SET pb_auth_token = ?1 WHERE id = 1",
        rusqlite::params![value],
    );
}

/// Read PB auth token from license_cache (DPAPI decrypted on Windows).
fn read_token(conn: &rusqlite::Connection) -> Option<String> {
    let stored: String = conn
        .query_row(
            "SELECT pb_auth_token FROM license_cache WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok()?;

    if stored.is_empty() {
        return None;
    }

    #[cfg(windows)]
    {
        if crate::credentials::dpapi::is_encrypted(&stored) {
            return crate::credentials::dpapi::decrypt(&stored);
        }
        // Plaintext — encrypt and update
        if let Some(encrypted) = crate::credentials::dpapi::encrypt(&stored) {
            let _ = conn.execute(
                "UPDATE license_cache SET pb_auth_token = ?1 WHERE id = 1",
                rusqlite::params![encrypted],
            );
        }
        return Some(stored);
    }

    #[cfg(not(windows))]
    {
        Some(stored)
    }
}

/// Attempt to refresh the PocketBase auth token using the auth-refresh endpoint.
/// Works when the token is merely expired but the signing key is unchanged.
/// Fails (returns None) when the server's JWT secret was rotated (e.g. fresh PB install),
/// in which case re-login is the only option.
async fn try_refresh_token(client: &reqwest::Client, old_token: &str) -> Option<String> {
    let resp = client
        .post(format!(
            "{}/api/collections/users/auth-refresh",
            PB_URL
        ))
        .header("Authorization", format!("Bearer {}", old_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        log::info!(
            "[license] Token refresh returned {} — re-login required",
            resp.status()
        );
        return None;
    }

    let body: PbAuthResponse = resp.json().await.ok()?;
    log::info!("[license] Auth token refreshed successfully");
    Some(body.token)
}

async fn call_verify(
    client: &reqwest::Client,
    token: &str,
    device_id: &str,
    device_name: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    client
        .post(format!("{}/api/license/verify", PB_URL))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({
            "device_id": device_id,
            "device_name": device_name,
        }))
        .send()
        .await
}

fn read_cache(conn: &rusqlite::Connection) -> LicenseInfo {
    conn.query_row(
        "SELECT user_email, plan, license_key, valid_until, features, last_verified, device_id, COALESCE(pb_auth_token, '') FROM license_cache WHERE id = 1",
        [],
        |row| {
            let features_json: String = row.get(4)?;
            let features: Vec<String> = serde_json::from_str(&features_json).unwrap_or_default();
            let user_email: String = row.get(0)?;
            let token: String = row.get(7)?;
            let logged_in = !user_email.is_empty();
            Ok(LicenseInfo {
                logged_in,
                // Still know the user but the token is gone → session expired (401).
                session_expired: logged_in && token.is_empty(),
                user_email,
                plan: row.get(1)?,
                license_key: row.get(2)?,
                valid_until: row.get(3)?,
                features,
                last_verified: row.get(5)?,
                device_id: row.get(6)?,
            })
        },
    )
    .unwrap_or(LicenseInfo {
        user_email: String::new(),
        plan: "free".to_string(),
        license_key: String::new(),
        valid_until: String::new(),
        features: vec![],
        last_verified: String::new(),
        device_id: String::new(),
        logged_in: false,
        session_expired: false,
    })
}

/// Update license cache after a successful verify/activate.
/// `verified_at` comes from the server response (part of the HMAC signature).
fn update_cache(
    conn: &rusqlite::Connection,
    email: &str,
    plan: &str,
    key: &str,
    valid_until: &str,
    features: &[String],
    signature: &str,
    verified_at: &str,
    device_id: &str,
) {
    let features_json = serde_json::to_string(features).unwrap_or_else(|_| "[]".to_string());

    let _ = conn.execute(
        "UPDATE license_cache SET user_email = ?1, plan = ?2, license_key = ?3, valid_until = ?4, features = ?5, signature = ?6, last_verified = ?7, device_id = ?8 WHERE id = 1",
        rusqlite::params![email, plan, key, valid_until, features_json, signature, verified_at, device_id],
    );
}

/// Downgrade cache to free (keep email + device so user stays logged in).
fn downgrade_to_free(conn: &rusqlite::Connection) {
    let _ = conn.execute(
        "UPDATE license_cache SET plan = 'free', license_key = '', valid_until = '', features = '[]', signature = '' WHERE id = 1",
        [],
    );
}

/// Apply offline grace period rules to cached license.
/// Returns a (possibly downgraded) LicenseInfo.
///
/// Note: `session_expired` (a dead auth token) is deliberately NOT a reason to
/// lock features here. The auth token's lifetime is unrelated to the license's
/// validity — the token expires routinely (~weekly) while a paid license stays
/// valid for months. Entitlement is governed purely by the server-signed
/// `valid_until` and the 30-day `last_verified` staleness budget below; the
/// signature integrity check (see `verify_cache_integrity`) guards against tampering.
/// `session_expired` is passed through only as a soft "please re-authenticate"
/// hint for the UI.
fn apply_grace_period(info: &LicenseInfo) -> LicenseInfo {
    if !info.logged_in || info.plan == "free" {
        return info.clone();
    }

    if !info.valid_until.is_empty() {
        if let Ok(valid_until) = chrono::DateTime::parse_from_rfc3339(&info.valid_until) {
            if valid_until.with_timezone(&chrono::Utc) < chrono::Utc::now() {
                log::info!("[license] License expired (valid_until passed)");
                return LicenseInfo {
                    plan: "free".to_string(),
                    features: vec![],
                    ..info.clone()
                };
            }
        }
    }

    if !info.last_verified.is_empty() {
        if let Ok(last_verified) = chrono::DateTime::parse_from_rfc3339(&info.last_verified) {
            let days_since = (chrono::Utc::now() - last_verified.with_timezone(&chrono::Utc)).num_days();

            if days_since > 30 {
                log::warn!(
                    "[license] Last verified {} days ago — exceeds 30-day grace period",
                    days_since
                );
                return LicenseInfo {
                    plan: "free".to_string(),
                    features: vec![],
                    ..info.clone()
                };
            }
        }
    }

    info.clone()
}

#[tauri::command]
pub async fn license_login(
    db: State<'_, Database>,
    email: String,
    password: String,
) -> Result<LicenseInfo, String> {
    let device_id = compute_device_id();
    let device_name = get_device_name();

    let client = reqwest::Client::new();
    let auth_resp = client
        .post(format!(
            "{}/api/collections/users/auth-with-password",
            PB_URL
        ))
        .json(&serde_json::json!({
            "identity": email,
            "password": password,
        }))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if !auth_resp.status().is_success() {
        let status = auth_resp.status();
        let body = auth_resp.text().await.unwrap_or_default();
        return Err(format!("Login failed ({}): {}", status, body));
    }

    let auth: PbAuthResponse = auth_resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    {
        let conn = db.lock_db();
        store_token(&conn, &auth.token);
    }

    let verify_resp = client
        .post(format!("{}/api/license/verify", PB_URL))
        .header("Authorization", format!("Bearer {}", auth.token))
        .json(&serde_json::json!({
            "device_id": device_id,
            "device_name": device_name,
        }))
        .send()
        .await
        .map_err(|e| format!("Verify failed: {}", e))?;

    if !verify_resp.status().is_success() {
        // Login succeeded but no license — store as free user
        let conn = db.lock_db();
        update_cache(
            &conn,
            &auth.record.email,
            "free",
            "",
            "",
            &[],
            "",
            "",
            &device_id,
        );
        return Ok(read_cache(&conn));
    }

    let verify: VerifyResponse = verify_resp
        .json()
        .await
        .map_err(|e| format!("Invalid verify response: {}", e))?;

    if verify.plan != "free"
        && !verify_signature(&verify.plan, &verify.valid_until, &verify.verified_at, &verify.signature)
    {
        log::error!("[license] signature mismatch — possible tampering");
        return Err("License verification failed: invalid signature".to_string());
    }

    let conn = db.lock_db();
    update_cache(
        &conn,
        &auth.record.email,
        &verify.plan,
        &verify.license_key,
        &verify.valid_until,
        &verify.features,
        &verify.signature,
        &verify.verified_at,
        &device_id,
    );

    Ok(read_cache(&conn))
}

#[tauri::command]
pub fn license_logout(db: State<'_, Database>) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        let _ = conn.execute(
            "UPDATE license_cache SET user_email = '', plan = 'free', license_key = '', valid_until = '', features = '[]', signature = '', last_verified = '', device_id = '', pb_auth_token = '' WHERE id = 1",
            [],
        );
        Ok(())
    })
}

#[tauri::command]
pub fn get_license_info(db: State<'_, Database>) -> Result<LicenseInfo, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();

        if !verify_cache_integrity(&conn) {
            log::error!("[license] Cache integrity check failed — resetting to free");
            downgrade_to_free(&conn);
        }

        let info = read_cache(&conn);
        Ok(apply_grace_period(&info))
    })
}

#[tauri::command]
pub async fn verify_license(db: State<'_, Database>) -> Result<LicenseInfo, String> {
    let device_id = compute_device_id();
    let device_name = get_device_name();

    let token = {
        let conn = db.lock_db();
        read_token(&conn)
    };

    let Some(token) = token else {
        return Err("Not logged in".to_string());
    };

    let client = reqwest::Client::new();
    let mut resp = call_verify(&client, &token, &device_id, &device_name)
        .await
        .map_err(|e| format!("Verify failed: {}", e))?;

    // On 401, try a single auth-refresh + retry before giving up.
    if resp.status().as_u16() == 401 {
        if let Some(new_token) = try_refresh_token(&client, &token).await {
            {
                let conn = db.lock_db();
                store_token(&conn, &new_token);
            }
            resp = call_verify(&client, &new_token, &device_id, &device_name)
                .await
                .map_err(|e| format!("Verify failed: {}", e))?;
        }
    }

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            let conn = db.lock_db();
            let _ = conn.execute(
                "UPDATE license_cache SET pb_auth_token = '' WHERE id = 1",
                [],
            );
            // Clear the dead token so the UI shows a soft re-auth hint, but do NOT
            // downgrade: the signed cache still governs entitlement via the grace
            // period (valid_until + 30-day staleness). Return an error so the manual
            // "Verify" action gives the user clear feedback that re-login is needed.
            return Err("Session expired. Please log in again.".to_string());
        }
        return Err(format!("Verify failed ({}): {}", status, body));
    }

    let verify: VerifyResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    if verify.plan != "free"
        && !verify_signature(&verify.plan, &verify.valid_until, &verify.verified_at, &verify.signature)
    {
        log::error!("[license] signature mismatch on verify");
        return Err("License verification failed: invalid signature".to_string());
    }

    let conn = db.lock_db();
    let email: String = conn
        .query_row(
            "SELECT user_email FROM license_cache WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();

    update_cache(
        &conn,
        &email,
        &verify.plan,
        &verify.license_key,
        &verify.valid_until,
        &verify.features,
        &verify.signature,
        &verify.verified_at,
        &device_id,
    );

    Ok(read_cache(&conn))
}

/// Startup license check: applies grace period, re-verifies if stale (>7 days).
/// Never fails — returns best-effort LicenseInfo.
#[tauri::command]
pub async fn check_license_startup(db: State<'_, Database>) -> Result<LicenseInfo, String> {
    let info = {
        let conn = db.lock_db();

        if !verify_cache_integrity(&conn) {
            log::error!("[license] Cache tampered — resetting to free");
            downgrade_to_free(&conn);
        }

        read_cache(&conn)
    };

    if !info.logged_in {
        return Ok(info);
    }

    // Always attempt one online verification when logged in, so a server-side
    // token invalidation (e.g. a PocketBase update rotating the JWT secret) is
    // detected on the next app start instead of only after a staleness window.
    // Offline/network errors fall through to the cached grace period below.
    {
        log::info!("[license] Verifying license/session online");
        let device_id = compute_device_id();
        let device_name = get_device_name();

        let token = {
            let conn = db.lock_db();
            read_token(&conn)
        };

        if let Some(token) = token {
            let client = reqwest::Client::new();
            // The token that ultimately talked to the server successfully. Tracked
            // so we can proactively roll its window forward on success (below).
            let mut active_token = token.clone();
            let mut refreshed_during_retry = false;
            let mut startup_resp = client
                .post(format!("{}/api/license/verify", PB_URL))
                .header("Authorization", format!("Bearer {}", token))
                .json(&serde_json::json!({
                    "device_id": device_id,
                    "device_name": device_name,
                }))
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await;

            // On 401, try a single auth-refresh + retry before giving up.
            if let Ok(ref r) = startup_resp {
                if r.status().as_u16() == 401 {
                    if let Some(new_token) = try_refresh_token(&client, &token).await {
                        {
                            let conn = db.lock_db();
                            store_token(&conn, &new_token);
                        }
                        active_token = new_token.clone();
                        refreshed_during_retry = true;
                        startup_resp = client
                            .post(format!("{}/api/license/verify", PB_URL))
                            .header("Authorization", format!("Bearer {}", new_token))
                            .json(&serde_json::json!({
                                "device_id": device_id,
                                "device_name": device_name,
                            }))
                            .timeout(std::time::Duration::from_secs(10))
                            .send()
                            .await;
                    }
                }
            }

            match startup_resp {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(verify) = resp.json::<VerifyResponse>().await {
                        if verify.plan == "free"
                            || verify_signature(
                                &verify.plan,
                                &verify.valid_until,
                                &verify.verified_at,
                                &verify.signature,
                            )
                        {
                            {
                                let conn = db.lock_db();
                                update_cache(
                                    &conn,
                                    &info.user_email,
                                    &verify.plan,
                                    &verify.license_key,
                                    &verify.valid_until,
                                    &verify.features,
                                    &verify.signature,
                                    &verify.verified_at,
                                    &device_id,
                                );
                            }
                            // Proactively roll the auth-token window forward while it
                            // is still valid, so a regularly-active user never hits
                            // token expiry. auth-refresh needs a live token — which we
                            // have, verify just passed. Skip if we already minted a
                            // fresh token during the 401 retry above.
                            if !refreshed_during_retry {
                                if let Some(rolled) = try_refresh_token(&client, &active_token).await {
                                    let conn = db.lock_db();
                                    store_token(&conn, &rolled);
                                }
                            }
                            let conn = db.lock_db();
                            log::info!("[license] Online verification succeeded: plan={}", verify.plan);
                            return Ok(read_cache(&conn));
                        }
                    }
                }
                Ok(resp) if resp.status().as_u16() == 401 => {
                    // Token is dead (expired, or JWT secret rotated after a PB update)
                    // and refresh could not salvage it. This is NOT grounds to lock the
                    // user out: the cached license is signed and still governs
                    // entitlement via its own valid_until + 30-day staleness budget.
                    // Clear the dead token (so read_cache reports session_expired = a
                    // soft "re-authenticate" hint) but keep the signed cache and ride
                    // the grace period instead of downgrading to free.
                    {
                        let conn = db.lock_db();
                        let _ = conn.execute(
                            "UPDATE license_cache SET pb_auth_token = '' WHERE id = 1",
                            [],
                        );
                    }
                    let graced = {
                        let conn = db.lock_db();
                        apply_grace_period(&read_cache(&conn))
                    };
                    log::info!("[license] Auth token expired/rejected — riding grace period on signed cache (re-auth prompt shown)");
                    return Ok(graced);
                }
                _ => {
                    log::info!("[license] Offline — using cached license with grace period");
                }
            }
        }
    }

    Ok(apply_grace_period(&info))
}

#[tauri::command]
pub async fn activate_license_key(
    db: State<'_, Database>,
    key: String,
    email: String,
) -> Result<LicenseInfo, String> {
    let device_id = compute_device_id();
    let device_name = get_device_name();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/api/license/activate", PB_URL))
        .json(&serde_json::json!({
            "key": key,
            "email": email,
            "device_id": device_id,
            "device_name": device_name,
        }))
        .send()
        .await
        .map_err(|e| format!("Activation failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Activation failed: {}", body));
    }

    let activate: ActivateResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    if activate.plan != "free"
        && !verify_signature(&activate.plan, &activate.valid_until, &activate.verified_at, &activate.signature)
    {
        return Err("Activation failed: invalid signature".to_string());
    }

    let conn = db.lock_db();
    store_token(&conn, &activate.auth_token);
    update_cache(
        &conn,
        &activate.user_email,
        &activate.plan,
        &activate.license_key,
        &activate.valid_until,
        &activate.features,
        &activate.signature,
        &activate.verified_at,
        &device_id,
    );

    Ok(read_cache(&conn))
}

#[tauri::command]
pub fn check_feature(db: State<'_, Database>, feature: String) -> Result<bool, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();

        if !verify_cache_integrity(&conn) {
            return Ok(false);
        }

        let info = read_cache(&conn);
        let info = apply_grace_period(&info);
        Ok(info.features.contains(&feature))
    })
}

#[tauri::command]
pub fn get_device_id() -> Result<String, String> {
    Ok(compute_device_id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn hex_to_bytes_roundtrips_and_rejects_bad_input() {
        assert_eq!(
            hex_to_bytes(&to_hex(&[0x00, 0x0f, 0xa0, 0xff])).unwrap(),
            vec![0x00, 0x0f, 0xa0, 0xff]
        );
        assert!(hex_to_bytes("abc").is_none()); // odd length
        assert!(hex_to_bytes("zz").is_none()); // non-hex chars
    }

    #[test]
    fn valid_ed25519_signature_verifies_and_tampering_is_rejected() {
        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let vk = sk.verifying_key();

        let (plan, valid_until, verified_at) =
            ("pro", "2030-01-01T00:00:00Z", "2026-07-05T00:00:00Z");
        let payload = format!(
            r#"{{"valid":true,"plan":"{}","valid_until":"{}","verified_at":"{}"}}"#,
            plan, valid_until, verified_at
        );
        let sig_hex = to_hex(&sk.sign(payload.as_bytes()).to_bytes());

        // Genuine signature verifies.
        assert!(verify_with_key(&vk, plan, valid_until, verified_at, &sig_hex));
        // Any tampered field breaks it.
        assert!(!verify_with_key(&vk, "enterprise", valid_until, verified_at, &sig_hex));
        // A different key cannot verify it.
        let other = SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        assert!(!verify_with_key(&other, plan, valid_until, verified_at, &sig_hex));
        // Malformed / empty signatures are rejected, never panic.
        assert!(!verify_with_key(&vk, plan, valid_until, verified_at, "deadbeef"));
        assert!(!verify_with_key(&vk, plan, valid_until, verified_at, ""));
    }
}
