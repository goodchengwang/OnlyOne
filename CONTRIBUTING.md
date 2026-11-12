# Contributing to OnlyOne

Technical reference for people and AI agents working on this codebase.

## Third-party pull requests

OnlyOne accepts third-party pull requests only for:

- Bug fixes.
- Security fixes.
- Performance optimizations.

OnlyOne was not intended to accept third-party pull requests that shape the product. Changes to product design, scheduling behavior, workflows, or product details are not accepted. New features and other changes outside the three categories above will be declined.

Keep fixes focused on the existing behavior. A bug fix, security fix, or performance optimization must not bundle unrelated product or workflow changes.

## Principles

- Single owner. OnlyOne serves one person (the CEO); there is no multi-tenant or shared service. Each user deploys their own Cloudflare Worker.
- No personal data or secrets in this repository. Templates are generic.
- Everything is Bun + TypeScript. The client is written with NSH.
- The owner only sees results and decisions. Never surface raw errors, internal routine failures or test data.

## Docs

- [docs/architecture.md](docs/architecture.md) — how OnlyOne works: sync, Worker API, code layout, agents and safety.

## Development

For the Mac app, run `nsh run app` from the repository root. UI changes hot reload. Sign in with the server address
and email code: the app binds this Mac to that cloud and starts the executor through launchd, using this checkout
and the installed Bun. No manual `init` or background-service installation is required. Other platforms remain
management clients. Opening either the development or packaged Mac app selects its executor automatically: the
old executor stops accepting work, finishes its running tasks, then the matching service is loaded. Opening the same
version again reuses it. Settings → Version has a local background-service start/stop button; stopping also waits
for running tasks without signing out. Closing the app leaves the executor running; signing out drains its work and disables it.
Service status and unchanged-version opens make zero Worker requests. The budget reserves two user-triggered
switches or stop/start cycles per machine/day: 96 requests and 192 indexed row writes across three Macs
(16 requests / 32 indexed rows per idle lifecycle change); task-result writes retain their existing budget.
There is no new unattended polling or cloud timer.
Executor logs are `~/.onlyone/app/<origin-hash>/executor.log`; its private configuration and data are beside that log.
The source executor also watches its code: valid saves in `src/` and shared `cloud/src/` dependencies trigger a
graceful restart automatically, without the daemon's minute-long tick delay. Saves are debounced; unchanged builds
and invalid source keep the current process running. Busy tasks finish before the new code takes over. Packaged
executors never watch the source. Worker-only edits still need a local `wrangler dev` session or an explicit deploy.
Use a separate development Worker for task execution against test data.

```bash
bun install
bun test                 # unit + sync tests
bash test/e2e.sh         # offline end to end (fake CLI, ONLYONE_SYNC_FAKE store)
bunx tsc --noEmit
```

Worker:

```bash
cd cloud && bunx wrangler dev --port 8799 --var ONLYONE_TOKEN:test --var ONLYONE_INSTANCE:dev
bun cloud/test/run.ts http://127.0.0.1:8799      # file sync harness (see cloud/test)
```

App: `cd app && nsh test`. Build the application web client with `NSH=nsh bash app/build-web.sh` from the repository root.
`app/dist/web/onlyone` holds the build served by the primary and Worker; build it before running `wrangler dev`.
The `web/` and `app/web/` directories are application assets.

## Packaging the client apps

Use `nsh package app --target macos` (or `linux`, `windows`, `ios`, `android`).
For macOS, follow it with `bash scripts/package-executor.sh <output>/OnlyOne.app` to include the self-contained
Bun executor and sign the resulting app again. The local installer and release workflow already do this.
The optional second argument selects Bun's compilation target; the default matches the build Mac.
The local installers build and install from this checkout. An explicit `ONLYONE_CLIENT_BASE_URL` selects verified release assets;
there is no default remote download or application update source.

The optional [release.yml](.github/workflows/release.yml) packages all platforms for the repository where it runs.
A `vX.Y.Z` tag publishes archives and checksums; the tag sets the app version and the run number sets the build number.
It does not sign OTA packages or configure clients to trust a release source.

The workflow builds nsh from the commit in `NSH_REF` and caches it; a commit not yet cached takes a while on each runner. Android signing uses the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS` and `ANDROID_KEYSTORE_PASSWORD`. Keep that key: Android refuses an update signed with another one. The iOS package is unsigned.

Do not run tests against a production Worker or a live `DATA` directory.

Standalone cloud verification (test mail never leaves the local runtime):

```bash
bun test test/cloud-standalone.test.ts test/budget.test.ts
nsh test app/App.test.tsx --filter login
NSH=nsh bash app/build-web.sh
# Use a fresh temporary directory on each run; this harness includes test-only SQL controls.
bunx wrangler dev --config cloud/test/standalone.toml --port 8798 --persist-to /tmp/onlyone-test-<unique>
# In another terminal:
bun cloud/test/standalone.ts http://127.0.0.1:8798
```

Only `cloud/wrangler.toml` is a production configuration. Never deploy the test entrypoint.
The standalone harness exercises the real SQLite Durable Object and Resend request construction, with a local
provider stub for deterministic delivery failures. Production acceptance additionally needs a real Resend email.
