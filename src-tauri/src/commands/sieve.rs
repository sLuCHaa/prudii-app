use crate::credentials;
use crate::db::Database;
use crate::sieve::client::{self, SieveError};
use crate::sieve::vacation::{self, VacationSettings, VacationState};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SieveSupport {
    Supported,
    Unsupported { reason: String },
    Unreachable,
}

struct SieveAccount {
    email: String,
    imap_host: String,
    auth_type: String,
    provider: String,
}

fn load(db: &Database, account_id: &str) -> Result<SieveAccount, String> {
    let conn = db.lock_db();
    conn.query_row(
        "SELECT email, imap_host, auth_type, provider FROM accounts WHERE id = ?1",
        rusqlite::params![account_id],
        |row| {
            Ok(SieveAccount {
                email: row.get(0)?,
                imap_host: row.get(1)?,
                auth_type: row.get(2)?,
                provider: row.get(3)?,
            })
        },
    )
    .map_err(|e| format!("Account not found: {}", e))
}

/// Only password-authenticated IMAP accounts can use ManageSieve; the API
/// providers have their own auto-reply endpoints (not wired up yet).
fn ineligible_reason(a: &SieveAccount) -> Option<&'static str> {
    if a.auth_type != "password" {
        return Some("oauth");
    }
    if a.provider == "google" || a.provider == "microsoft" {
        return Some("api");
    }
    None
}

#[tauri::command]
pub async fn check_sieve_support(db: State<'_, Database>, account_id: String) -> Result<SieveSupport, String> {
    let account = load(&db, &account_id)?;
    if let Some(reason) = ineligible_reason(&account) {
        return Ok(SieveSupport::Unsupported { reason: reason.to_string() });
    }
    match client::probe(&account.imap_host).await {
        Ok(caps) if !caps.starttls => Ok(SieveSupport::Unsupported { reason: "no STARTTLS".into() }),
        Ok(caps) if !caps.has("vacation") => Ok(SieveSupport::Unsupported { reason: "no vacation".into() }),
        Ok(_) => Ok(SieveSupport::Supported),
        Err(SieveError::Unreachable(_)) => Ok(SieveSupport::Unreachable),
        Err(e) => Ok(SieveSupport::Unsupported { reason: e.to_string() }),
    }
}

async fn open(account: &SieveAccount, account_id: &str) -> Result<client::SieveClient, String> {
    if let Some(reason) = ineligible_reason(account) {
        return Err(format!("Not supported: {}", reason));
    }
    let password = credentials::resolve_credential(account_id, &account.auth_type, &account.provider)
        .await
        .map_err(|e| e.to_string())?;
    client::connect(&account.imap_host, &account.email, &password)
        .await
        .map_err(|e| e.to_string())
}

/// The active script, or an empty script under a Prudii-owned name when
/// the account has none yet.
async fn active_script(session: &mut client::SieveClient) -> Result<(String, String), String> {
    let scripts = session.list_scripts().await.map_err(|e| e.to_string())?;
    let Some((name, _)) = scripts.into_iter().find(|(_, active)| *active) else {
        return Ok(("prudii".to_string(), String::new()));
    };
    let body = session.get_script(&name).await.map_err(|e| e.to_string())?;
    Ok((name, body))
}

#[tauri::command]
pub async fn get_vacation(db: State<'_, Database>, account_id: String) -> Result<VacationState, String> {
    let account = load(&db, &account_id)?;
    let mut session = open(&account, &account_id).await?;
    let result = active_script(&mut session).await;
    session.logout().await;
    let (_, script) = result?;
    Ok(vacation::read_state(&script))
}

#[tauri::command]
pub async fn set_vacation(db: State<'_, Database>, account_id: String, settings: VacationSettings) -> Result<(), String> {
    vacation::validate(&settings)?;
    let account = load(&db, &account_id)?;
    let mut session = open(&account, &account_id).await?;
    let result = write_vacation(&mut session, &settings).await;
    session.logout().await;
    result
}

async fn write_vacation(session: &mut client::SieveClient, settings: &VacationSettings) -> Result<(), String> {
    let (name, old) = active_script(session).await?;
    let new = vacation::merge(&old, settings).map_err(|r| r.reason)?;
    if new == old {
        return Ok(());
    }
    // Validate first, then keep the previous version, then swap: an
    // interrupted sequence leaves either the old script active or nothing
    // changed at all.
    session.check_script(&new).await.map_err(|e| e.to_string())?;
    session
        .put_script(vacation::backup_script_name(), &old)
        .await
        .map_err(|e| e.to_string())?;
    session.put_script(&name, &new).await.map_err(|e| e.to_string())?;
    session.set_active(&name).await.map_err(|e| e.to_string())?;
    log::info!("[sieve] vacation notice {} for script {}", if settings.enabled { "set" } else { "cleared" }, name);
    Ok(())
}
