#![cfg(windows)]

/// Text shown in the taskbar overlay. The 16px overlay fits two digits.
pub fn badge_label(count: i64) -> Option<String> {
    match count {
        i64::MIN..=0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99".to_string()),
    }
}

/// Filled in by the GDI/ITaskbarList3 task.
pub fn set_taskbar_badge(_hwnd: isize, _count: Option<i64>) {}

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
