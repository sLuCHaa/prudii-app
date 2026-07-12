#!/usr/bin/env bash
# Repack the bundled AppImage without the libraries that must come from the host.
#
# linuxdeploy pulls every shared library GTK/WebKit links against into the bundle,
# including libwayland-*. Those are coupled to the host's display server and GPU
# driver ABI, and the AppRun wrapper puts the bundled copies ahead of the system
# ones on LD_LIBRARY_PATH. On distros with a much newer graphics stack than the
# Ubuntu 22.04 build host (Arch/CachyOS with current Mesa), the stale
# libwayland-egl then fails inside eglGetDisplay() and the WebKit process dies.
# The AppImage excludelist exists for exactly these libraries.
#
# Re-signs the result, because the AppImage *is* the Linux updater artifact:
# repacking it invalidates the signature the bundler produced.
set -euo pipefail

APPIMAGE_DIR="src-tauri/target/release/bundle/appimage"
APPIMAGETOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/13/appimagetool-x86_64.AppImage"

# Libraries that are known to break when shipped instead of taken from the host.
REMOVE_GLOBS=(
  'libwayland-client.so*'
  'libwayland-server.so*'
  'libwayland-egl.so*'
  'libwayland-cursor.so*'
)

# Also driver-coupled per the AppImage excludelist. Not removed automatically —
# they have never shown up in our bundle, and silently dropping them if the CI
# image changes would be a bigger gamble than reporting them.
WARN_GLOBS=(
  'libEGL.so*'
  'libGL.so*'
  'libGLdispatch.so*'
  'libGLX.so*'
  'libgbm.so*'
  'libdrm.so*'
)

appimage="$(find "$APPIMAGE_DIR" -maxdepth 1 -name '*.AppImage' -print -quit)"
if [ -z "$appimage" ]; then
  echo "No AppImage found in $APPIMAGE_DIR" >&2
  exit 1
fi
appimage="$(realpath "$appimage")"
echo "Found AppImage: $appimage"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

chmod +x "$appimage"
(cd "$workdir" && "$appimage" --appimage-extract >/dev/null)

libdir="$workdir/squashfs-root/usr/lib"
removed=0
for glob in "${REMOVE_GLOBS[@]}"; do
  while IFS= read -r -d '' lib; do
    echo "  removing bundled $(basename "$lib")"
    rm -f "$lib"
    removed=$((removed + 1))
  done < <(find "$libdir" -maxdepth 1 -name "$glob" -print0)
done

for glob in "${WARN_GLOBS[@]}"; do
  while IFS= read -r -d '' lib; do
    echo "::warning::Driver-coupled library bundled into the AppImage: $(basename "$lib") — it is on the AppImage excludelist and may need removing too."
  done < <(find "$libdir" -maxdepth 1 -name "$glob" -print0)
done

if [ "$removed" -eq 0 ]; then
  echo "::warning::No host-coupled libraries found — the bundler may no longer ship them, or the paths changed. Leaving the AppImage untouched."
  exit 0
fi
echo "Removed $removed bundled librar(ies)."

curl -fsSL "$APPIMAGETOOL_URL" -o "$workdir/appimagetool"
chmod +x "$workdir/appimagetool"

# --appimage-extract-and-run: GitHub runners have no FUSE.
ARCH=x86_64 "$workdir/appimagetool" --appimage-extract-and-run --no-appstream \
  "$workdir/squashfs-root" "$appimage"
chmod +x "$appimage"

: "${TAURI_SIGNING_PRIVATE_KEY:?private key required to re-sign the repacked AppImage}"
rm -f "${appimage}.sig"

# Pass --password only when there is one; the signer prompts on an empty value,
# which would hang the runner.
sign_args=(--private-key "$TAURI_SIGNING_PRIVATE_KEY")
if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  sign_args+=(--password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
fi
pnpm tauri signer sign "${sign_args[@]}" "$appimage"

if [ ! -f "${appimage}.sig" ]; then
  echo "Re-signing produced no ${appimage}.sig" >&2
  exit 1
fi
echo "Repacked and re-signed $appimage"
