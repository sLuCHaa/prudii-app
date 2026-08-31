use crate::db::Database;
use tauri::State;

/// Single startup payload: accounts, every folder across those accounts, and
/// the first page of mails for the folder the UI will land on. Replaces three
/// separate IPC round trips (list_accounts + list_folders x N + list_mails)
/// with one lock_db() acquisition.
#[derive(serde::Serialize)]
pub struct BootstrapState {
    pub accounts: Vec<crate::models::Account>,
    pub folders: Vec<crate::models::Folder>, // all accounts, flat
    pub folder_id: Option<String>,           // the folder mails below belong to
    pub mails: Vec<crate::models::Mail>,     // first page (50) of that folder
}

#[tauri::command(async)]
pub fn bootstrap_state(db: State<'_, Database>, last_folder_id: Option<String>) -> Result<BootstrapState, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        bootstrap_state_inner(&conn, last_folder_id)
    })
}

/// Command body, separated so integration tests can run it against a fixture DB.
pub fn bootstrap_state_inner(conn: &rusqlite::Connection, last_folder_id: Option<String>) -> Result<BootstrapState, String> {
    let accounts = super::accounts::list_accounts_inner(conn)?;

    let mut folders = Vec::new();
    for account in &accounts {
        folders.extend(super::accounts::list_folders_inner(conn, &account.id)?);
    }

    // Folder pick order: the caller's last-viewed folder if it still exists,
    // else the first inbox across all accounts, else none (fresh install).
    let folder_id = last_folder_id
        .filter(|id| folders.iter().any(|f| &f.id == id))
        .or_else(|| folders.iter().find(|f| f.folder_type == "inbox").map(|f| f.id.clone()));

    let mails = match &folder_id {
        Some(id) => super::mails::list_mails_inner(conn, id, Some(50), Some(0), &None)?,
        None => Vec::new(),
    };

    Ok(BootstrapState { accounts, folders, folder_id, mails })
}
