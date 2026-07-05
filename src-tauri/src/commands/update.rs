use sha2::{Digest, Sha256};
use tauri::Emitter;

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct ReleaseInfo {
    pub version: String,
    pub file_url: String,
    pub checksum: String,
    pub release_id: String,
    pub file_name: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct UpdateProgress {
    pub status: String,
    pub progress_pct: u8,
    pub message: String,
}

/// Fetch the latest release from PocketBase and compare with current version.
/// Returns `None` if already up to date, `Some(ReleaseInfo)` if an update is available.
#[tauri::command]
pub async fn check_for_update() -> Result<Option<ReleaseInfo>, String> {
    let platform = if cfg!(target_os = "windows") {
        "windows_x64"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "macos_arm64"
        } else {
            "macos_x64"
        }
    } else {
        "linux_x64"
    };

    let url = format!(
        "https://api.prudii.com/api/collections/releases/records?filter=(platform='{}'%26%26channel='stable'%26%26is_latest=true)&perPage=1",
        platform
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server returned status {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let items = body["items"]
        .as_array()
        .ok_or("Invalid response: missing items")?;

    if items.is_empty() {
        return Ok(None);
    }

    let rel = &items[0];
    let remote_version_str = rel["version"]
        .as_str()
        .ok_or("Missing version field")?;
    let current_version_str = env!("CARGO_PKG_VERSION");

    let remote_ver = semver::Version::parse(remote_version_str)
        .map_err(|e| format!("Invalid remote version '{}': {}", remote_version_str, e))?;
    let current_ver = semver::Version::parse(current_version_str)
        .map_err(|e| format!("Invalid current version '{}': {}", current_version_str, e))?;

    if remote_ver <= current_ver {
        return Ok(None);
    }

    let release_id = rel["id"].as_str().ok_or("Missing id field")?;
    let file_field = rel["file"].as_str().ok_or("Missing file field")?;
    let checksum = rel["checksum"].as_str().unwrap_or("");

    let file_url = format!(
        "https://api.prudii.com/api/files/releases/{}/{}",
        release_id, file_field
    );

    let ext = file_field
        .rfind('.')
        .map(|i| &file_field[i..])
        .unwrap_or(".exe");
    let file_name = format!("Prudii_Mail_{}_x64-setup{}", remote_version_str, ext);

    Ok(Some(ReleaseInfo {
        version: remote_version_str.to_string(),
        file_url,
        checksum: checksum.to_string(),
        release_id: release_id.to_string(),
        file_name,
    }))
}

/// Download the update file, verify its SHA-256 checksum, and launch the installer.
/// Returns immediately; progress is emitted via `update-progress` events.
#[tauri::command]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    release: ReleaseInfo,
) -> Result<(), String> {
    // Spawn the download task so we return to the frontend immediately
    tokio::spawn(async move {
        if let Err(e) = do_download_and_install(&app, &release).await {
            let _ = app.emit(
                "update-progress",
                UpdateProgress {
                    status: "error".into(),
                    progress_pct: 0,
                    message: e,
                },
            );
        }
    });
    Ok(())
}

async fn do_download_and_install(
    app: &tauri::AppHandle,
    release: &ReleaseInfo,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let resp = reqwest::get(&release.file_url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download server returned status {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();

    let temp_dir = std::env::temp_dir();
    let ext = std::path::Path::new(&release.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("exe");
    let temp_path = temp_dir.join(format!("prudii-update-{}.{}", release.version, ext));

    let mut file = std::fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_pct: u8 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        downloaded += chunk.len() as u64;

        let pct = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8
        } else {
            0
        };

        // Only emit when percentage actually changes (avoid flooding)
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit(
                "update-progress",
                UpdateProgress {
                    status: "downloading".into(),
                    progress_pct: pct,
                    message: String::new(),
                },
            );
        }
    }

    drop(file);

    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            status: "verifying".into(),
            progress_pct: 100,
            message: String::new(),
        },
    );

    // Checksum verification is mandatory — abort if server didn't provide one
    if release.checksum.is_empty() {
        let _ = std::fs::remove_file(&temp_path);
        let _ = app.emit(
            "update-progress",
            UpdateProgress {
                status: "error".into(),
                progress_pct: 0,
                message: "No checksum provided — update rejected".into(),
            },
        );
        return Err("Update rejected: server did not provide a checksum".into());
    }

    let file_bytes = std::fs::read(&temp_path)
        .map_err(|e| format!("Failed to read downloaded file: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&file_bytes);
    let hash = format!("{:x}", hasher.finalize());

    if hash != release.checksum.to_lowercase() {
        let _ = std::fs::remove_file(&temp_path);
        let _ = app.emit(
            "update-progress",
            UpdateProgress {
                status: "error".into(),
                progress_pct: 0,
                message: "Checksum mismatch".into(),
            },
        );
        return Err("Checksum mismatch — download may be compromised".into());
    }

    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            status: "ready".into(),
            progress_pct: 100,
            message: String::new(),
        },
    );

    // Small delay so the frontend can display the "verified" message
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // Launch installer in update mode:
    // /UPDATE = install over existing version, preserve registry & shortcuts
    // /P = passive mode, no interactive dialogs
    // /R = restart the app after installation completes
    #[cfg(target_os = "windows")]
    {
        let path_str = temp_path.to_string_lossy().to_string();
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path_str, "/UPDATE", "/P", "/R"])
            .spawn()
            .map_err(|e| format!("Failed to launch installer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&temp_path)
            .spawn()
            .map_err(|e| format!("Failed to open installer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&temp_path)
            .spawn()
            .map_err(|e| format!("Failed to open installer: {}", e))?;
    }

    // Exit the app so the installer can replace the binary
    app.exit(0);

    Ok(())
}
