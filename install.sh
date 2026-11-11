#!/usr/bin/env bash
# OnlyOne installer (Linux / macOS), run from a local source checkout:
#   bash install.sh [<onlyone-url>] | --primary | --guest <onlyone-url> <code>
set -euo pipefail

HOME_DIR="${ONLYONE_HOME:-$HOME/.onlyone}"
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$APP/src/cli.ts" ] && [ -f "$APP/package.json" ] || { echo "OnlyOne source missing: run install.sh from a complete local checkout." >&2; exit 1; }
LOG="$HOME_DIR/install.log"
mkdir -p "$HOME_DIR" && : > "$LOG"

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= D= G= Y= R= N=; fi
step() { printf "  %s%-30s%s" "$D" "$1" "$N"; }
ok()   { printf "%s✓%s %s\n" "$G" "$N" "${1:-}"; }
warn() { printf "%s!%s %s\n" "$Y" "$N" "$1"; }
run()  { "$@" >>"$LOG" 2>&1; }  # details go to the log, not the screen

on_fail() {
  printf "%s✗%s\n\n  Something went wrong. Asking the AI medic to fix it (details: %s)\n\n" "$R" "$N" "$LOG"
  if command -v bun >/dev/null && [ -f "$APP/src/cli.ts" ]; then
    bun "$APP/src/cli.ts" fix "install.sh failed. Log: $LOG. Finish the installation by rerunning: $0 $*" || true
  elif command -v claude >/dev/null; then
    claude -p "OnlyOne install.sh failed on $(uname -a). Read $LOG, fix the cause, then rerun the installer." --permission-mode acceptEdits || true
  fi
}
trap on_fail ERR

printf "\n%sOnlyOne%s — your own AI team\n\n" "$B" "$N"

step "bun";  if ! command -v bun >/dev/null; then run bash -c "curl -fsSL https://bun.sh/install | bash"; export PATH="$HOME/.bun/bin:$PATH"; else run bun upgrade; fi; ok "$(bun --version)"
step "OnlyOne"
(cd "$APP" && run bun install --frozen-lockfile)
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/onlyone" "$HOME/.local/bin/onlyone"
ok "$APP"

if [ "${1:-}" = "--guest" ]; then
  # A guest gets its own revocable token and nothing else: no init, no owner login, no fleet data, no service.
  [ $# -eq 3 ] || { printf "%s✗%s usage: install.sh --guest <onlyone-url> <code>\n" "$R" "$N"; exit 1; }
  have=(); for c in claude codex; do command -v "$c" >/dev/null && have+=("$c"); done
  step "AI tools"; if [ ${#have[@]} -gt 0 ]; then ok "${have[*]}"; else warn "install claude (or codex) and log in; the guest runs tasks with this account's own login"; fi
  step "guest"; run "$APP/bin/onlyone" guest join "$2" "$3"; ok
  step "background service"; run "$APP/bin/onlyone" guest install; ok
  printf "\n  The guest now runs in the background and at every login (stop it with: onlyone guest uninstall).\n\n"
  exit 0
fi

missing=()
for c in claude codex gh; do command -v "$c" >/dev/null || missing+=("$c"); done
step "AI tools"; if [ ${#missing[@]} -eq 0 ]; then ok "claude, codex, gh"; else warn "missing: ${missing[*]} (install and log in for full capability)"; fi
echo

export ONLYONE_HOME="$HOME_DIR"
# interactive: email code (joining) or Cloudflare login (--primary); the questions read the terminal, not the piped script
if [ -r /dev/tty ]; then "$APP/bin/onlyone" init "$@" </dev/tty; else "$APP/bin/onlyone" init "$@"; fi
step "background service"; run "$APP/bin/onlyone" install; ok
echo
"$APP/bin/onlyone" status --brief || true
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) printf "\n  %sAdd ~/.local/bin to your PATH to use the onlyone command.%s\n" "$D" "$N";; esac
echo
