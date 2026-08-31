//! Windows 11 caption integration for the frameless windows.
//!
//! Both windows draw their own title bar, so Windows knows nothing about the
//! maximize button — no Snap Layouts flyout on hover, no native handling.
//! The frontend reports the maximize button's client rect; a window subclass
//! answers WM_NCHITTEST with HTMAXBUTTON for that rect, which makes Windows 11
//! show the Snap flyout. The click is then a non-client event, handled here.
//! Hover no longer reaches the webview either, so it is mirrored back as a
//! window event for the CSS state.
//!
//! The system menu (right-click on the title bar) is NOT solved via hit-test:
//! the bar contains interactive webview elements, and reporting it as
//! HTCAPTION would swallow their clicks. The frontend forwards the context
//! click instead and `show_system_menu` opens the real GetSystemMenu.

#![cfg(windows)]

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::Emitter;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMenu, GetWindowLongPtrW, PostMessageW, SetForegroundWindow, TrackPopupMenu,
    EnableMenuItem, GWL_STYLE, HTCLIENT, HTMAXBUTTON, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED,
    SC_MAXIMIZE, SC_MOVE, SC_RESTORE, SC_SIZE, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_DESTROY,
    WM_MOUSEMOVE, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE,
    WM_NCMOUSEMOVE, WM_SYSCOMMAND, WS_MAXIMIZE,
};

struct CaptionState {
    /// Maximize button rect in physical client coordinates.
    max_rect: RECT,
    app: tauri::AppHandle,
    label: String,
    hovered: bool,
}

static STATES: LazyLock<Mutex<HashMap<isize, CaptionState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const SUBCLASS_ID: usize = 0x5052_5544; // "PRUD"

fn scale_of(hwnd: HWND) -> f64 {
    (unsafe { GetDpiForWindow(hwnd) }) as f64 / 96.0
}

/// Register (or update) the maximize button rect for a window and install the
/// subclass on first call. MUST run on the window's thread — the sync command
/// calling this executes inside the WebView callback, which satisfies that.
pub fn set_max_button_rect(app: &tauri::AppHandle, label: &str, hwnd: isize, x: f64, y: f64, w: f64, h: f64) {
    let handle = HWND(hwnd as *mut _);
    let scale = scale_of(handle);
    let rect = RECT {
        left: (x * scale).round() as i32,
        top: (y * scale).round() as i32,
        right: ((x + w) * scale).round() as i32,
        bottom: ((y + h) * scale).round() as i32,
    };

    let mut states = STATES.lock().unwrap_or_else(|p| p.into_inner());
    let install = !states.contains_key(&hwnd);
    states
        .entry(hwnd)
        .and_modify(|s| s.max_rect = rect)
        .or_insert_with(|| CaptionState {
            max_rect: rect,
            app: app.clone(),
            label: label.to_string(),
            hovered: false,
        });
    drop(states);

    if install {
        unsafe {
            let _ = SetWindowSubclass(handle, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }
}

/// Open the native window menu (move/size/minimize/maximize/close) at logical
/// client coordinates. MUST run on the window's thread (sync command).
pub fn show_system_menu(hwnd: isize, x: f64, y: f64) {
    unsafe {
        let handle = HWND(hwnd as *mut _);
        let scale = scale_of(handle);
        let mut pt = POINT {
            x: (x * scale).round() as i32,
            y: (y * scale).round() as i32,
        };
        let _ = ClientToScreen(handle, &mut pt);

        let menu = GetSystemMenu(handle, false);
        if menu.is_invalid() {
            return;
        }
        // GetSystemMenu's item states are static — reflect the actual window
        // state the way DefWindowProc would.
        let maximized = (GetWindowLongPtrW(handle, GWL_STYLE) as u32 & WS_MAXIMIZE.0) != 0;
        let on = |enabled: bool| if enabled { MF_ENABLED } else { MF_GRAYED };
        let _ = EnableMenuItem(menu, SC_RESTORE, MF_BYCOMMAND | on(maximized));
        let _ = EnableMenuItem(menu, SC_MAXIMIZE, MF_BYCOMMAND | on(!maximized));
        let _ = EnableMenuItem(menu, SC_MOVE, MF_BYCOMMAND | on(!maximized));
        let _ = EnableMenuItem(menu, SC_SIZE, MF_BYCOMMAND | on(!maximized));

        let _ = SetForegroundWindow(handle);
        let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, None, handle, None);
        if cmd.as_bool() {
            let _ = PostMessageW(Some(handle), WM_SYSCOMMAND, WPARAM(cmd.0 as usize), LPARAM(0));
        }
    }
}

fn set_hovered(hwnd: isize, hovered: bool) {
    let mut states = STATES.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(state) = states.get_mut(&hwnd) {
        if state.hovered != hovered {
            state.hovered = hovered;
            let _ = state.app.emit_to(state.label.as_str(), "caption-max-hover", hovered);
        }
    }
}

fn point_in(rect: &RECT, pt: POINT) -> bool {
    pt.x >= rect.left && pt.x < rect.right && pt.y >= rect.top && pt.y < rect.bottom
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    let key = hwnd.0 as isize;
    match msg {
        WM_NCHITTEST => {
            let def = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            if def.0 == HTCLIENT as isize {
                // Screen coordinates, signed (multi-monitor setups go negative).
                let mut pt = POINT {
                    x: (lparam.0 & 0xFFFF) as i16 as i32,
                    y: ((lparam.0 >> 16) & 0xFFFF) as i16 as i32,
                };
                let _ = unsafe { ScreenToClient(hwnd, &mut pt) };
                let states = STATES.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(state) = states.get(&key) {
                    if point_in(&state.max_rect, pt) {
                        return LRESULT(HTMAXBUTTON as isize);
                    }
                }
            }
            def
        }
        WM_NCMOUSEMOVE => {
            set_hovered(key, wparam.0 == HTMAXBUTTON as usize);
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        // Back in the client area (or gone entirely) — clear the hover state.
        WM_MOUSEMOVE | WM_NCMOUSELEAVE => {
            set_hovered(key, false);
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        // Swallow the down — the default proc would enter its own tracking loop.
        WM_NCLBUTTONDOWN if wparam.0 == HTMAXBUTTON as usize => LRESULT(0),
        WM_NCLBUTTONUP if wparam.0 == HTMAXBUTTON as usize => {
            set_hovered(key, false);
            let maximized =
                (unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32 & WS_MAXIMIZE.0) != 0;
            let cmd = if maximized { SC_RESTORE } else { SC_MAXIMIZE };
            let _ = unsafe { PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(cmd as usize), LPARAM(0)) };
            LRESULT(0)
        }
        WM_DESTROY => {
            STATES.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}
