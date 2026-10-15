//! Time zones and the string formats calendar rows are stored in.

use chrono::{DateTime, LocalResult, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;

pub const WALL_FMT: &str = "%Y-%m-%dT%H:%M:%S";
pub const DATE_FMT: &str = "%Y-%m-%d";

pub fn system_tz() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC)
}

pub fn system_tz_name() -> String {
    system_tz().name().to_string()
}

/// IANA ids, Windows zone names (Outlook) and path-prefixed ids
/// ("/mozilla.org/20050126_1/Europe/Berlin"). None when nothing matches.
pub fn resolve_tzid(tzid: &str) -> Option<Tz> {
    let id = tzid.trim().trim_matches('"');
    if let Ok(tz) = id.parse::<Tz>() {
        return Some(tz);
    }
    let parts: Vec<&str> = id.split('/').filter(|p| !p.is_empty()).collect();
    for n in [3, 2] {
        if parts.len() > n {
            if let Ok(tz) = parts[parts.len() - n..].join("/").parse::<Tz>() {
                return Some(tz);
            }
        }
    }
    super::windows_zones::WINDOWS_TO_IANA
        .iter()
        .find(|(windows, _)| windows.eq_ignore_ascii_case(id))
        .and_then(|(_, iana)| iana.parse::<Tz>().ok())
}

/// The zone a row's wall-clock strings are in; floating and unknown ids follow the system.
pub fn row_tz(tzid: Option<&str>) -> Tz {
    tzid.and_then(resolve_tzid).unwrap_or_else(system_tz)
}

pub fn parse_wall(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, WALL_FMT).ok()
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, DATE_FMT).ok()
}

pub fn fmt_wall(n: NaiveDateTime) -> String {
    n.format(WALL_FMT).to_string()
}

pub fn fmt_date(d: NaiveDate) -> String {
    d.format(DATE_FMT).to_string()
}

/// A wall time skipped by a DST jump moves forward by the gap; an ambiguous one
/// takes the earlier instant, like most calendar apps.
pub fn wall_to_utc(tz: &Tz, wall: NaiveDateTime) -> DateTime<Utc> {
    match tz.from_local_datetime(&wall) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc),
        LocalResult::Ambiguous(earlier, _) => earlier.with_timezone(&Utc),
        LocalResult::None => tz
            .from_local_datetime(&(wall + chrono::Duration::hours(1)))
            .earliest()
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&wall)),
    }
}

pub fn utc_to_wall(tz: &Tz, utc: DateTime<Utc>) -> NaiveDateTime {
    utc.with_timezone(tz).naive_local()
}

pub fn parse_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

pub fn fmt_utc(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn wall(s: &str) -> NaiveDateTime {
        parse_wall(s).unwrap()
    }

    #[test]
    fn resolves_iana_windows_and_prefixed_ids() {
        assert_eq!(resolve_tzid("Europe/Berlin"), Some(chrono_tz::Europe::Berlin));
        assert_eq!(resolve_tzid("W. Europe Standard Time"), Some(chrono_tz::Europe::Berlin));
        assert_eq!(resolve_tzid("\"Eastern Standard Time\""), Some(chrono_tz::America::New_York));
        assert_eq!(resolve_tzid("/mozilla.org/20050126_1/Europe/Berlin"), Some(chrono_tz::Europe::Berlin));
        assert_eq!(resolve_tzid("Custom Zone"), None);
    }

    #[test]
    fn floating_rows_use_the_system_zone() {
        assert_eq!(row_tz(None), system_tz());
        assert_eq!(row_tz(Some("Asia/Tokyo")), chrono_tz::Asia::Tokyo);
        assert_eq!(row_tz(Some("nonsense")), system_tz());
    }

    #[test]
    fn wall_to_utc_handles_dst_gap_and_overlap() {
        let berlin = chrono_tz::Europe::Berlin;
        assert_eq!(fmt_utc(wall_to_utc(&berlin, wall("2026-10-15T09:00:00"))), "2026-10-15T07:00:00Z");
        // 02:30 does not exist on 29 March 2026; it moves forward by the gap.
        assert_eq!(fmt_utc(wall_to_utc(&berlin, wall("2026-03-29T02:30:00"))), "2026-03-29T01:30:00Z");
        // 02:30 happens twice on 25 October 2026; the earlier (CEST) instant wins.
        assert_eq!(fmt_utc(wall_to_utc(&berlin, wall("2026-10-25T02:30:00"))), "2026-10-25T00:30:00Z");
    }

    #[test]
    fn formats_round_trip() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 15).unwrap();
        assert_eq!(parse_date(&fmt_date(d)), Some(d));
        let w = wall("2026-10-15T09:30:00");
        assert_eq!(fmt_wall(w), "2026-10-15T09:30:00");
        let u = parse_utc("2026-10-15T07:00:00Z").unwrap();
        assert_eq!(fmt_utc(u), "2026-10-15T07:00:00Z");
        assert_eq!(parse_utc("2026-10-15T09:00:00+02:00").map(fmt_utc), Some("2026-10-15T07:00:00Z".to_string()));
        assert_eq!(utc_to_wall(&chrono_tz::Europe::Berlin, u), w - chrono::Duration::minutes(30));
    }
}
