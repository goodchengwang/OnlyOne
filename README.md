# OnlyOne

Your own AI team.

OnlyOne runs a small team of Claude Code and Codex agents on your own computers. They do your daily work, decide what they can based on how you've decided before, and only ask you when something really needs you — with a short list of options you answer in one tap.

- **Works for you, not with you** — give it a goal in one sentence; it breaks the work down, runs it in parallel and comes back with results.
- **Learns how you decide** — starts cautious, asks more early on, and takes over more as it proves it decides like you.
- **Quiet** — no noise, no raw errors. You hear about results and decisions, nothing else.
- **Yours** — runs on your machines and your own free Cloudflare account. No shared service, no one else's server.

Manage the team in chat: “Add a member called Tuan who researches content ideas, and have them report three
ideas every weekday at 9.” OnlyOne saves the member and recurring task directly. New members get a
Codex-generated avatar by default, using the Codex installation and login on the coordinator computer.
Describe an avatar to guide generation, or attach a picture and ask to use it. You can also rename members,
change responsibilities, reschedule routines or turn them off in chat. Times use the coordinator's local
timezone. Avatar files are kept with the member and synced between computers; they do not expire with chat attachments.

## Projects

Use **Projects → Add project** in the sidebar to name a project and choose its source folder.
Choose the folder with the Mac system dialog; its path and computer are recorded automatically. Phones and browsers can open existing projects; add new folders in the Mac app.
Only this explicit creation flow registers projects. Session learning, discovered folders, channels and agents never add projects.

Each project has its own conversation, draft and `projects/<id>/memory.md`. Saying “remember this” inside the project
writes there; explicitly asking for a rule for every project writes global memory instead. The project header opens its memory.
Tasks, retries and follow-ups retain the project and run on its selected computer. If that computer is offline they wait;
if its folder is missing they report the error instead of running elsewhere. `memory/projects.md` is a generated index,
not an editable project registry. Existing conversations and memories are not imported into projects.

### Worktrees per requirement

A requirement that has a project repository is judged before it starts. A small, self-contained change stays on the
current branch; a feature, a multi-file change, or a requirement that would run alongside another task on the same
repository gets its own branch (`agent/<task id>-<slug>`) and checkout under `~/.onlyone/work/`. Several requirements
on one repository then progress in parallel without blocking each other. The task page shows the branch, the worktree
path, the reason it was chosen, the commit and the diff.

When the agent finishes, the executor commits whatever the run left uncommitted on that branch and pushes it to
`origin`, so the work never sits on one machine; a commit the run made on the plain branch is pushed the same way. It
then asks the owner whether to keep iterating in the worktree or open a PR to the base branch. The owner always makes
that choice (the judge does not answer it), and the agent never merges. The task page also shows where the commit was
pushed, or why a push was refused. Saying “use a worktree” in the request, or `onlyone add --worktree`, forces one;
`[worktree] enabled = false` in `config.toml` turns the behaviour off, `push = false` keeps auto-commits local.

## Install the CLI with npm

Requires Node.js 22+ and npm. The public package is `onlyonecli`; the installed command is `onlyone`.
On Linux (glibc x64/arm64) and macOS (x64/arm64):

```bash
npm install -g onlyonecli
onlyone
```

Enter your already-deployed Worker's HTTPS origin, owner email and email code. OnlyOne registers this
computer, mirrors the team's configuration and starts a background executor. No Bun, NSH or source checkout
is needed. Claude Code / Codex must still be installed and signed in separately; setup shows which are present.
Run `onlyone` again to ensure the service is running. `onlyone --help` and `onlyone --version` do not start it.

Linux uses a systemd user service. Without user systemd, run `onlyone daemon` in the foreground or set up
user systemd before retrying `onlyone install`. If enabling linger needs permission, setup prints the command
needed to keep the service running after logout. macOS uses launchd; Windows uses the current user's logon
scheduled task, which requires that user to be logged in. These services do not keep a suspended computer online.
Windows x64 uses the npm platform package `onlyone-windows-x64` (with `os: ["win32"]`); it must be published before Windows installation is available. Alpine/musl and Windows ARM64 are not included in the initial packages.

Settings → Background service provides **Check CLI updates** and **Download and update CLI** for this computer.
`onlyone update`, or **Update all machines** in the app, downloads the latest stable npm release into
`~/.onlyone/cli/releases/`. It checks the version and startup before waiting for current tasks to finish,
switching versions and restarting. The global npm installation is never modified by remote updates.
A candidate that fails startup rolls back to the previous version and reports the failure. No npm update
checks run on an idle timer. Existing source installations retain their Git-based update behavior.

Credentials remain in private `~/.onlyone/onlyone.toml`; override the home with `ONLYONE_HOME` before running
setup. A different Worker requires a separate home. A failed first sync retains the binding so setup can be
retried. If service installation fails, the device remains bound; fix the reported service error and run
`onlyone install`. On Linux, SSH sessions missing the user-bus environment reuse `/run/user/<uid>/bus`
when it exists. If the user service manager is unavailable, run `sudo loginctl enable-linger <user>`,
reconnect over SSH and retry. Systems without user systemd can run `onlyone daemon` in the foreground;
it must remain supervised to keep running after logout. Logs: `journalctl --user -u onlyone -f` on Linux, `~/.onlyone/cli/daemon.log` on macOS/Windows.

To build publishable packages locally: `bun run package:npm 0.1.3` (or invoke
`bun scripts/package-npm.ts 0.1.3 dist/npm linux-x64` for one platform). Only whitelisted generated files
are packed. The npm workflow tests actual tarball installs on all five platforms, publishes platform packages
first and the main package last for a `vX.Y.Z` tag: `v0.1.3` publishes npm version `0.1.3`.
Each of the six packages must trust GitHub Actions repository `goodchengwang/OnlyOne`, workflow `npm.yml`,
with **Allow npm publish** enabled and no environment name. Publishing uses OIDC, without `NPM_TOKEN`.
Pushes without a tag, pull requests and manual runs on branches only build and test.
Platform packages are named `onlyone-linux-x64`, `onlyone-linux-arm64`, `onlyone-darwin-x64`, `onlyone-darwin-arm64` and `onlyone-windows-x64`; the main package remains `onlyonecli`. The publish job checks that all six packages exist before publishing any of them. Complete the first publication and trusted publisher setup for `onlyone-windows-x64` before tagging a release.
Published npm versions cannot be overwritten, including after unpublishing; the main package and the old platform packages already occupy `0.1.0`, `0.1.1` and `0.1.2`.
The native App workflow and its pinned NSH version are separate.

## Install from local source

Install Bun, Git and the project's pinned NSH version. Deploy cloud from this checkout first:

```bash
bun install --frozen-lockfile
bunx wrangler login
# Put these in an ignored .env file (chmod 600 .env), or export them:
# ONLYONE_WORKER_NAME=onlyone
# CLOUDFLARE_ACCOUNT_ID=<your-account-id>
# ONLYONE_OWNER_EMAIL=<your-email>
# ONLYONE_MAIL_FROM=login@<your-verified-resend-domain>
# ONLYONE_RESEND_API_KEY=<your-resend-key>
# ONLYONE_DOMAIN=<your-cloudflare-domain>
bun run deploy:cloud
```

This builds the web client and deploys the Worker, custom domain, secrets and initial templates together.
Open the printed HTTPS address from any device and sign in with the 8-character email code. Cloud provides the interface and login independently of execution computers.
Verify the sender domain in Resend before deployment. Only the configured owner email can sign in.

On macOS, Windows and Linux, install Node.js 22+ and `onlyonecli`, then open the native desktop App and sign in.
The App asks that CLI to register the computer and start its background service. App and terminal share
`~/.onlyone` (or `ONLYONE_HOME`), one runtime version and one service. Reopening reuses it; closing the App leaves
tasks running. Signing out stops new work and waits for current tasks to finish. No executor is bundled in any
formal desktop App. Claude Code / Codex still need to be installed and signed in separately.
Web and mobile clients manage the team without starting a local executor.

For a headless computer, install and start the same CLI directly:

```bash
npm install -g onlyonecli
onlyone
```

For source development, run `bun src/cli.ts init https://<your-cloudflare-domain>` and
`bun src/cli.ts install` from this checkout instead.

The first computer to join becomes the fixed coordinator. Later computers join the same fleet. When the
coordinator is offline, cloud remains accessible and requests wait in its inbox until it reconnects.

`onlyone cloud deploy` uses the same explicit deployment flow. Updating an execution computer does not deploy cloud.
Keep a secure backup of `.cloud-deploy/<worker-name>/state.json`: it preserves the installation's instance,
machine credential and push keys across deployments. This ignored file and its directory are private (0600/0700).
Repeated deployments keep the same OnlyOne instance and do not overwrite its files.

OnlyOne stays within the Cloudflare Free plan target. Enrollment adds at most 6 requests and a conservative 100
written rows per computer (18 requests / 300 rows for three computers), plus one-time template initialization.
There are no enrollment timers or background emails. Owner status and host inbox nudges use hibernating WebSockets.
Check `onlyone status` or authenticated `/api/usage` after deployment and again after several hours of real use.

## Client apps

The npm package installs the CLI executor. Build native client apps separately from this checkout with NSH:

```bash
nsh package app --target macos
# Other targets: linux, windows, android, ios
```

Install the generated app for your platform. iOS requires your own signing configuration and the SDK check
documented in AGENTS.md. New native clients trust signed update manifests from this repository's GitHub Releases.
Desktop updates replace the native client; `onlyonecli` updates its executor independently through npm.
Android links to the release APK, and iOS still requires signing and installation.
See [release packaging](CONTRIBUTING.md#packaging-the-client-apps) for signing and OTA limits.
To fetch a published web client, explicitly set `ONLYONE_CLIENT_BASE_URL` to your release-assets URL;
archives are checked against that source's `sha256sums`.

All three release desktop clients use the npm-installed `onlyone` command (`onlyonecli`, Node.js 22+).
They require onlyonecli 0.1.5+ and contain no executor. They share the terminal CLI's home, service, updates and rollback. Install onlyonecli before
opening the desktop App; missing or outdated CLIs produce an actionable message. See [desktop CLI control](docs/desktop-cli.md).
No old desktop package migration is provided.

## Use

Open your OnlyOne address on any device and sign in with a code sent to your email. On your phone, add it to the home screen and turn on notifications.

Then just talk to it. When it needs you, you'll get a notification with the choices; answer right there.

The CLI is `onlyone`; local state lives in `~/.onlyone` (override with `ONLYONE_HOME`), with bootstrap configuration in `onlyone.toml`.
The native app ID is `dev.onlyone.app`.

## Development

Run `bun run dev` for Mac development with system notifications. It wraps the currently installed NSH development
host in a signed `OnlyOne Development.app` under the ignored `.nsh/dev-runtime/`, with a separate notification
identity (`dev.onlyone.app.development`). It does not change the installed NSH or the packaged app.
To keep using `nsh run app` directly, prepare and select the runtime once in each development terminal:

```bash
bash scripts/prepare-dev-runtime.sh && export NSH_RUNTIME="$PWD/.nsh/dev-runtime"
nsh run app
```

OnlyOne Development asks for notification permission when you enable notifications in settings. Run the preparation
again after updating NSH; `bun run dev` does this automatically. `unset NSH_RUNTIME` restores the default runtime;
use a terminal without this override for packaging or other targets.
The UI hot reloads, and the source executor automatically validates saves
and gracefully restarts when its bundled code changes. No manual daemon restart or repackaging is needed; running
tasks finish first, and invalid saves leave the current executor running. This source watcher is disabled in installed builds.

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, builds and optional release packaging.

## License

OnlyOne is based on [Noop](https://github.com/huacnlee/noop), originally created by Jason Lee (huacnlee), with modifications by GoodCheng.

MIT. Original copyright (c) 2026 Jason Lee; modifications copyright (c) 2026 GoodCheng. See [LICENSE](LICENSE).
