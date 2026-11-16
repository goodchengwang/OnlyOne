# OnlyOne architecture

## Architecture

```
  app (NSH: web / macOS / Windows / Linux / mobile) ── HTTPS ──┐
                                                     ▼
            Owner's Cloudflare Worker + Durable Object (SQLite)
            files + history · chat feed · inbox · status · media
            email OTP login · Web Push
                ▲                                  ▲
                │ outbound HTTPS                   │
       primary (first joined Mac/Linux)            workers (macOS, Windows)
       routines, triage, judge, agents      claim tasks when online
```

- Machines never accept inbound connections; they call the Worker.
- Release desktop apps invoke the npm-installed `onlyone app` command over stdin/stdout on macOS, Windows and Linux.
  They contain no execution binary, use no source fallback, and share the terminal CLI's private home, version pointer
  and OS service. Existing CLI bindings are reused and a different Worker is rejected. This is a fresh App architecture,
  with no compatibility or migration for old desktop packages. See [desktop CLI control](desktop-cli.md).
  Only the machine credential is saved to a 0600 bootstrap file; the owner session never enters argv or service files.
  Status and reopening cost zero extra requests and rows. First enrollment after email login uses the existing join,
  credential validation and initial pull: five requests including email login, inside the existing six-request /
  100-written-row allowance per machine (18 / 300 for three). The daemon is owned by launchd, systemd or Task Scheduler
  and survives App exit. Explicit stop uses a local file notification so Windows also drains work before its process
  ends; the supervisor respects the stop marker, then the OS service is disabled. No new Worker timers are introduced.
  Mac development runs this checkout under `bun dev`, sharing CLI data without installing a source service.
  Its private Unix socket controls the child executor; ending development kills the executor and its process group.
  A local owner check also handles SIGKILL. Existing release/obsolete development services drain before source starts.
  In source development, filesystem events are debounced and validated locally; only a changed, valid bundle asks
  the existing daemon drain to restart. No files changed means zero extra requests or writes, even with the app closed.
  Development startup/reload messages stay in the terminal, and a source reload does not force lazy heartbeat/journal
  uploads. The last-push timestamp persists in sync.json so restarting cannot bypass lazy pacing. Task results still
  commit normally, and the next process retains unsent lazy changes in its mirror.
  Budget tests reserve eight requests / 16 indexed rows per reload: ten reloads/hour for eight hours on three Macs
  reserve 1,920 requests / 3,840 rows in the simulated day without increasing TARGET.
- Shared state is a set of files. Each machine keeps a local mirror (`DATA`) so agents read and write plain Markdown; `src/sync.ts` syncs it with the Worker (`cloud/src/files.ts`).
- Commits are compare-and-swap per path (`base_version`). A 409 means another host won; task claims rely on this, so exactly one host claims a task.
- Every file version is kept in `history` (90 days / 20k rows, latest per path always kept) and can be reverted — this is how self-evolution edits are audited and undone.
- The primary mirrors chat events to the Worker and receives inbox nudges over the hibernating `/api/host/stream` WebSocket (slow polling only while disconnected) for the owner's messages, settings and MCP writes (`src/cloud.ts`).
- Chat brain (`src/brain.ts`): every owner message that isn't a bare `D-0012 A` goes to a fast model (Claude Haiku via the local `claude` CLI, a pre-spawned warm process) that runs a short agent loop over OnlyOne's tools (`cloud/src/tools.ts`, shared with the MCP server): answer, look up, create/amend/cancel/reprioritise/reassign tasks, answer decisions, remember, edit or delete memories. The owner's model login stays on the primary; only the message and the reply cross the Worker. Latency per message: `~/.onlyone/brain.jsonl`.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | CLI entry and the daemon loop (`pull → routines → replies → judge → run tasks → push`) |
| `src/core.ts` | config, local paths (`HOME_DIR`), tasks, claims, journal, `locked()` |
| `src/sync.ts` | file sync with the Worker (CAS commit, pull, merge of append-only files) |
| `src/runner.ts` | prompt building and running Claude Code / Codex |
| `src/decisions.ts`, `src/autonomy.ts` | the judge, proposals, graduated autonomy |
| `src/gates.ts`, `src/github.ts` | hard gates, GitHub quota etiquette |
| `src/accounts.ts` | multiple AI accounts, quota cooldown, remote login links |
| `src/resources.ts` | resource governor and disk cleanup |
| `src/notify.ts`, `src/server.ts`, `src/cloud.ts` | events, local API, Worker bridge and deploy |
| `src/medic.ts` | AI self-repair for install/update/daemon failures |
| `src/sessions.ts` | learning the owner from local Claude/Codex history (redacted, never uploaded raw) |
| `src/setup.ts` | init, join, install as a service, self-update with rollback |
| `cloud/` | the Worker: `index.ts` (routes, auth, feed), `files.ts`, `resend.ts`, `push.ts`; `deploy.ts` independently builds and deploys it |
| `app/` | the NSH client; `app/build-web.sh` builds its web package locally; `src/webclient.ts` downloads only from an explicitly configured source |
| `templates/` | default config, agents, policies and memory seeded into a new install |

Machine-local files live in `HOME_DIR` (`$ONLYONE_HOME`, else `~/.onlyone`): `onlyone.toml` (Worker URL + machine token), `sync.json`, `data/` (the mirror), accounts, logs.

## Worker API

Auth: the machine token (hosts) or an owner session from email login (clients). `?token=` is accepted only for WebSocket and media URLs.

| Route | Who | Purpose |
|---|---|---|
| `POST /api/auth/start`, `/verify`, `/logout` | public / session | email one-time code login |
| `GET /api/feed`, `WS /api/stream`, `POST /api/messages` | session | chat timeline |
| `GET /api/status`, `GET/PUT /api/settings` | session | dashboard, UI-adjustable settings |
| `POST /api/media`, `GET /media/<id>` | both | screenshots and recordings |
| `/api/push/*` | session | Web Push subscribe / test / answer from a notification |
| `/api/files/changes`, `/commit` | machine | file sync |
| `/api/files/history`, `/revert` | session | audit and undo |
| `POST /api/events`, `PUT /api/host/state`, `GET /api/host/inbox` | machine | primary bridge |
| `POST /api/host/join` | session | a new machine gets its token |

## Agents and safety

- The lead agent owns every task and decides how much process it needs; other roles are spawned as parallel sub-agents.
- Hard gates (`src/gates.ts`) are enforced through Claude Code's `--disallowedTools`, not model judgment: merge, approve, release, publish, force-push, pushing to main, repo/secret admin, GitHub REST loops. Running one requires an owner decision, which unlocks the approvable gates (merge, approve, release, publish, push) for that task only; repo deletion, secrets, `rm -rf /` or `~` and `[gates] extra` stay blocked.
- Anything posted outside OnlyOne carries the agent's signature.
- Failures are retried; tooling problems go to the medic; the owner is told only about failures of work they asked for, in one plain sentence.
