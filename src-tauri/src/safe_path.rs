use std::path::{Component, Path, PathBuf};

/// True for a name that is exactly one ordinary path segment — no `..`, no separator, no root or drive prefix.
pub(crate) fn is_plain_path_component(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(c)) if c == name) && components.next().is_none()
}

/// The app's own mail ids are UUIDs; anything else could steer a file operation elsewhere.
pub(crate) fn is_safe_mail_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Windows drops trailing dots and spaces, so a name made only of those is not a file name.
pub(crate) fn is_safe_file_name(name: &str) -> bool {
    is_plain_path_component(name) && !name.contains(['\\', ':', '\0']) && !name.trim_end_matches(['.', ' ']).is_empty()
}

pub(crate) fn mail_attachment_dir(data_dir: &Path, mail_id: &str) -> Option<PathBuf> {
    is_safe_mail_id(mail_id).then(|| data_dir.join("attachments").join(mail_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_mail_ids_get_a_directory() {
        let data = Path::new("data");
        for bad in ["", ".", "..", ".. ", "a/b", "a\\b", "x:y", "/etc/anna", "C:\\anna", "../anna"] {
            assert!(mail_attachment_dir(data, bad).is_none(), "{bad:?}");
        }
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(mail_attachment_dir(data, &id), Some(data.join("attachments").join(&id)));
    }

    #[test]
    fn file_names_may_hold_spaces_umlauts_and_dots() {
        for good in ["Angebot März 2026.v2.pdf", ".profile", "a..b.txt"] {
            assert!(is_safe_file_name(good), "{good:?}");
        }
        for bad in ["", ".", "..", ".. ", "...", "a/b", "a\\b", "x:y", "/etc/anna"] {
            assert!(!is_safe_file_name(bad), "{bad:?}");
        }
    }
}
