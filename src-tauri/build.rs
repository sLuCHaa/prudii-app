use std::fs;
use std::path::Path;

/// The Gmail OAuth client secret is injected at compile time and never
/// checked into the repository. Sources, in order: the
/// PRUDII_GOOGLE_CLIENT_SECRET environment variable, then a git-ignored
/// `.env.local` file next to Cargo.toml.
fn google_client_secret() -> String {
    if let Ok(secret) = std::env::var("PRUDII_GOOGLE_CLIENT_SECRET") {
        if !secret.is_empty() {
            return secret;
        }
    }
    let env_local = Path::new(env!("CARGO_MANIFEST_DIR")).join(".env.local");
    if let Ok(contents) = fs::read_to_string(env_local) {
        for line in contents.lines() {
            if let Some(value) = line.strip_prefix("PRUDII_GOOGLE_CLIENT_SECRET=") {
                return value.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

fn main() {
    let secret = google_client_secret();
    if secret.is_empty() {
        println!("cargo:warning=PRUDII_GOOGLE_CLIENT_SECRET is not set; Gmail sign-in will not work in this build");
    }
    println!("cargo:rustc-env=PRUDII_GOOGLE_CLIENT_SECRET={secret}");
    println!("cargo:rerun-if-env-changed=PRUDII_GOOGLE_CLIENT_SECRET");
    println!("cargo:rerun-if-changed=.env.local");
    tauri_build::build()
}
