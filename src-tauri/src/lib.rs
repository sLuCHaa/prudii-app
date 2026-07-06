pub mod ai;
pub mod classify;
pub mod cleanup_guard;
pub mod commands;
pub mod connectivity;
pub mod credentials;
pub mod db;
pub mod gmail;
pub mod idle;
pub mod imap;
pub mod models;
pub mod notifications;
pub mod oauth;
pub mod outlook;
pub mod pool;
pub mod rules;
pub mod smtp;
pub mod task_registry;
pub mod window_geometry;

use db::Database;
use pool::ImapPool;
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{DownloadEvent, WebviewWindowBuilder},
    window::Color,
    Emitter, Manager,
};

static STARTUP_MAILTO: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// Detect whether Windows is using dark app theme via registry.
#[cfg(windows)]
fn is_system_dark_mode() -> bool {
    use windows::Win32::System::Registry::*;
    use windows::core::w;

    unsafe {
        let mut data: u32 = 1;
        let mut size: u32 = 4;
        let res = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut std::ffi::c_void),
            Some(&mut size),
        );
        if res.is_ok() { data == 0 } else { false }
    }
}

#[cfg(not(windows))]
fn is_system_dark_mode() -> bool {
    false
}

/// Read the window's current logical geometry. Returns None if any API call fails.
fn capture_geometry(window: &tauri::WebviewWindow) -> Option<window_geometry::WindowGeometry> {
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let maximized = window.is_maximized().unwrap_or(false);
    Some(window_geometry::WindowGeometry {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        maximized,
    })
}

#[cfg(windows)]
fn set_dwm_dark_mode(hwnd: *mut std::ffi::c_void, dark: bool) {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};
    use windows::Win32::Foundation::HWND;

    let hwnd = HWND(hwnd as *mut _);
    let value: i32 = if dark { 1 } else { 0 };
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &value as *const i32 as *const std::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

/// Win 11: round the corners of a frameless window like native decorated
/// windows. No-op on Win 10 (attribute unsupported) and when DWM refuses.
#[cfg(windows)]
fn set_dwm_rounded_corners(hwnd: *mut std::ffi::c_void) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };
    use windows::Win32::Foundation::HWND;

    let hwnd = HWND(hwnd as *mut _);
    let pref = DWMWCP_ROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const DWM_WINDOW_CORNER_PREFERENCE as *const std::ffi::c_void,
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );
    }
}

#[tauri::command]
fn set_window_theme(app: tauri::AppHandle, dark: bool, follows_system: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        for (_label, window) in app.webview_windows() {
            if let Ok(hwnd) = window.hwnd() {
                set_dwm_dark_mode(hwnd.0, dark);
            }
        }
    }
    // macOS: keep the native window appearance in sync with the app theme so
    // the vibrancy material follows the app, not the OS. In system mode the
    // appearance must be UNPINNED (None): pinning feeds back into the
    // webview's prefers-color-scheme, which would freeze "System" on the
    // pinned value until the next app restart.
    #[cfg(target_os = "macos")]
    {
        let theme = if follows_system {
            None
        } else if dark {
            Some(tauri::Theme::Dark)
        } else {
            Some(tauri::Theme::Light)
        };
        for (_label, window) in app.webview_windows() {
            let _ = window.set_theme(theme);
        }
    }

    // Keep the window background color in sync with the requested theme.
    // Mirrors the startup color-matching in the setup hook exactly — same
    // colors, applied the same way across all platforms (unconditionally) —
    // so a runtime theme switch doesn't leave the stale startup color
    // showing through the corner-clip/border-radius gap on the now-opaque
    // Windows window. In system mode, resolve dark/light via the same OS
    // check startup uses so the background matches what the webview will
    // actually render.
    let effective_dark = if follows_system { is_system_dark_mode() } else { dark };
    let bg = if effective_dark {
        Color(15, 23, 42, 255) // #0f172a
    } else {
        Color(255, 255, 255, 255) // #ffffff
    };
    for (_label, window) in app.webview_windows() {
        let _ = window.set_background_color(Some(bg));
    }

    Ok(())
}

/// Applies or clears the translucent-sidebar window effect on the main
/// window (macOS NSVisualEffectView only). Returns whether the platform
/// supports a native effect; on Windows/Linux this is always false and the
/// frontend renders the in-app ambient tint instead.
#[tauri::command]
fn set_vibrancy(app: tauri::AppHandle, enabled: bool, dark: bool) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };
    apply_vibrancy_effect(&window, enabled, dark)
}

#[cfg(target_os = "macos")]
fn apply_vibrancy_effect(
    window: &tauri::WebviewWindow,
    enabled: bool,
    _dark: bool,
) -> Result<bool, String> {
    use tauri::utils::config::WindowEffectsConfig;
    use tauri::window::Effect;
    let effects = enabled.then(|| WindowEffectsConfig {
        effects: vec![Effect::Sidebar],
        ..Default::default()
    });
    window.set_effects(effects).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Non-macOS: no native window effect. Windows/Linux render the in-app
/// ambient sidebar tint instead (see SidebarAmbient.tsx).
#[cfg(not(target_os = "macos"))]
fn apply_vibrancy_effect(
    _window: &tauri::WebviewWindow,
    _enabled: bool,
    _dark: bool,
) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    // Save geometry before hiding so position/size persists when restored.
    // Use try_lock() to avoid blocking the main thread when a sync task holds
    // the DB mutex. Geometry save is best-effort — skip if lock is contended.
    if let Some(window) = app.get_webview_window("main") {
        if let Some(g) = capture_geometry(&window) {
            let db = app.state::<Database>();
            if let Ok(conn) = db.conn.try_lock() {
                window_geometry::save(&conn, &g);
            };
        }
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(g) = capture_geometry(&window) {
            // Use try_lock() to avoid blocking the main thread when a sync task
            // holds the DB mutex. Geometry save is best-effort — skip if contended.
            let db = app.state::<Database>();
            if let Ok(conn) = db.conn.try_lock() {
                window_geometry::save(&conn, &g);
            };
        }
    }
    app.exit(0);
}

#[tauri::command]
fn get_startup_mailto() -> Result<Option<String>, String> {
    Ok(STARTUP_MAILTO
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take())
}

/// Remove dead per-user "Prudii Mail" uninstall registry entries left over from
/// old installs (e.g. an earlier MSI build or a per-user install at a path that no
/// longer exists). Only touches HKCU and only deletes an entry when its recorded
/// uninstaller file is missing on disk — so the live install is never affected.
/// Per-machine / HKLM leftovers need admin and are intentionally out of scope.
#[cfg(all(windows, not(debug_assertions)))]
fn cleanup_dead_uninstall_entries() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let uninstall = match hkcu.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        KEY_READ | KEY_WRITE,
    ) {
        Ok(k) => k,
        Err(_) => return,
    };

    let dead: Vec<String> = uninstall
        .enum_keys()
        .flatten()
        .filter(|sub| {
            let key = match uninstall.open_subkey(sub) {
                Ok(k) => k,
                Err(_) => return false,
            };
            let name: String = key.get_value("DisplayName").unwrap_or_default();
            if name != "Prudii Mail" {
                return false;
            }
            let uninstall_string: String = match key.get_value("UninstallString") {
                Ok(s) => s,
                Err(_) => return true, // no uninstaller recorded → stale entry
            };
            // Extract the executable path from the uninstall string.
            let exe = if let Some(rest) = uninstall_string.trim().strip_prefix('"') {
                rest.split('"').next().unwrap_or("").to_string()
            } else {
                uninstall_string
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string()
            };
            // MsiExec entries reference a product code, not a file (usually HKLM,
            // needs admin) — leave those alone.
            if exe.to_lowercase().contains("msiexec") {
                return false;
            }
            !exe.is_empty() && !std::path::Path::new(&exe).exists()
        })
        .collect();

    for sub in dead {
        if uninstall.delete_subkey_all(&sub).is_ok() {
            log::info!("Removed dead uninstall registry entry: {sub}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install rustls CryptoProvider globally (needed by reqwest for OAuth token exchange)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Install panic hook that logs to a file for crash debugging.
    // The default hook still runs (prints to stderr), but we also persist
    // the message so it survives the STATUS_STACK_BUFFER_OVERRUN abort.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());

        let log_line = format!(
            "[{}] PANIC at {}: {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            location,
            msg
        );

        // Write panic log to platform-appropriate app data directory
        let log_dir = if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA").map(|a| std::path::PathBuf::from(a).join("com.prudii.mail"))
        } else if cfg!(target_os = "macos") {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support/com.prudii.mail"))
        } else {
            // Linux: XDG_CONFIG_HOME or ~/.config
            std::env::var_os("XDG_CONFIG_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
                .map(|p| p.join("com.prudii.mail"))
        };
        if let Some(dir) = log_dir {
            let _ = std::fs::create_dir_all(&dir);
            let log_path = dir.join("panic.log");
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                use std::io::Write;
                let _ = f.write_all(log_line.as_bytes());
            }
        }

        default_hook(info);
    }));

    // Set AUMID so Windows notifications show "Prudii Mail" instead of "Windows PowerShell" in dev mode.
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        use windows::core::w;
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.prudii.mail"));
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Another instance was launched — show and focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(mailto_url) = args.iter().find(|a| a.starts_with("mailto:")) {
                let _ = app.emit("mailto-open", mailto_url.clone());
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("window-chrome")
                .on_window_ready(|_window| {
                    // Win 11 rounded corners for every window, incl. compose
                    // windows created later from JS.
                    #[cfg(windows)]
                    if let Ok(hwnd) = _window.hwnd() {
                        set_dwm_rounded_corners(hwnd.0);
                    }
                })
                .build(),
        )
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("prudii".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            // Temp directory for PDF preview downloads (redirected from user Downloads)
            let temp_dir = app_data_dir.join("temp_previews");
            let _ = std::fs::create_dir_all(&temp_dir);
            // Clean up stale temp preview files from previous sessions
            if let Ok(entries) = std::fs::read_dir(&temp_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }

            // Create main window programmatically so we can register on_download
            // to redirect WebView2 PDF-viewer temp files away from user's Downloads folder
            let temp_dir_clone = temp_dir.clone();

            // DB is needed before the window so we can restore saved geometry.
            let database = Database::new(app_data_dir.clone()).expect("Failed to initialize database");

            // Load + validate saved geometry against the current monitor layout.
            let saved_geom = {
                let conn = database.lock_db();
                window_geometry::load(&conn)
            };

            // Self-heal autostart: if "launch on startup" is enabled, re-register it on
            // every launch so the Windows Run entry always points to THIS executable.
            // Without this, an older install at a different path keeps its stale Run
            // entry and gets launched on boot even after updating.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let enabled = {
                    let conn = database.lock_db();
                    conn.query_row(
                        "SELECT value FROM app_settings WHERE key = 'launch_on_startup'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map(|v| v == "true" || v == "1")
                    .unwrap_or(false)
                };
                if enabled {
                    let _ = app.autolaunch().enable();
                }
            }

            // One-time-ish cleanup of dead per-user uninstall registry entries from
            // old installs (user-scope, no admin). Safe: only removes entries whose
            // uninstaller file is gone.
            #[cfg(all(windows, not(debug_assertions)))]
            cleanup_dead_uninstall_entries();

            let mut win_builder = WebviewWindowBuilder::new(app, "main", Default::default())
                .title("Prudii Mail")
                .visible(false)
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .disable_drag_drop_handler();

            // macOS: native decorations with the title bar overlaying our own —
            // real traffic lights, rounded corners, shadow, fullscreen animation.
            // Traffic lights vertically centered in the 32px custom title bar.
            // Note: tao interprets y as title-bar-container inset (container
            // height = button height + y), not the button's top offset — the
            // buttons render ~6px higher than y, hence 16 for visual center.
            #[cfg(target_os = "macos")]
            {
                win_builder = win_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(12.0, 16.0))
                    // Required for the sidebar vibrancy effect; the CSS paints
                    // opaque surfaces, so the window never looks transparent
                    // unless [data-vibrancy] lowers the sidebar alpha.
                    .transparent(true);
            }
            // Windows: frameless with our own window buttons. Opaque — the
            // sidebar is tinted in-app (SidebarAmbient), so no Mica/DWM
            // backdrop is needed, avoiding WebView2's transparent-window
            // rendering cost.
            #[cfg(windows)]
            {
                win_builder = win_builder.decorations(false);
            }
            #[cfg(target_os = "linux")]
            {
                win_builder = win_builder.decorations(false);
            }

            let window = win_builder
                .on_download(move |_webview, event| {
                    match event {
                        DownloadEvent::Requested { url, destination } => {
                            // Redirect blob: downloads (PDF viewer temp files)
                            // to our temp directory instead of user's Downloads folder
                            if url.scheme() == "blob" {
                                let name = destination
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_os_string();
                                *destination = temp_dir_clone.join(name);
                            }
                            true
                        }
                        DownloadEvent::Finished { .. } => true,
                        _ => true,
                    }
                })
                .build()
                .expect("Failed to create main window");

            // Restore validated geometry, or center a default window.
            let monitors: Vec<window_geometry::Rect> = window
                .available_monitors()
                .unwrap_or_default()
                .into_iter()
                .map(|m| {
                    let s = m.scale_factor();
                    // Use the work area, not the full monitor resolution: it excludes
                    // OS-reserved chrome (macOS menu bar + Dock, Windows taskbar). With
                    // the full size, the window can be sized/centred to span the whole
                    // screen and slip under the macOS menu bar, hiding our own title bar
                    // — most visible on small displays like a 13" MacBook. Logical px.
                    let wa = m.work_area();
                    window_geometry::Rect {
                        x: wa.position.x as f64 / s,
                        y: wa.position.y as f64 / s,
                        width: wa.size.width as f64 / s,
                        height: wa.size.height as f64 / s,
                    }
                })
                .collect();

            let target = saved_geom.and_then(|g| window_geometry::validate(g, &monitors, 900.0, 600.0));

            if let Some(g) = target {
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(g.width, g.height)));
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(g.x, g.y)));
                if g.maximized {
                    let _ = window.maximize();
                }
            } else if let Some(first) = monitors.first() {
                let w = 1200.0_f64.min(first.width);
                let h = 800.0_f64.min(first.height);
                let x = first.x + (first.width - w) / 2.0;
                let y = first.y + (first.height - h) / 2.0;
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
            }
            // else: no monitors detected — keep builder default (1200x800), let OS place it.

            // Set window background color + DWM theme BEFORE showing the window
            let dark = is_system_dark_mode();
            let bg = if dark {
                Color(15, 23, 42, 255) // #0f172a
            } else {
                Color(255, 255, 255, 255) // #ffffff
            };
            let _ = window.set_background_color(Some(bg));
            #[cfg(windows)]
            if let Ok(hwnd) = window.hwnd() {
                set_dwm_dark_mode(hwnd.0, dark);
            }
            let _ = window.show();
            app.manage(database);
            app.manage(ImapPool::new());

            // Save geometry when the window is closed (e.g. title-bar close / OS quit).
            {
                let win = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        if let Some(g) = capture_geometry(&win) {
                            // Use try_lock() to avoid blocking the main thread when a sync
                            // task holds the DB mutex. Geometry save is best-effort — skip
                            // if lock is contended (mirrors the on_window_event try_lock idiom).
                            let db = app_handle.state::<Database>();
                            if let Ok(conn) = db.conn.try_lock() {
                                window_geometry::save(&conn, &g);
                            };
                        }
                    }
                });
            }

            // Initialize credentials with DB path for fallback password storage
            credentials::init(app_data_dir.join("prudii.db"));

            // Read language setting from DB for tray menu labels
            let lang = {
                let db = app.state::<Database>();
                let conn = db.lock_db();
                conn.query_row(
                    "SELECT value FROM app_settings WHERE key = 'language'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_else(|_| "en".to_string())
            };
            let (show_label, quit_label) = match lang.as_str() {
                "de" => ("Prudii Mail anzeigen", "Beenden"),
                _ => ("Show Prudii Mail", "Quit"),
            };

            let show_item = MenuItemBuilder::with_id("show", show_label).build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", quit_label).build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let tray_icon = Image::from_path("icons/32x32.png")
                .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")).unwrap());

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&tray_menu)
                .tooltip("Prudii Mail")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Some(g) = capture_geometry(&window) {
                                // Use try_lock() to avoid blocking when a sync task holds
                                // the DB mutex. Geometry save is best-effort — skip if contended.
                                let db = app.state::<Database>();
                                if let Ok(conn) = db.conn.try_lock() {
                                    window_geometry::save(&conn, &g);
                                };
                            }
                            let _ = window.close();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Register global shortcut: Ctrl+Shift+M to show/focus the window
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, _shortcut, event| {
                            if event.state() == ShortcutState::Pressed {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        })
                        .build(),
                )?;

                let shortcut =
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);
                // Unregister first in case a previous instance left it registered
                let _ = app.global_shortcut().unregister(shortcut);
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    log::warn!("Could not register global shortcut Ctrl+Shift+M: {}", e);
                }
            }

            // Check startup args for mailto: URL (e.g. launched as default mail handler)
            if let Some(mailto_url) = std::env::args().find(|a| a.starts_with("mailto:")) {
                *STARTUP_MAILTO.lock().unwrap_or_else(|e| e.into_inner()) = Some(mailto_url);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_window_theme,
            set_vibrancy,
            hide_to_tray,
            quit_app,
            get_startup_mailto,
            connectivity::check_connectivity,
            commands::connectivity::invalidate_connections,
            commands::mailto::register_mailto_handler,
            commands::mailto::unregister_mailto_handler,
            commands::mailto::is_mailto_handler,
            commands::accounts::list_accounts,
            commands::accounts::create_account,
            commands::accounts::store_account_password,
            commands::accounts::delete_account,
            commands::accounts::update_account_signature,
            commands::accounts::update_account_sync_interval,
            commands::accounts::update_account_settings,
            commands::accounts::list_folders,
            commands::accounts::create_folder,
            commands::accounts::delete_folder,
            commands::accounts::rename_folder,
            commands::accounts::update_folder_color,
            commands::accounts::test_imap_connection,
            commands::accounts::start_oauth,
            commands::mails::list_mails,
            commands::mails::list_filtered_mails,
            commands::mails::list_all_inbox_mails,
            commands::mails::get_mail,
            commands::mails::fetch_mail_body,
            commands::mails::list_attachments,
            commands::mails::get_attachment_preview,
            commands::mails::open_attachment,
            commands::mails::save_attachment,
            commands::mails::toggle_star,
            commands::mails::toggle_read,
            commands::mails::mark_as_read,
            commands::mails::trash_mail,
            commands::mails::move_mail,
            commands::mails::archive_mail,
            commands::mails::get_thread_mails,
            commands::mails::set_mail_flags,
            commands::mails::toggle_mail_flag,
            commands::mails::list_combined_folder_mails,
            commands::mails::count_folder_mails,
            commands::mails::count_searchable_mails,
            commands::mails::empty_trash,
            commands::mails::empty_spam,
            commands::mails::count_combined_folder_mails,
            commands::mails::empty_all_trash,
            commands::mails::empty_all_spam,
            commands::mails::search_contacts,
            commands::mails::prefetch_folder,
            commands::mails::unsubscribe_mail,
            commands::mails::toggle_pin,
            commands::mails::snooze_mail,
            commands::mails::unsnooze_mail,
            commands::mails::list_snoozed_mails,
            commands::mails::check_snoozed_mails,
            commands::mails::count_snoozed_mails,
            commands::mails::batch_update_mails,
            commands::settings::get_app_settings,
            commands::settings::update_app_settings,
            commands::sync::sync_account,
            commands::sync::sync_all_accounts,
            commands::sync::force_resync_account,
            commands::sync::sync_folder,
            commands::sync::search_mails,
            commands::sync::backfill_bodies,
            commands::send::send_mail,
            commands::send::test_smtp_connection,
            commands::send::save_draft,
            commands::send::schedule_send,
            commands::send::cancel_scheduled_send,
            commands::send::list_scheduled_mails,
            commands::send::check_scheduled_mails,
            commands::backup::create_backup,
            commands::backup::preview_restore,
            commands::backup::restore_backup,
            commands::rules::list_rules,
            commands::rules::create_rule,
            commands::rules::update_rule,
            commands::rules::delete_rule,
            commands::rules::apply_rules_now,
            commands::ai::check_ollama_status,
            commands::ai::summarize_mail,
            commands::ai::summarize_thread,
            commands::ai::suggest_replies,
            commands::ai::suggest_thread_replies,
            commands::ai::clear_ai_cache,
            commands::ai::ai_search_attachments,
            commands::templates::list_templates,
            commands::templates::create_template,
            commands::templates::update_template,
            commands::templates::delete_template,
            commands::license::license_login,
            commands::license::license_logout,
            commands::license::get_license_info,
            commands::license::verify_license,
            commands::license::activate_license_key,
            commands::license::check_feature,
            commands::license::get_device_id,
            commands::license::check_license_startup,
            commands::mails::classify_unclassified_mails,
            commands::mails::list_inbox_splits,
            commands::mails::create_inbox_split,
            commands::mails::update_inbox_split,
            commands::mails::delete_inbox_split,
            commands::mails::list_split_inbox_mails,
            commands::mails::search_attachments,
            commands::mails::count_attachments,
            commands::mails::bulk_save_attachments,
            commands::update::check_for_update,
            commands::update::download_and_install_update,
            commands::app_config::get_app_config,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only hide-to-tray for the main window — compose windows must close normally
                if window.label() != "main" {
                    return;
                }

                // Read show_in_tray from DB — if enabled, hide instead of quit.
                // Use try_lock() to avoid blocking the main thread when a sync
                // task holds the DB mutex (which would freeze the entire window).
                let app = window.app_handle();
                let show_in_tray = if let Some(db) = app.try_state::<Database>() {
                    if let Ok(conn) = db.conn.try_lock() {
                        conn.query_row(
                            "SELECT value FROM app_settings WHERE key = 'show_in_tray'",
                            [],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                        .map(|v| v == "1" || v == "true")
                        .unwrap_or(true)
                    } else {
                        true // DB locked by sync — default to hide instead of blocking
                    }
                } else {
                    true
                };

                if show_in_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // If !show_in_tray, allow the default close → app exits
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS: re-show the window when the user clicks the Dock icon
            // while the window is hidden (e.g. after "hide to tray").
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            let _ = (&app_handle, &event);
        });
}
