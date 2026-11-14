#!/usr/bin/env bash
# Give the existing development host a bundle identity without changing the NSH installation.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "The bundled development host requires macOS." >&2
  exit 1
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cli="$(bun -e 'import { realpathSync } from "node:fs"; const p = Bun.which("nsh"); if (!p) throw new Error("nsh is not installed"); console.log(realpathSync(p));')"
host="$(dirname "$cli")/../runtime/macos/nsh-macos-host"
if [[ ! -x "$host" ]]; then
  echo "No installed macOS development host beside $cli" >&2
  exit 1
fi
runtime="$root/.nsh/dev-runtime"
app="$runtime/macos/OnlyOne Development.app"
mkdir -p "$runtime/macos"
work="$(mktemp -d "$runtime/.prepare.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cat > "$work/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.onlyone.app.development</string>
  <key>CFBundleName</key><string>OnlyOne Development</string>
  <key>CFBundleExecutable</key><string>nsh-macos-host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>OnlyOne uses the microphone for voice input.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>OnlyOne transcribes your voice input.</string>
</dict></plist>
PLIST
shasum -a 256 "$host" | cut -d ' ' -f 1 > "$work/host.sha256"
# Keep the signed bundle unchanged between runs so its system permissions stay stable.
if ! cmp -s "$work/host.sha256" "$runtime/host.sha256" ||
   ! cmp -s "$work/Info.plist" "$app/Contents/Info.plist" ||
   ! codesign --verify --strict "$app" 2>/dev/null; then
  mkdir -p "$work/OnlyOne Development.app/Contents/MacOS"
  cp "$host" "$work/OnlyOne Development.app/Contents/MacOS/nsh-macos-host"
  cp "$work/Info.plist" "$work/OnlyOne Development.app/Contents/Info.plist"
  codesign --force --sign - "$work/OnlyOne Development.app"
  codesign --verify --strict "$work/OnlyOne Development.app"
  rm -rf "$app"
  mv "$work/OnlyOne Development.app" "$app"
  cp "$work/host.sha256" "$runtime/host.sha256"
fi
cat > "$runtime/macos/nsh-macos-host" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/OnlyOne Development.app/Contents/MacOS/nsh-macos-host" "$@"
SH
chmod +x "$runtime/macos/nsh-macos-host"
echo "Development runtime ready: $runtime"
