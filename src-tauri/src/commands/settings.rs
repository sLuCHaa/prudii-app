use crate::db::Database;
use crate::models::AppSettings;
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn get_app_settings(db: State<'_, Database>) -> Result<AppSettings, String> {
    super::catch_panic(|| {
        let conn = db.lock_db();

        fn get_bool(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .map(|v| v == "true" || v == "1")
            .unwrap_or(default)
        }

        fn get_string(conn: &rusqlite::Connection, key: &str, default: &str) -> String {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| default.to_string())
        }

        fn get_u32(conn: &rusqlite::Connection, key: &str, default: u32) -> u32 {
            conn.query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
        }

        Ok(AppSettings {
            launch_on_startup: get_bool(&conn, "launch_on_startup", false),
            show_in_tray: get_bool(&conn, "show_in_tray", true),
            use_24h_clock: get_bool(&conn, "use_24h_clock", true),
            show_all_unread_counts: get_bool(&conn, "show_all_unread_counts", false),
            notifications_enabled: get_bool(&conn, "notifications_enabled", true),
            notification_sound: get_bool(&conn, "notification_sound", true),
            language: get_string(&conn, "language", "system"),
            density: get_string(&conn, "density", "comfortable"),
            accent_color: get_string(&conn, "accent_color", "blue"),
            ai_enabled: get_bool(&conn, "ai_enabled", false),
            ollama_url: get_string(&conn, "ollama_url", "http://localhost:11434"),
            ai_model: get_string(&conn, "ai_model", ""),
            undo_send_delay: get_u32(&conn, "undo_send_delay", 5),
            // "" = never explicitly set — the frontend must not override localStorage with it
            theme_mode: get_string(&conn, "theme_mode", ""),
            transparent_sidebar: get_bool(&conn, "transparent_sidebar", true),
            strip_tracking_params: get_bool(&conn, "strip_tracking_params", true),
        })
    })
}

#[tauri::command]
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
