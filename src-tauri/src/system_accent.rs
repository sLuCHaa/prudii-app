// The OS accent is read on demand (start-up, accent switch) — no live listener;
// the user re-selects "System" or restarts to pick up a changed OS colour.
#[cfg(windows)]
pub fn system_accent_hex() -> Option<String> {
    use windows::UI::ViewManagement::{UIColorType, UISettings};
    let settings = UISettings::new().ok()?;
    let c = settings.GetColorValue(UIColorType::Accent).ok()?;
    Some(format!("#{:02x}{:02x}{:02x}", c.R, c.G, c.B))
}

// Verified against ~/.cargo/registry/src/*/objc2-app-kit-0.3.2/src/generated/{NSColor,NSColorSpace}.rs:
// controlAccentColor (line 630-632), sRGBColorSpace (NSColorSpace.rs line 122-124),
// colorUsingColorSpace (line 310-312) and the three component getters (line 717-729) are
// all plain `pub fn` — only the ObjC selector itself carries `#[unsafe(method(..))]`, the
// generated Rust signatures are safe — so no `unsafe { }` blocks are needed here.
// colorUsingColorSpace returns Option<Retained<NSColor>> as the brief assumed; CGFloat
// resolves to f64 on 64-bit macOS (objc2_core_foundation::geometry::CGFloat), matching
// the `f64` closure parameter below.
#[cfg(target_os = "macos")]
pub fn system_accent_hex() -> Option<String> {
    use objc2_app_kit::{NSColor, NSColorSpace};
    let accent = NSColor::controlAccentColor();
    let srgb = NSColorSpace::sRGBColorSpace();
    let c = accent.colorUsingColorSpace(&srgb)?;
    let to8 = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(format!("#{:02x}{:02x}{:02x}", to8(c.redComponent()), to8(c.greenComponent()), to8(c.blueComponent())))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn system_accent_hex() -> Option<String> {
    None
}

#[tauri::command]
pub fn get_system_accent_color() -> Option<String> {
    system_accent_hex()
}
