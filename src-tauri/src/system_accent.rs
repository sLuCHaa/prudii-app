// The OS accent is read on demand (start-up, accent switch) — no live listener;
// the user re-selects "System" or restarts to pick up a changed OS colour.
#[cfg(windows)]
pub fn system_accent_hex() -> Option<String> {
    use windows::UI::ViewManagement::{UIColorType, UISettings};
    let settings = UISettings::new().ok()?;
    let c = settings.GetColorValue(UIColorType::Accent).ok()?;
    Some(format!("#{:02x}{:02x}{:02x}", c.R, c.G, c.B))
}

// controlAccentColor may report a non-sRGB colour space, so it is converted to
// sRGB explicitly before the RGB components are read out.
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
