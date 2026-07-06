# Design: GitHub-based signed auto-updates

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Scope:** Replace the PocketBase-backed custom updater with the official Tauri
updater plugin, using GitHub Releases as the single source of truth.

## Motivation

Today every release must be maintained in **three places** by hand: build &
upload the installer, create the PocketBase `releases` record (version, file,
checksum), and flip `is_latest` per platform. This is error-prone and couples
releases to self-hosted PocketBase infrastructure.

The CI already builds and publishes signed-ready artifacts to GitHub Releases.
Moving the updater to GitHub makes the release a **single action** — push a tag,
CI builds + signs + publishes installers and `latest.json` — and upgrades the
security model from a server-provided checksum to a cryptographic signature.

## Goals

- Single source of truth for releases: GitHub Releases.
- Cryptographically **signed** updates (minisign), verified on-device.
- Remove PocketBase from the update path entirely.
- Keep the existing update UX (top banner + settings panel with progress).
- Zero manual per-release maintenance beyond pushing a version tag.

## Non-goals (YAGNI)

- Beta / multiple release channels (stable only).
- Delta/differential updates.
- Auto-update for Linux `.deb`/`.rpm` (not supported by the Tauri updater).

## Current state (to be removed)

- `src-tauri/src/commands/update.rs`: custom `check_for_update` (queries
  `api.prudii.com/.../collections/releases`, semver-compares) and
  `download_and_install_update` (streams file, verifies **SHA-256 checksum**,
  launches installer per-OS, exits app).
- Commands registered in `src-tauri/src/lib.rs`.
- Frontend wrappers `checkForUpdate` / `downloadAndInstallUpdate` in
  `src/lib/tauri.ts`.
- Security weakness: the checksum is served by the same server as the file, so
  it protects only against corruption, not a compromised update server.

PocketBase remains in use for app-config/licenses; **only the `releases` path is
removed.**

## Target architecture

### Components removed
- `src-tauri/src/commands/update.rs` and its two commands (unregister in `lib.rs`).
- `checkForUpdate` / `downloadAndInstallUpdate` wrappers in `src/lib/tauri.ts`.
- The PocketBase `releases` collection dependency.

### Components added
- Rust: `tauri-plugin-updater` + `tauri-plugin-process` (for relaunch),
  registered in the `lib.rs` builder.
- JS: `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`.
- `tauri.conf.json`:
  - `plugins.updater.endpoints`:
    `["https://github.com/sLuCHaa/prudii-app/releases/latest/download/latest.json"]`
  - `plugins.updater.pubkey`: the updater public key.
  - `bundle.createUpdaterArtifacts: true`.
- Updater/process permissions in the capabilities file (`updater:default`,
  `process:allow-relaunch`).

### Components kept (rewired to the plugin)
- `src/components/ui/UpdateBanner.tsx` and
  `src/components/settings/UpdatePanel.tsx`: same UX, but call the plugin
  (`check()` / `update.downloadAndInstall()`) instead of the removed Rust
  commands. The `ReleaseInfo` shape is replaced by the plugin's `Update` object
  (`version`, `body`, `date`, `downloadAndInstall`).

## Update flow

1. Trigger: on startup, every 6h, and on network reconnect (same cadence as
   today), the frontend calls the plugin's `check()`.
2. `check()` fetches `latest.json` from the GitHub "latest **published**
   release" alias and compares its `version` to the running app version.
3. If newer → show the non-blocking banner (existing UX).
4. On user action → `update.downloadAndInstall(onProgress)`:
   - progress events drive the existing progress UI,
   - the plugin **verifies the minisign signature** against the embedded pubkey,
   - installs: macOS swaps the `.app`, Windows runs the NSIS installer, Linux
     replaces the AppImage.
5. `relaunch()` restarts the app on the new version.

Because CI publishes **draft** releases, the `latest.json` alias only resolves
once a release is **published** — updates never go live before you click
"Publish". This is a deliberate safety property.

## Signing & keys

- Generate a keypair with `tauri signer generate`.
- **Public key** → committed in `tauri.conf.json` (`plugins.updater.pubkey`).
- **Private key + password** → two GitHub Actions secrets:
  `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- CI signs the bundles with the private key and `tauri-action` generates and
  uploads `latest.json`.
- The private key is the trust root for all updates. It must be stored securely
  and never committed. Key loss/rotation would require existing clients to
  reinstall manually (they can only verify updates signed by the original key).

## Platform matrix

| OS | Auto-update artifact | First install |
|---|---|---|
| Windows | NSIS `.exe` (referenced in `latest.json`) | `.exe` / `.msi` |
| macOS (ARM + Intel) | per-arch `.app.tar.gz` (signed) | `.dmg` |
| Linux | **AppImage** (seamless in-place) | `.deb` / `.rpm` — update banner links to the release page, no auto-install |

## CI changes

- Enable `bundle.createUpdaterArtifacts: true`.
- Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the
  `tauri-action` step `env` in `.github/workflows/release.yml`.
- Set `updaterJsonPreferNsis: true` on the `tauri-action` step so `latest.json`
  references the **NSIS** installer on Windows (default prefers MSI). NSIS
  matches the platform matrix and supports silent, non-admin in-place updates,
  consistent with today's behavior.
- `tauri-action` uploads `latest.json` automatically (`uploadUpdaterJson`
  default on). No other workflow changes; the matrix already builds all targets.
- Result: pushing a `vX.Y.Z` tag produces a fully signed release with a valid
  `latest.json` — no manual steps.

## Migration of existing users

Existing installs run the PocketBase updater. Transition plan:

1. Ship the new plugin-based version (e.g. `v1.2.0`) via GitHub as usual.
2. Do **one final** PocketBase `releases` update pointing at that new installer,
   so current users get pulled onto the plugin-based build.
3. After that release, all future updates flow through GitHub; the PocketBase
   `releases` collection can be retired.

(For a small user base, step 2 can be skipped in favor of a manual re-download.)

## Security considerations

- Upgrade from checksum-of-same-origin to minisign signature verification: a
  compromised release host can no longer serve a malicious update.
- HTTPS-only endpoints; the plugin refuses unsigned or mis-signed bundles.
- Draft-release gating means an accidental/early build is not served to users.

## Testing / verification

- Build a `vX.Y.Z-rc` on a test tag; confirm `latest.json` is generated, signed,
  and uploaded to the release.
- From an older installed version, confirm the banner appears, the download +
  signature verification succeed, and the app relaunches on the new version, on:
  Windows (NSIS), macOS ARM, macOS Intel, Linux AppImage.
- Confirm `.deb` install shows the "update available" banner but does not
  attempt an auto-install.
- Negative test: a bundle signed with a wrong key is rejected.

## Open operational items (for the user)

- Store the two signing secrets in the repo after key generation.
- Decide whether to run the one-time PocketBase transition release (step 2 above).
