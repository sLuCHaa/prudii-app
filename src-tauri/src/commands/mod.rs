pub mod accounts;
pub mod ai;
pub mod app_config;
pub mod backup;
pub mod connectivity;
pub mod license;
pub mod mails;
pub mod mailto;
pub mod rules;
pub mod send;
pub mod settings;
pub mod sync;
pub mod templates;
pub mod update;

/// Wraps a command body in catch_unwind to prevent panics from crashing the app.
/// Sync Tauri commands run inside the WebView2 callback context on Windows;
/// a panic there crosses an FFI boundary and aborts the process (STATUS_STACK_BUFFER_OVERRUN).
pub fn catch_panic<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(panic_info) => {
            let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown internal error".to_string()
            };
            log::error!("Command panic caught: {}", msg);
            Err(format!("Internal error: {}", msg))
        }
    }
}
