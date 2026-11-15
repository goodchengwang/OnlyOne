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

For the Mac app, run `bun run dev` from the repository root to use the project-local signed development host
with system notifications. To use `nsh run app` directly, follow the runtime setup in [README.md](README.md#development).
UI changes hot reload. The Mac development host can run this checkout's source executor through Bun;
release desktops on all three platforms invoke the npm-installed onlyonecli. They share `ONLYONE_HOME`, data
and credentials. Switching between source development and onlyonecli drains the current service first.
Opening another release App reuses the CLI rather than selecting a different executor build.
Settings has a local background-service toggle. Closing a window leaves the CLI service running; sign-out waits
for tasks and stops it. Status and reopening add zero Worker requests or rows. Two explicit lifecycle cycles per
day on three machines retain the 96-request / 192-indexed-write allowance; there are no new cloud timers.
CLI logs are `~/.onlyone/cli/daemon.log` (or the systemd journal); source development logs are
`~/.onlyone/executor.log`. Private data and configuration are shared under `~/.onlyone`, not inside the App.

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
All release desktop apps (macOS, Windows and Linux) call the npm-installed `onlyone app` protocol and never bundle
or compile an executor. `onlyonecli` must be published with that command before the new desktop App is distributed.
The terminal and App share the CLI's private home, service, update staging and rollback. There is no old desktop
package compatibility or data migration. See [desktop CLI control](docs/desktop-cli.md) for the contract and budget.
Native apps trust the `goodchengwang/OnlyOne` release source in `app/nsh.json`; the app id remains `dev.onlyone.app`.

[release.yml](.github/workflows/release.yml) packages all platforms. Manual runs build and verify artifacts without
publishing; a `vX.Y.Z` tag publishes a draft only after all packages and the signed update manifest pass validation,
then makes it public. Existing releases are not overwritten. All final asset names are lowercase. The run number is
the shared build number (the installed Mac baseline was build 1 when this pipeline was enabled); never reset it or
reuse a smaller build for an OTA release. Tag versions must increase. Keep the same workflow counter for any future OTA path.

The workflow keeps `NSH_REF` pinned and caches the CLI and runtime; a cold source build can take tens of minutes.
It checks these repository secrets before building on manual and tag runs:

- `NSH_UPDATE_KEY`: the secret corresponding to `updater.publicKey`; signs `latest.json` into `latest.json.sig`.
- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`: the persistent Android signing key.
  Keep this key; an older debug-signed APK cannot be updated in place by a differently signed APK.

The `onlyone-release` artifact contains the assembled installation archives, versioned desktop update archives,
`latest.json`, `latest.json.sig` and `sha256sums`. `bun scripts/check-app-release.ts <assets-directory>` independently
checks the manifest's Ed25519 signature, app identity, version, platform coverage, archive sizes and SHA-256 hashes.
The update source is GitHub, so these checks add no Worker requests or timers. The iOS archive is unsigned and must
pass the SDK 27 check. Mac apps are ad hoc signed; public Gatekeeper distribution additionally needs Developer ID
signing and notarization before final archives and their update manifest are generated.

This workflow publishes native shells, without an OTA entry. App shell releases and onlyonecli's npm releases
are independent. Packaging verifies that neither Mac architecture contains a bundled `onlyone-executor`.

OnlyOne has its own OTA trust root and a release certificate scoped to `dev.onlyone.app`. The private signing material
is outside the checkout in `~/.onlyone/release-keys` (directory 0700, files 0600). Move `root.secret` to encrypted offline
storage and retain backups of all signing material; it is never uploaded to CI. `NSH_RELEASE_KEY` and `NSH_RELEASE_CERT`
are reserved for a future, explicitly enabled UI-only OTA release. Renew its certificate before expiry (365 days).
Never copy Noop's keys, certificates, app id or update source.

To prepare a UI-only package later, use the **same pinned NSH** as installed apps, increment version and build, and run:

```bash
nsh publish app --key <release.secret> --cert <release.cert> --app-version <version> --build <build> -o <package.nshpkg>
nsh verify <package.nshpkg> --root <root.pub>
```

Do not add that package to a release manifest until real desktop/mobile update checks pass, including calling
onlyonecli from an OTA run. OTA cannot change onlyonecli, the NSH runtime, platform permissions,
update source or trusted keys; those require a full app. It also does not deploy the Worker or update npm executors.

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
