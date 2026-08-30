use crate::db::Database;
use crate::models::AppSettings;
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command(async)]
pub fn get_app_settings(db: State<'_, Database>) -> Result<AppSettings, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();

        // One round-trip for the whole table instead of one query_row per key.
        let mut values = std::collections::HashMap::<String, String>::new();
        let mut stmt = conn
            .prepare("SELECT key, value FROM app_settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            values.insert(row.0, row.1);
        }

        let get_bool = |key: &str, default: bool| -> bool {
            values.get(key).map(|v| v == "true" || v == "1").unwrap_or(default)
        };
        let get_string = |key: &str, default: &str| -> String {
            values.get(key).cloned().unwrap_or_else(|| default.to_string())
        };
        let get_u32 = |key: &str, default: u32| -> u32 {
            values.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
        };

        Ok(AppSettings {
            launch_on_startup: get_bool("launch_on_startup", false),
            show_in_tray: get_bool("show_in_tray", true),
            use_24h_clock: get_bool("use_24h_clock", true),
            show_all_unread_counts: get_bool("show_all_unread_counts", false),
            notifications_enabled: get_bool("notifications_enabled", true),
            notification_sound: get_bool("notification_sound", true),
            language: get_string("language", "system"),
            density: get_string("density", "comfortable"),
            accent_color: get_string("accent_color", "blue"),
            ai_enabled: get_bool("ai_enabled", false),
            ollama_url: get_string("ollama_url", "http://localhost:11434"),
            ai_model: get_string("ai_model", ""),
            undo_send_delay: get_u32("undo_send_delay", 5),
            // "" = never explicitly set — the frontend must not override localStorage with it
            theme_mode: get_string("theme_mode", ""),
            transparent_sidebar: get_bool("transparent_sidebar", true),
            strip_tracking_params: get_bool("strip_tracking_params", true),
        })
    })
}

#[tauri::command(async)]
pub fn update_app_settings(
    db: State<'_, Database>,
    app: tauri::AppHandle,
    settings: AppSettings,
) -> Result<(), String> {
    super::catch_panic(|| {
        let conn = db.lock_db();
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

        fn set_setting(conn: &rusqlite::Connection, key: &str, value: bool) -> Result<(), String> {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![key, if value { "true" } else { "false" }],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }

        set_setting(&conn, "launch_on_startup", settings.launch_on_startup)?;
        set_setting(&conn, "show_in_tray", settings.show_in_tray)?;
        set_setting(&conn, "use_24h_clock", settings.use_24h_clock)?;
        set_setting(&conn, "show_all_unread_counts", settings.show_all_unread_counts)?;
        set_setting(&conn, "notifications_enabled", settings.notifications_enabled)?;
        set_setting(&conn, "notification_sound", settings.notification_sound)?;
        set_setting(&conn, "transparent_sidebar", settings.transparent_sidebar)?;
        set_setting(&conn, "strip_tracking_params", settings.strip_tracking_params)?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["language", &settings.language],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["density", &settings.density],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["accent_color", &settings.accent_color],
        )
        .map_err(|e| e.to_string())?;

        set_setting(&conn, "ai_enabled", settings.ai_enabled)?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["ollama_url", &settings.ollama_url],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["ai_model", &settings.ai_model],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["undo_send_delay", settings.undo_send_delay.to_string()],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["theme_mode", &settings.theme_mode],
        )
        .map_err(|e| e.to_string())?;

        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        drop(conn);

        // Update autostart setting (skip in dev builds to avoid registering debug exe path)
        if !cfg!(debug_assertions) {
            let autostart = app.autolaunch();
            if settings.launch_on_startup {
                let _ = autostart.enable();
            } else {
                let _ = autostart.disable();
            }
        }

        Ok(())
    })
}
