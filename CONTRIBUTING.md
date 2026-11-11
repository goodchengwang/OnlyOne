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

```bash
bun install
bun test                 # unit + sync tests
bash test/e2e.sh         # offline end to end (fake CLI, HUB_SYNC_FAKE store)
bunx tsc --noEmit
```

Worker:

```bash
cd cloud && bunx wrangler dev --port 8799 --var HUB_TOKEN:test
bun cloud/test/run.ts http://127.0.0.1:8799      # file sync harness (see cloud/test)
```

App: `cd app && nsh test`. Build the application web client with `NSH=nsh bash app/build-web.sh` from the repository root.
`app/dist/web/onlyone` holds the build served by the primary and Worker; build it before running `wrangler dev`.
The `web/` and `app/web/` directories are application assets.

## Packaging the client apps

Use `nsh package app --target macos` (or `linux`, `windows`, `ios`, `android`).
The local installers build and install from this checkout. An explicit `ONLYONE_CLIENT_BASE_URL` selects verified release assets;
there is no default remote download or application update source.

The optional [release.yml](.github/workflows/release.yml) packages all platforms for the repository where it runs.
A `vX.Y.Z` tag publishes archives and checksums; the tag sets the app version and the run number sets the build number.
It does not sign OTA packages or configure clients to trust a release source.

The workflow builds nsh from the commit in `NSH_REF` and caches it; a commit not yet cached takes a while on each runner. Android signing uses the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS` and `ANDROID_KEYSTORE_PASSWORD`. Keep that key: Android refuses an update signed with another one. The iOS package is unsigned.

Do not run tests against a production Worker or a live `DATA` directory.
