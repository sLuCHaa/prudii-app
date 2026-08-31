//! Unread badge on the taskbar icon (the shell's overlay icon).
//!
//! The overlay is a plain 16×16 HICON — the shell scales it for higher DPI, so
//! a single size covers every display. Drawing is split on purpose: the accent
//! circle is written straight into the DIB pixels (BGRA with premultiplied
//! alpha, what the shell's AlphaBlend-based icon drawing expects), and GDI is
//! used only for the digits. GDI knows nothing about the alpha channel and
//! zeroes it wherever it draws, so the alpha bytes are re-derived from the
//! circle geometry after the text pass.

#![cfg(windows)]

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::ptr::null_mut;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, RECT, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject,
    DrawTextW, GdiFlush, SelectObject, SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CENTER,
    DT_SINGLELINE, DT_VCENTER, FW_BOLD, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, DestroyIcon, HICON, ICONINFO};

/// Text shown in the taskbar overlay. The 16px overlay fits two digits.
pub fn badge_label(count: i64) -> Option<String> {
    match count {
        i64::MIN..=0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99".to_string()),
    }
}

const SIZE: i32 = 16;
const PIXELS: usize = (SIZE * SIZE) as usize;
/// Accent #3b82f6, in the BGR order the DIB stores.
const ACCENT: [u8; 3] = [0xf6, 0x82, 0x3b];

thread_local! {
    static TASKBAR: RefCell<Option<ITaskbarList3>> = const { RefCell::new(None) };
    /// The icon the shell was last given — destroyed once it is replaced.
    static OVERLAY: Cell<Option<HICON>> = const { Cell::new(None) };
}

/// Draw the unread count onto the taskbar icon; `None` clears the badge.
/// MUST run on the window's thread — the shell's taskbar object is
/// apartment-threaded, and the sync command calling this runs there.
pub fn set_taskbar_badge(hwnd: isize, count: Option<i64>) {
    let icon = count.and_then(badge_label).and_then(|label| draw(&label));

    if !apply(hwnd, icon) {
        // Nothing reached the shell: drop the icon just drawn rather than leak
        // it, and leave whatever is on the taskbar alone.
        if let Some(icon) = icon {
            unsafe { destroy(icon) };
        }
        return;
    }

    // The shell copies the icon, so the one it replaces can go now.
    if let Some(previous) = OVERLAY.with(|slot| slot.replace(icon)) {
        unsafe { destroy(previous) };
    }
}

/// Hand the icon (or a null one, which clears) to the taskbar. `false` means
/// the shell never saw it.
fn apply(hwnd: isize, icon: Option<HICON>) -> bool {
    let Some(list) = taskbar() else {
        return false;
    };
    let handle = icon.unwrap_or(HICON(null_mut()));
    match unsafe { list.SetOverlayIcon(HWND(hwnd as *mut _), handle, PCWSTR::null()) } {
        Ok(()) => true,
        Err(e) => {
            log::debug!("SetOverlayIcon failed: {}", e);
            false
        }
    }
}

/// The cached taskbar object, created on first use. Calls into the shell cross
/// apartments and pump messages, so the cell is never borrowed across one — a
/// re-entrant command would otherwise find it already borrowed.
fn taskbar() -> Option<ITaskbarList3> {
    if let Some(list) = TASKBAR.with(|slot| slot.borrow().clone()) {
        return Some(list);
    }
    let list = taskbar_list()?;
    TASKBAR.with(|slot| *slot.borrow_mut() = Some(list.clone()));
    Some(list)
}

/// The shell's taskbar object for this thread. WebView2 has already put the
/// thread in an STA, so RPC_E_CHANGED_MODE only confirms the apartment we
/// asked for; the matching CoUninitialize is skipped on purpose — the
/// apartment outlives us and is not ours to tear down.
fn taskbar_list() -> Option<ITaskbarList3> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            log::debug!("CoInitializeEx failed: {:?}", hr);
            return None;
        }
        let list: ITaskbarList3 =
            match CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) {
                Ok(list) => list,
                Err(e) => {
                    log::debug!("TaskbarList unavailable: {}", e);
                    return None;
                }
            };
        if let Err(e) = list.HrInit() {
            log::debug!("ITaskbarList3::HrInit failed: {}", e);
            return None;
        }
        Some(list)
    }
}

/// Render the label into a 16×16 icon: accent circle, centered white digits.
fn draw(label: &str) -> Option<HICON> {
    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = SIZE;
    info.bmiHeader.biHeight = -SIZE; // top-down
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;

    let mut bits: *mut c_void = null_mut();
    let color =
        unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0) }.ok()?;
    if bits.is_null() {
        unsafe { delete(color.into()) };
        return None;
    }

    // Alpha is a pure function of the circle geometry — kept so the text pass
    // can be undone on the alpha channel alone.
    let mut alpha = [0u8; PIXELS];
    let center = SIZE as f32 / 2.0;
    let radius = center - 0.5; // half a pixel of margin for the soft edge
    {
        let pixels = unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, PIXELS * 4) };
        for y in 0..SIZE {
            for x in 0..SIZE {
                let dx = x as f32 + 0.5 - center;
                let dy = y as f32 + 0.5 - center;
                let coverage = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
                let a = (coverage * 255.0).round() as u8;
                let i = (y * SIZE + x) as usize;
                alpha[i] = a;
                pixels[i * 4] = premultiply(ACCENT[0], a);
                pixels[i * 4 + 1] = premultiply(ACCENT[1], a);
                pixels[i * 4 + 2] = premultiply(ACCENT[2], a);
                pixels[i * 4 + 3] = a;
            }
        }
    }

    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.is_invalid() {
        unsafe { delete(color.into()) };
        return None;
    }
    let previous_bitmap = unsafe { SelectObject(dc, color.into()) };

    // 9pt for one digit, 8pt for two, as pixels at 96dpi: the icon is 16px
    // whatever the screen's DPI is, so the font must not scale with it.
    let em = if label.chars().count() > 1 { -11 } else { -12 };
    let font = unsafe {
        CreateFontW(
            em,
            0,
            0,
            0,
            FW_BOLD.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY, // ClearType's subpixel fringes would tint the digits
            0,
            w!("Segoe UI"),
        )
    };
    let previous_font = unsafe { SelectObject(dc, font.into()) };

    unsafe {
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0x00ff_ffff));
        let mut text: Vec<u16> = label.encode_utf16().collect();
        let mut rect = RECT { left: 0, top: 0, right: SIZE, bottom: SIZE };
        DrawTextW(dc, &mut text, &mut rect, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
        // GDI batches its drawing; the DIB is only current after a flush.
        let _ = GdiFlush();
    }

    // Every pixel GDI touched lost its alpha byte — put the circle's back.
    {
        let pixels = unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, PIXELS * 4) };
        for (i, a) in alpha.iter().enumerate() {
            pixels[i * 4 + 3] = *a;
        }
    }

    // Done with GDI — put the DC's own objects back and let it go before the
    // bitmap is read out of it.
    unsafe {
        SelectObject(dc, previous_font);
        SelectObject(dc, previous_bitmap);
        let _ = DeleteDC(dc);
        delete(font.into());
    }

    // CreateIconIndirect insists on a mask; an all-zero (fully opaque) one
    // leaves the shaping to the color bitmap's alpha channel.
    let blank = [0u8; PIXELS / 8];
    let mask = unsafe { CreateBitmap(SIZE, SIZE, 1, 1, Some(blank.as_ptr() as *const c_void)) };
    let icon = unsafe {
        CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        })
    };

    unsafe {
        delete(mask.into()); // CreateIconIndirect took its own copy of both
        delete(color.into());
    }

    match icon {
        Ok(icon) => Some(icon),
        Err(e) => {
            log::debug!("CreateIconIndirect failed: {}", e);
            None
        }
    }
}

fn premultiply(channel: u8, alpha: u8) -> u8 {
    ((channel as u16 * alpha as u16 + 127) / 255) as u8
}

unsafe fn delete(object: windows::Win32::Graphics::Gdi::HGDIOBJ) {
    let _ = unsafe { DeleteObject(object) };
}

unsafe fn destroy(icon: HICON) {
    let _ = unsafe { DestroyIcon(icon) };
}

#[cfg(test)]
mod tests {
    use super::badge_label;

    #[test]
    fn caps_the_label_at_two_digits() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(-3), None);
        assert_eq!(badge_label(1), Some("1".into()));
        assert_eq!(badge_label(42), Some("42".into()));
        assert_eq!(badge_label(99), Some("99".into()));
        assert_eq!(badge_label(100), Some("99".into()));
    }
}
