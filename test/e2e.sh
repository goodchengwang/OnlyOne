#!/usr/bin/env bash
# End-to-end: sandbox data mirror synced to an offline fake of the Worker files API
# (ONLYONE_SYNC_FAKE = the real cloud/src/files.ts over a local SQLite file), fake agent CLIs, run ticks.
set -euo pipefail
trap 'echo "FAIL: e2e.sh line $LINENO: $BASH_COMMAND" >&2' ERR
SRC=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export ONLYONE_HOME="$W" ONLYONE_DATA_DIR="$W/data" ONLYONE_HOST=pc ONLYONE_SYNC_FAKE="$W/worker.sqlite"
cd "$SRC"; onlyone() { bun "$SRC/src/cli.ts" "$@"; }
onlyone init https://onlyone.test --token pc-token >/dev/null  # offline: ONLYONE_SYNC_FAKE, the first machine seeds the fake cloud
cd "$W/data"
cat > "$W/fake-agent" <<'F'
#!/usr/bin/env bash
p=$(cat)
# a requirement in its own worktree edits a file there (but not on the rerun that follows the owner's decision)
if grep -q "^## Worktree" <<<"$p" && ! grep -q "Decision D-" <<<"$p"; then echo "worktree change" >> change.txt; fi
if grep -q "You are the owner.s JUDGE" <<<"$p"; then echo '```json
{"verdict":"hold","reason":"new taste call"}
```'; exit; fi
if grep -q "You place tasks for an AI agent fleet" <<<"$p"; then
  echo '```json'; grep -oE '^- T-[0-9]+' <<<"$p" | sed 's/^- //' | awk 'BEGIN{printf "{"} {printf "%s\"%s\": {\"requires\": \"\", \"cli\": \"claude\", \"difficulty\": \"normal\"}", (NR>1?",":""), $0} END{print "}"}'; echo '```'; exit
fi
if grep -q "Decision D-" <<<"$p"; then echo '```json
{"status":"done","summary":"followed owner decision"}
```'
elif grep -q "^# Task T-[0-9]*: WTREE" <<<"$p"; then echo '```json
{"status":"done","summary":"changed a file"}
```'
elif grep -q "^# Task T-[0-9]*: SPLIT" <<<"$p" && ! grep -q "Results from delegated subtasks" <<<"$p"; then echo '```json
{"status":"delegated","summary":"split in two","followups":[{"title":"part one","agent":"reviewer"},{"title":"part two","agent":"rust-maintainer"}]}
```'
elif grep -q "^# Task T-[0-9]*: part" <<<"$p"; then echo '```json
{"status":"done","summary":"part finished"}
```'
elif grep -q "^# Task T-[0-9]*: ASKME" <<<"$p"; then echo '```json
{"status":"needs_decision","summary":"prepared","question":"Ship it?","options":["A: yes","B: no"],"recommendation":"A","lessons":["owner likes options"]}
```'
else echo '```json
{"status":"done","summary":"did it","followups":[{"title":"child task","agent":"reviewer"}]}
```'; fi
F
chmod +x "$W/fake-agent"
cat > config.local.toml <<F
[fleet]
primary = "pc"
[clis.claude]
command = ["$W/fake-agent"]
[judge]
cli = "claude"
[autonomy]
batch_minutes = 0
[clis]
routine_agents = []
[idle]
enabled = false
F
# judge uses 'claude' binary directly → shim PATH
mkdir -p "$W/bin"; ln -s "$W/fake-agent" "$W/bin/claude"; export PATH="$W/bin:$PATH"
sed -i.bak 's/^\[\[routine\]\]/[[routine_disabled]]/' config.toml && rm config.toml.bak
onlyone add "plain task" -a rust-maintainer >/dev/null
onlyone add "ASKME task" -a release-manager >/dev/null
onlyone add "windows only" -r os:windows >/dev/null
# how many tasks one tick runs depends on the host load (a busy macOS runner runs one), so tick until a condition holds
tick_until() { for _ in 1 2 3 4 5 6 7 8; do onlyone tick >/dev/null; eval "$1" && return; done; }
tick_until "test -f tasks/done/T-0001.md && grep -qs held: decisions/open/D-0001.md"
onlyone status
test -f tasks/done/T-0001.md || { echo "FAIL: T-0001 should be done"; exit 1; }
test -f tasks/blocked/T-0002.md && test -f decisions/open/D-0001.md
grep -q held: decisions/open/D-0001.md
ls tasks/*/T-0004.md >/dev/null  # follow-up created
grep -q parked tasks/inbox/T-0003.md
onlyone decide D-0001 "A"
tick_until "test -f tasks/done/T-0002.md"
test -f tasks/done/T-0002.md && test -f decisions/closed/D-0001.md
grep -q "owner likes options" agents/release-manager/memory.md
test "$(bun -e "import {Database} from 'bun:sqlite'; console.log(new Database('$W/worker.sqlite').query('SELECT COUNT(DISTINCT ts) AS n FROM history').get().n)")" -gt 5
# onboarding: self-generated work still waits for approval (a routine that is switched on does not);
# owner-derived follow-ups do not
ls tasks/done/T-0004.md >/dev/null   # follow-up of an owner task ran without approval
# Start from a clean proposals slate: a batch that was already sent is not rebuilt for autonomy.renotify_hours, so a
# proposal made while one is open stays out of it and answering that card leaves it pending. Approving the open batch
# first (the tasks here are only proposed) keeps the fresh task below in the card this block answers.
P0=$(ls decisions/open | grep '^P-' | head -1 | sed 's/.md//' || true)
[ -n "$P0" ] && onlyone decide "$P0" all
RT=$(bun -e "import {newTask,setApprovalGate} from '$SRC/src/core.ts'; import {needsApproval} from '$SRC/src/autonomy.ts'; import {loadConfig} from '$SRC/src/core.ts'; setApprovalGate(s=>needsApproval(loadConfig(),s)); console.log(newTask('followup job','x',{source:'followup:T-0001'}))")
test -f tasks/proposed/$RT.md
onlyone tick >/dev/null
P=$(ls decisions/open | grep '^P-' | head -1 | sed 's/.md//'); test -n "$P"
onlyone decide "$P" all
test -f tasks/inbox/$RT.md
tick_until "test -f tasks/done/$RT.md"
test -f tasks/done/$RT.md
# owner request → delegate → children run without approval → parent consolidates
SPL=$(onlyone add "SPLIT big job" | tail -1)
tick_until "grep -qs 'Results from delegated subtasks' tasks/done/$SPL.md"
grep -q "Results from delegated subtasks" tasks/done/$SPL.md
! grep -l "parent: $SPL" tasks/proposed/*.md 2>/dev/null
# A requirement-level worktree: its own branch and checkout, the run committed there, then the owner asked whether
# to keep iterating or open a PR. Nothing touches the main checkout.
REPO="$W/repo"; mkdir -p "$REPO"
git init -q --bare -b main "$W/repo-origin.git"
git -C "$REPO" init -q -b main
git -C "$REPO" remote add origin "$W/repo-origin.git"
echo hello > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=e2e -c user.email=e2e@e2e commit -qm init
WT=$(onlyone add "WTREE change header" --repo "$REPO" --worktree | tail -1)
tick_until "test -f tasks/blocked/$WT.md && grep -lqs '^task: $WT\$' decisions/open/D-*.md"
test -f tasks/blocked/$WT.md
D=$(grep -l "^task: $WT$" decisions/open/*.md | head -1 | xargs basename | sed 's/\.md$//')
test -n "$D"
grep -q "^kind: worktree" decisions/open/$D.md
grep -q "^worktree_mode: worktree" tasks/blocked/$WT.md
WTDIR=$(sed -n 's/^worktree: //p' tasks/blocked/$WT.md | tail -1)
BR=$(sed -n 's/^branch: //p' tasks/blocked/$WT.md | tail -1)
test -d "$WTDIR" && test -n "$BR"
test -f "$WTDIR/change.txt"                                  # the agent worked in the worktree
test -z "$(git -C "$REPO" status --porcelain)"               # the main checkout is untouched
test "$(git -C "$REPO" rev-list --count "main..$BR")" -ge 1  # the run's work is committed on the branch
git -C "$WTDIR" log -1 --format=%B | grep -q "Agent: lead"
grep -q "^pushed: origin/$BR$" tasks/blocked/$WT.md                 # the auto-commit went to origin, not only local
test "$(git -C "$W/repo-origin.git" rev-parse "$BR")" = "$(git -C "$REPO" rev-parse "$BR")"
onlyone decide "$D" A
tick_until "test -f tasks/done/$WT.md"
test -f tasks/done/$WT.md
grep -q "^branch: $BR$" tasks/done/$WT.md
# a second host joins and mirrors the same data
ONLYONE_HOME="$W/w2" ONLYONE_DATA_DIR="$W/w2/data" ONLYONE_HOST=w2 bun "$SRC/src/cli.ts" init https://onlyone.test --token w2-token >/dev/null
cmp tasks/done/T-0001.md "$W/w2/data/tasks/done/T-0001.md"
test ! -e "$W/w2/data/config.local.toml.pc" && ! grep -q fake-agent "$W/w2/data/config.local.toml"
echo "E2E OK"; cat journal/*.md
