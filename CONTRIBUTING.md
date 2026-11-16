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
reuse a smaller build for an OTA release. Tag versions must increase. OTA and native shells share this workflow counter.

The workflow keeps `NSH_REF` pinned and caches the CLI and runtime; a cold source build can take tens of minutes.
The tag release also deploys the web client to the Worker that serves it, after the GitHub release is published:
`deploy-web` checks `onlyone-web.tar.gz` against the release's `sha256sums`, unpacks it into `app/dist/web/onlyone`
and runs `bun cloud/deploy.ts --release --version <version>`. That deploys the tag's Worker code and that client as one
new version — secrets, custom domain and data stay as they are, so only the first deployment sets them — and fails
unless `https://<domain>/` serves the deployed build and an unauthenticated `/api/status` still answers 401, which it
does only while the Worker's secrets and data survived. It needs the repository secrets `CLOUDFLARE_API_TOKEN`
(a token with Account `Workers Scripts: Edit` and Zone `Workers Routes: Edit`), `CLOUDFLARE_ACCOUNT_ID`,
`ONLYONE_WORKER_NAME` and `ONLYONE_DOMAIN`; the
preflight check stops a tag before packaging when one is missing. Set all four with
`bash scripts/set-release-secrets.sh [.env]` from the checkout that deployed the cloud: it takes the three
non-secret values from that ignored `.env`, prompts for the token without echo, checks it with Cloudflare and then
reads the names back with `gh secret list`. Pushes without a tag deploy nothing.
Before a tag release builds, it verifies the public latest `onlyonecli` declares `onlyoneAppProtocol: 1` and all
four desktop platform dependencies exist at their exact versions. This prevents a new App being distributed before
a compatible CLI. Manual CI builds skip that publication gate so unpublished code can still be verified.
It also checks these repository secrets before building on manual and tag runs:

- `NSH_UPDATE_KEY`: the secret corresponding to `updater.publicKey`; signs `latest.json` into `latest.json.sig`.
- `NSH_RELEASE_KEY`, `NSH_RELEASE_CERT`: sign the OTA package with OnlyOne's certified release key.
- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`: the persistent Android signing key.
  Keep this key; an older debug-signed APK cannot be updated in place by a differently signed APK.

The `onlyone-release` artifact contains the assembled installation archives, versioned desktop update archives,
the signed `onlyone-<version>.nshpkg`, `latest.json`, `latest.json.sig` and `sha256sums`.
`nsh verify` checks the OTA signature against the app's trusted root before generating the manifest.
`bun scripts/check-app-release.ts <assets-directory>` independently checks the manifest's Ed25519 signature,
app identity, version, OTA build, platform coverage, package/archive sizes and SHA-256 hashes.
The app checks after 5 seconds and hourly while running; a package is preferred over a whole-app update.
These requests go to GitHub (at most 288 manifest/signature requests per day for three continuously running clients
when both package and full-app checks fetch separately), with zero Worker requests, rows read or rows written.
There is no background service waking a closed app to check. The iOS archive is unsigned and must
pass the SDK 27 check. Mac apps are ad hoc signed; public Gatekeeper distribution additionally needs Developer ID
signing and notarization before final archives and their update manifest are generated.

Each release publishes native shells and a signed OTA entry with the same version and build. An older compatible
app can take the package; a shell from that release already contains that code. Desktop clients offer a restart
after download; iOS and Android silently use the package on their next cold start.
App releases and onlyonecli's npm releases are independent. Packaging verifies that neither Mac architecture
contains a bundled `onlyone-executor`. Apps built before the update watcher was enabled need one full reinstall;
they cannot discover this fix through OTA. Older phone shells without package support also need a full reinstall.

OnlyOne has its own OTA trust root and a release certificate scoped to `dev.onlyone.app`. The private signing material
is outside the checkout in `~/.onlyone/release-keys` (directory 0700, files 0600). Move `root.secret` to encrypted offline
storage and retain backups of all signing material; the root secret is never uploaded to CI.
CI uses only `NSH_RELEASE_KEY`, `NSH_RELEASE_CERT` and `NSH_UPDATE_KEY`. Renew the release certificate before expiry (365 days).
Never copy Noop's keys, certificates, app id or update source.

Release CI builds the package with the **same pinned NSH** as installed apps. For local verification, use an isolated
directory and a build higher than the installed baseline:

```bash
nsh publish app --key <release.secret> --cert <release.cert> --app-version <version> --build <build> -o <package.nshpkg>
nsh verify <package.nshpkg> --root <root.pub>
```

Verify desktop/mobile update checks, including calling onlyonecli from an OTA run. OTA cannot change onlyonecli, the NSH runtime, platform permissions,
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
