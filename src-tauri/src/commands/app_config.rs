use crate::db::Database;
use tauri::State;

const CACHE_KEY_GOOGLE: &str = "app_config_oauth_signup_google";
const CACHE_KEY_MICROSOFT: &str = "app_config_oauth_signup_microsoft";

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub oauth_signup_google: bool,
    pub oauth_signup_microsoft: bool,
}

fn read_cached(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(default)
}

fn write_cached(conn: &rusqlite::Connection, key: &str, value: bool) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, if value { "true" } else { "false" }],
    );
}

/// Fetch the OAuth signup flags from PocketBase, falling back to the last cached
/// values and finally to fail-open defaults (true) so a server outage never
/// blocks account creation.
#[tauri::command]
pub async fn get_app_config(db: State<'_, Database>) -> Result<AppConfig, String> {
    let cached = {
        let conn = db.lock_db();
        AppConfig {
            oauth_signup_google: read_cached(&conn, CACHE_KEY_GOOGLE, true),
            oauth_signup_microsoft: read_cached(&conn, CACHE_KEY_MICROSOFT, true),
        }
    };

    let url = "https://api.prudii.com/api/collections/app_config/records?perPage=1";
    let fetched = async {
        let resp = reqwest::get(url).await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: serde_json::Value = resp.json().await.ok()?;
        let item = body["items"].as_array()?.first()?;
        Some((
            item["oauth_signup_google"].as_bool().unwrap_or(true),
            item["oauth_signup_microsoft"].as_bool().unwrap_or(true),
        ))
    }
    .await;

    match fetched {
        Some((google, microsoft)) => {
            let conn = db.lock_db();
            write_cached(&conn, CACHE_KEY_GOOGLE, google);
            write_cached(&conn, CACHE_KEY_MICROSOFT, microsoft);
            Ok(AppConfig {
                oauth_signup_google: google,
                oauth_signup_microsoft: microsoft,
            })
        }
        None => Ok(cached),
    }
}
