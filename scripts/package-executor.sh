#!/bin/bash
# Add the self-contained executor to a freshly packaged Mac app, then renew its signature.
set -euo pipefail
APP_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")/.."
case "$(uname -m)" in arm64) DEFAULT_TARGET=bun-darwin-arm64 ;; *) DEFAULT_TARGET=bun-darwin-x64 ;; esac
EXECUTOR_TARGET="${2:-$DEFAULT_TARGET}"
bun build src/cli.ts --compile --target="$EXECUTOR_TARGET" --outfile "$APP_PATH/Contents/MacOS/onlyone-executor"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
# NSH's newer runtimes also emit a desktop update archive beside the app.
shopt -s nullglob
for archive in "$(dirname "$APP_PATH")"/OnlyOne-*-macos-*.tar.gz; do
  tar -czf "$archive" -C "$(dirname "$APP_PATH")" "$(basename "$APP_PATH")"
done
