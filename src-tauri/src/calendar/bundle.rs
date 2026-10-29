//! Many calendar files at once: plain .ics files and ZIP exports such as Google's.

use super::ical::parse_calendar;
use super::store::{create_calendar_impl, import_ics_impl, is_valid_color};
use super::{BundleCalendarResult, BundleFailure, BundleImportResult, SUBSCRIPTION};
use crate::db::Database;
use rusqlite::params;
use std::io::{Read, Seek};
use std::path::Path;

/// Same order as `CALENDAR_COLORS` in `src/lib/calendar/palette.ts`.
pub const CALENDAR_PALETTE: [&str; 8] = ["#3b82f6", "#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const ICS_EXTENSIONS: [&str; 3] = ["ics", "ical", "icalendar"];

pub struct ZipLimits {
    pub entries: usize,
    pub entry_bytes: u64,
    pub total_bytes: u64,
}

pub const ZIP_LIMITS: ZipLimits = ZipLimits { entries: 200, entry_bytes: 20 * 1024 * 1024, total_bytes: 100 * 1024 * 1024 };

#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    /// Shown in failure lists: the file name, or `zip/entry` inside an archive.
    pub label: String,
    pub name_hint: String,
    pub text: String,
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn stem(name: &str) -> String {
    Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string()
}

fn is_calendar_file(name: &str) -> bool {
    Path::new(name).extension().and_then(|e| e.to_str()).is_some_and(|e| ICS_EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn failure(file: &str, reason: &str) -> BundleFailure {
    BundleFailure { file: file.to_string(), reason: reason.to_string() }
}

/// Calendar files inside a ZIP, read through capped readers so a crafted archive cannot balloon.
pub fn sources_from_zip<R: Read + Seek>(reader: R, label: &str, limits: &ZipLimits) -> Result<(Vec<Source>, Vec<BundleFailure>), String> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|_| "calendar.errors.notCalendar".to_string())?;
    let mut wanted = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| "calendar.errors.notCalendar".to_string())?;
        let Ok(name) = entry.name().map(|n| n.into_owned()) else { continue };
        let base = base_name(&name);
        if !entry.is_dir() && !name.starts_with("__MACOSX/") && !base.starts_with('.') && is_calendar_file(base) {
            wanted.push((i, name));
        }
    }
    if wanted.len() > limits.entries {
        return Err("calendar.errors.fileTooLarge".into());
    }
    let (mut sources, mut failed, mut total) = (Vec::new(), Vec::new(), 0u64);
    for (i, name) in wanted {
        let entry_label = format!("{}/{}", label, name);
        let mut buf = Vec::new();
        let read = archive.by_index(i).map_err(|e| e.to_string()).and_then(|entry| {
            entry.take(limits.entry_bytes + 1).read_to_end(&mut buf).map_err(|e| e.to_string())
        });
        if read.is_err() {
            failed.push(failure(&entry_label, "calendar.errors.notCalendar"));
            continue;
        }
        let size = buf.len() as u64;
        if size > limits.entry_bytes || total + size > limits.total_bytes {
            failed.push(failure(&entry_label, "calendar.errors.fileTooLarge"));
            continue;
        }
        total += size;
        sources.push(Source { label: entry_label, name_hint: stem(base_name(&name)), text: String::from_utf8_lossy(&buf).into_owned() });
    }
    Ok((sources, failed))
}

pub fn sources_from_path(path: &Path) -> (Vec<Source>, Vec<BundleFailure>) {
    let label = path.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string();
    let fail = |reason: &str| (Vec::new(), vec![failure(&label, reason)]);
    let Ok(meta) = std::fs::metadata(path) else { return fail("calendar.errors.notFound") };
    if meta.len() > MAX_FILE_BYTES {
        return fail("calendar.errors.fileTooLarge");
    }
    if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
        let Ok(file) = std::fs::File::open(path) else { return fail("calendar.errors.notFound") };
        return sources_from_zip(file, &label, &ZIP_LIMITS).unwrap_or_else(|reason| fail(&reason));
    }
    match std::fs::read(path) {
        Ok(bytes) => (vec![Source { name_hint: stem(&label), label, text: String::from_utf8_lossy(&bytes).into_owned() }], Vec::new()),
        Err(_) => fail("calendar.errors.notFound"),
    }
}

/// `X-APPLE-CALENDAR-COLOR` as `#rrggbb`; Apple appends an alpha byte.
pub fn feed_color(raw: Option<&str>) -> Option<String> {
    let hex = raw?.trim().strip_prefix('#')?;
    if !hex.is_ascii() {
        return None;
    }
    let rgb = match hex.len() {
        6 => hex,
        8 => &hex[..6],
        _ => return None,
    };
    let color = format!("#{}", rgb.to_ascii_lowercase());
    is_valid_color(&color).then_some(color)
}

/// First local calendar with this name, ignoring case and surrounding space.
fn local_calendar_named(db: &Database, name: &str) -> Option<String> {
    let wanted = name.trim().to_lowercase();
    let conn = db.lock_db();
    let mut stmt = conn.prepare("SELECT id, name FROM calendars WHERE source != ?1 ORDER BY sort_order, created_at").ok()?;
    let rows = stmt.query_map(params![SUBSCRIPTION], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()?;
    let found = rows.filter_map(Result::ok).find(|(_, n)| n.trim().to_lowercase() == wanted).map(|(id, _)| id);
    found
}

fn next_palette_color(db: &Database) -> String {
    let count: i64 = db.lock_db().query_row("SELECT COUNT(*) FROM calendars", [], |r| r.get(0)).unwrap_or(0);
    CALENDAR_PALETTE[count as usize % CALENDAR_PALETTE.len()].to_string()
}

pub(crate) fn import_sources_impl(db: &Database, sources: Vec<Source>, untitled: &str) -> BundleImportResult {
    let mut result = BundleImportResult::default();
    for source in sources {
        let parsed = parse_calendar(&source.text);
        if parsed.events.is_empty() {
            let reason = if parsed.has_calendar { "calendar.errors.noEvents" } else { "calendar.errors.notCalendar" };
            result.failed.push(failure(&source.label, reason));
            continue;
        }
        let name = parsed
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(100).collect::<String>())
            .or_else(|| Some(source.name_hint.trim().to_string()).filter(|n| !n.is_empty()))
            .unwrap_or_else(|| untitled.to_string());
        let (calendar_id, created) = match local_calendar_named(db, &name) {
            Some(id) => (id, false),
            None => {
                let color = feed_color(parsed.color.as_deref()).unwrap_or_else(|| next_palette_color(db));
                match create_calendar_impl(db, &name, &color) {
                    Ok(c) => (c.id, true),
                    Err(reason) => {
                        result.failed.push(failure(&source.label, &reason));
                        continue;
                    }
                }
            }
        };
        match import_ics_impl(db, &calendar_id, &source.text) {
            Ok(r) => result.calendars.push(BundleCalendarResult {
                calendar_id,
                name,
                created,
                imported: r.imported,
                updated: r.updated,
                skipped: r.skipped,
            }),
            Err(reason) => result.failed.push(failure(&source.label, &reason)),
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::store::{list_calendars_impl, list_occurrences_impl};
    use crate::db::Database;
    use std::io::{Cursor, Write};

    const ALEX: &str = "BEGIN:VCALENDAR\nX-WR-CALNAME:Alex\nX-APPLE-CALENDAR-COLOR:#FF2968FF\nBEGIN:VEVENT\nUID:a1@test\n\
DTSTART:20261015T090000Z\nDTEND:20261015T100000Z\nSUMMARY:Gym\nEND:VEVENT\nEND:VCALENDAR\n";
    const FAMILY: &str = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:f1@test\nDTSTART:20261016T090000Z\nDTEND:20261016T100000Z\n\
SUMMARY:Dinner\nEND:VEVENT\nEND:VCALENDAR\n";

    fn temp_db() -> Database {
        let db = Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap();
        list_calendars_impl(&db, "Mine").unwrap();
        db
    }

    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            if name.ends_with('/') {
                zip.add_directory(name.trim_end_matches('/'), opts).unwrap();
            } else {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data.as_bytes()).unwrap();
            }
        }
        zip.finish().unwrap().into_inner()
    }

    fn source(label: &str, name_hint: &str, text: &str) -> Source {
        Source { label: label.into(), name_hint: name_hint.into(), text: text.into() }
    }

    #[test]
    fn zip_exports_yield_their_calendar_files_only() {
        let bytes = zip_of(&[
            ("Calendar/", ""),
            ("Calendar/alex@gmail.com.ics", ALEX),
            ("Calendar/Family.ICS", FAMILY),
            ("__MACOSX/Calendar/._Family.ics", "junk"),
            ("Calendar/.hidden.ics", "junk"),
            ("notes.txt", "hello"),
        ]);
        let (sources, failed) = sources_from_zip(Cursor::new(bytes), "export.zip", &ZIP_LIMITS).unwrap();
        assert!(failed.is_empty());
        let got: Vec<(&str, &str)> = sources.iter().map(|s| (s.label.as_str(), s.name_hint.as_str())).collect();
        assert_eq!(got, vec![("export.zip/Calendar/alex@gmail.com.ics", "alex@gmail.com"), ("export.zip/Calendar/Family.ICS", "Family")]);
    }

    #[test]
    fn zip_limits_reject_too_many_or_too_large_entries() {
        let names: Vec<String> = (0..4).map(|i| format!("c{}.ics", i)).collect();
        let many: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), FAMILY)).collect();
        let tight = ZipLimits { entries: 3, entry_bytes: 10_000, total_bytes: 10_000 };
        assert_eq!(sources_from_zip(Cursor::new(zip_of(&many)), "x.zip", &tight).unwrap_err(), "calendar.errors.fileTooLarge");

        let big = "A".repeat(900);
        let bytes = zip_of(&[("small.ics", FAMILY), ("big.ics", big.as_str()), ("tail.ics", FAMILY)]);
        let per_entry = ZipLimits { entries: 10, entry_bytes: 500, total_bytes: 10_000 };
        let (sources, failed) = sources_from_zip(Cursor::new(bytes.clone()), "x.zip", &per_entry).unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!((failed[0].file.as_str(), failed[0].reason.as_str()), ("x.zip/big.ics", "calendar.errors.fileTooLarge"));

        let total = ZipLimits { entries: 10, entry_bytes: 10_000, total_bytes: 1_000 };
        let (sources, failed) = sources_from_zip(Cursor::new(bytes), "x.zip", &total).unwrap();
        let kept: Vec<&str> = sources.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(kept, vec!["x.zip/small.ics", "x.zip/tail.ics"]);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].file, "x.zip/big.ics");
    }

    #[test]
    fn apple_colors_lose_their_alpha_and_bad_colors_are_dropped() {
        assert_eq!(feed_color(Some("#FF2968FF")).as_deref(), Some("#ff2968"));
        assert_eq!(feed_color(Some(" #1BADF8 ")).as_deref(), Some("#1badf8"));
        assert_eq!(feed_color(Some("red")), None);
        assert_eq!(feed_color(Some("#12")), None);
        assert_eq!(feed_color(None), None);
        assert_eq!(feed_color(Some("#aaaaaéa")), None);
        assert_eq!(feed_color(Some("#ééé")), None);
    }

    #[test]
    fn each_source_becomes_a_calendar_and_reimports_merge() {
        let db = temp_db();
        let sources = || vec![source("a.ics", "alex@gmail.com", ALEX), source("Family.ics", "Family", FAMILY)];
        let first = import_sources_impl(&db, sources(), "Imported");
        assert!(first.failed.is_empty());
        let made: Vec<(&str, bool, u32)> = first.calendars.iter().map(|c| (c.name.as_str(), c.created, c.imported)).collect();
        assert_eq!(made, vec![("Alex", true, 1), ("Family", true, 1)]);
        let calendars = list_calendars_impl(&db, "Mine").unwrap();
        assert_eq!(calendars.len(), 3);
        assert_eq!(calendars.iter().find(|c| c.name == "Alex").unwrap().color, "#ff2968");
        assert!(calendars.iter().filter(|c| c.name != "Mine").all(|c| !c.is_default && !c.read_only));

        let again = import_sources_impl(&db, sources(), "Imported");
        assert!(again.calendars.iter().all(|c| !c.created && c.updated == 1));
        assert_eq!(list_calendars_impl(&db, "Mine").unwrap().len(), 3);
    }

    #[test]
    fn names_match_local_calendars_case_insensitively() {
        let db = temp_db();
        let mine = list_calendars_impl(&db, "Mine").unwrap().remove(0);
        let result = import_sources_impl(&db, vec![source("x.ics", "MINE", FAMILY)], "Imported");
        assert_eq!((result.calendars[0].calendar_id.as_str(), result.calendars[0].created), (mine.id.as_str(), false));
        let occ = list_occurrences_impl(&db, "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z", Some(vec![mine.id])).unwrap();
        assert_eq!(occ[0].title, "Dinner");
    }

    #[test]
    fn broken_sources_are_reported_and_untitled_ones_get_the_fallback_name() {
        let db = temp_db();
        let empty = "BEGIN:VCALENDAR\nX-WR-CALNAME:Empty\nEND:VCALENDAR\n";
        let result = import_sources_impl(
            &db,
            vec![source("page.ics", "page", "<html>no</html>"), source("empty.ics", "empty", empty), source("x.ics", "  ", FAMILY)],
            "Imported",
        );
        let reasons: Vec<(&str, &str)> = result.failed.iter().map(|f| (f.file.as_str(), f.reason.as_str())).collect();
        assert_eq!(reasons, vec![("page.ics", "calendar.errors.notCalendar"), ("empty.ics", "calendar.errors.noEvents")]);
        assert_eq!(result.calendars[0].name, "Imported");
    }

    #[test]
    fn picked_files_resolve_to_sources() {
        let dir = std::env::temp_dir().join(format!("prudii-bundle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ics = dir.join("Family.ics");
        std::fs::write(&ics, FAMILY).unwrap();
        let zip_path = dir.join("takeout.zip");
        std::fs::write(&zip_path, zip_of(&[("Calendar/alex.ics", ALEX)])).unwrap();
        let (one, _) = sources_from_path(&ics);
        assert_eq!((one[0].label.as_str(), one[0].name_hint.as_str()), ("Family.ics", "Family"));
        let (two, _) = sources_from_path(&zip_path);
        assert_eq!(two[0].label, "takeout.zip/Calendar/alex.ics");
        let (none, failed) = sources_from_path(&dir.join("missing.ics"));
        assert!(none.is_empty());
        assert_eq!(failed[0].reason, "calendar.errors.notFound");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
