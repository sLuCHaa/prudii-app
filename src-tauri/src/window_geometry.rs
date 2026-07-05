//! Self-managed main-window geometry: validate a saved logical rect against
//! the live monitor layout so the window always restores fully on-screen,
//! with no positional drift across restarts.

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Validate + clamp `geom` against the available `monitors` (all logical px).
/// Returns geometry fully inside the best-overlapping monitor, or None if it
/// overlaps no monitor or the values are non-finite / smaller than minimums.
pub fn validate(
    geom: WindowGeometry,
    monitors: &[Rect],
    min_w: f64,
    min_h: f64,
) -> Option<WindowGeometry> {
    if monitors.is_empty() {
        return None;
    }
    if ![geom.x, geom.y, geom.width, geom.height].iter().all(|v| v.is_finite()) {
        return None;
    }
    if geom.width < min_w || geom.height < min_h {
        return None;
    }

    fn overlap(a: &Rect, b: &Rect) -> f64 {
        let ix = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
        let iy = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
        if ix <= 0.0 || iy <= 0.0 { 0.0 } else { ix * iy }
    }

    let win = Rect { x: geom.x, y: geom.y, width: geom.width, height: geom.height };
    let best = monitors
        .iter()
        .max_by(|a, b| overlap(&win, a).partial_cmp(&overlap(&win, b)).unwrap())?;

    if overlap(&win, best) <= 0.0 {
        return None;
    }

    let w = geom.width.min(best.width);
    let h = geom.height.min(best.height);

    // Clamp position so the window sits fully inside the chosen monitor.
    let max_x = (best.x + best.width - w).max(best.x);
    let max_y = (best.y + best.height - h).max(best.y);
    let x = geom.x.clamp(best.x, max_x);
    let y = geom.y.clamp(best.y, max_y);

    Some(WindowGeometry { x, y, width: w, height: h, maximized: geom.maximized })
}

const GEOMETRY_KEY: &str = "window_geometry_main";

/// Load saved geometry from app_settings. None if missing or unparsable.
pub fn load(conn: &rusqlite::Connection) -> Option<WindowGeometry> {
    let json: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![GEOMETRY_KEY],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// Persist geometry to app_settings. Best-effort; errors are logged, not fatal.
pub fn save(conn: &rusqlite::Connection, geom: &WindowGeometry) {
    let json = match serde_json::to_string(geom) {
        Ok(j) => j,
        Err(e) => {
            log::warn!("window_geometry: serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![GEOMETRY_KEY, json],
    ) {
        log::warn!("window_geometry: save failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, width: w, height: h }
    }
    fn geom(x: f64, y: f64, w: f64, h: f64) -> WindowGeometry {
        WindowGeometry { x, y, width: w, height: h, maximized: false }
    }

    #[test]
    fn fully_visible_is_unchanged() {
        let monitors = [mon(0.0, 0.0, 1920.0, 1080.0)];
        let g = geom(100.0, 100.0, 1200.0, 800.0);
        assert_eq!(validate(g, &monitors, 900.0, 600.0), Some(g));
    }

    #[test]
    fn shifted_off_bottom_is_clamped_back_on() {
        let monitors = [mon(0.0, 0.0, 1920.0, 1080.0)];
        // y=900 + h=800 = 1700 > 1080 -> must clamp y to 1080-800 = 280
        let g = geom(100.0, 900.0, 1200.0, 800.0);
        let out = validate(g, &monitors, 900.0, 600.0).unwrap();
        assert_eq!(out.y, 280.0);
        assert_eq!(out.x, 100.0);
        assert!(out.y + out.height <= 1080.0);
    }

    #[test]
    fn off_all_monitors_returns_none() {
        // window saved on a now-disconnected second monitor at x=3000
        let monitors = [mon(0.0, 0.0, 1920.0, 1080.0)];
        let g = geom(3000.0, 100.0, 1200.0, 800.0);
        assert_eq!(validate(g, &monitors, 900.0, 600.0), None);
    }

    #[test]
    fn oversized_is_clamped_to_monitor() {
        let monitors = [mon(0.0, 0.0, 1280.0, 720.0)];
        let g = geom(0.0, 0.0, 2000.0, 1500.0);
        let out = validate(g, &monitors, 900.0, 600.0).unwrap();
        assert_eq!(out.width, 1280.0);
        assert_eq!(out.height, 720.0);
        assert!(out.x + out.width <= 1280.0);
        assert!(out.y + out.height <= 720.0);
    }

    #[test]
    fn corrupt_values_return_none() {
        let monitors = [mon(0.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(validate(geom(f64::NAN, 0.0, 1200.0, 800.0), &monitors, 900.0, 600.0), None);
        assert_eq!(validate(geom(0.0, 0.0, 10.0, 10.0), &monitors, 900.0, 600.0), None);
        assert_eq!(validate(geom(0.0, 0.0, 1200.0, 800.0), &[], 900.0, 600.0), None);
    }

    #[test]
    fn picks_monitor_with_most_overlap() {
        let monitors = [mon(0.0, 0.0, 1920.0, 1080.0), mon(1920.0, 0.0, 1920.0, 1080.0)];
        // mostly on the second monitor
        let g = geom(2000.0, 100.0, 1200.0, 800.0);
        let out = validate(g, &monitors, 900.0, 600.0).unwrap();
        assert!(out.x >= 1920.0);
        assert!(out.x + out.width <= 3840.0);
    }
}
