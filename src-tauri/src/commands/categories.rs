use crate::categorize::store;
use crate::db::Database;
use tauri::State;

#[tauri::command(async)]
pub fn categorize_pending_mails(db: State<'_, Database>) -> Result<u32, String> {
    super::catch_panic(|| Ok(store::categorize_all_pending(&db) as u32))
}
