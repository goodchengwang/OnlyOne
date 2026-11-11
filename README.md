# OnlyOne

Your own AI team.

OnlyOne runs a small team of Claude Code and Codex agents on your own computers. They do your daily work, decide what they can based on how you've decided before, and only ask you when something really needs you — with a short list of options you answer in one tap.

- **Works for you, not with you** — give it a goal in one sentence; it breaks the work down, runs it in parallel and comes back with results.
- **Learns how you decide** — starts cautious, asks more early on, and takes over more as it proves it decides like you.
- **Quiet** — no noise, no raw errors. You hear about results and decisions, nothing else.
- **Yours** — runs on your machines and your own free Cloudflare account. No shared service, no one else's server.

## Install from local source

Install Bun and Git, keep this source directory on the machine, and run:

```bash
bun install --frozen-lockfile
# Build the web client before creating the primary's Worker (requires NSH).
NSH=nsh bash app/build-web.sh
bash install.sh --primary
# On additional macOS or Linux machines:
bash install.sh
```

The primary setup asks you to log in to your own Cloudflare account. Workers stays within the Free plan budget.
On Windows, run `.\install.ps1` from the local source directory.
The installer uses this checkout and never clones or updates a remote repository.

## Client apps

Build and install the desktop client from this source directory (requires NSH):

```bash
bash install-client.sh
```

On Windows, run `.\install-client.ps1`. For mobile, use `nsh package app --target android` or
`nsh package app --target ios`; iOS requires your own signing configuration and the SDK check documented in AGENTS.md.

To install a published desktop client or fetch a web client, explicitly set `ONLYONE_CLIENT_BASE_URL` to your release-assets URL.
Downloaded archives are checked against that source's `sha256sums`. No public download or App update source is configured by default.
Local clients are updated by rebuilding and installing again.

## Use

Open your OnlyOne address on any device and sign in with a code sent to your email. On your phone, add it to the home screen and turn on notifications.

Then just talk to it. When it needs you, you'll get a notification with the choices; answer right there.

The CLI is `onlyone`; local state lives in `~/.onlyone` (override with `ONLYONE_HOME`), with bootstrap configuration in `onlyone.toml`.
The native app ID is `dev.onlyone.app`. This app uses a fresh identity and does not import previous installations.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests, builds and optional release packaging.

## License

MIT. Original copyright notices are retained in [LICENSE](LICENSE).
