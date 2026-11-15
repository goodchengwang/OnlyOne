# Desktop clients and onlyonecli

Release apps on macOS, Windows and Linux invoke the npm-installed `onlyone app` command. They contain no executor
binary and never fall back to a bundled binary or source checkout. Install Node.js 22+ and `onlyonecli` first; a
missing or older CLI gets an installation/update message in the app. No global npm install runs silently.

`onlyone app` reads `{action: "start" | "stop" | "status", url, session?}` on stdin and returns a final JSON line
`{protocol: 1, running, stopping, mode}`. Sessions never enter command lines, service definitions or saved config.
The command is available only through onlyonecli's npm launcher. CLI publication must precede App distribution;
the public Windows platform package still requires the separate npm registry approval described in README.md.

The App and terminal share `ONLYONE_HOME` (default `~/.onlyone`), the npm runtime's current version and OS service:
launchd on macOS, systemd user services on Linux, and the current user's logon task on Windows. Opening an App
reuses the CLI service; closing its window leaves the service running. Stopping writes the CLI's local stop marker;
the daemon receives a filesystem notification, stops taking work, drains tasks and flushes results. Only then is the
OS service disabled. The launcher respects that marker and does not respawn a stopped daemon or mistake an explicit
stop for a failed update. There are no added cloud timers, status requests or npm update polls.

There is no compatibility or data migration for old desktop packages. This is a fresh App architecture. Existing
onlyonecli bindings are reused; another Worker is rejected without altering its data. Mac development opens can
still run this checkout through Bun. They share the CLI home, drain its service before switching to source, and
are drained before a release App switches back to onlyonecli. No release App can fall back to source.

Budget: status and reopening an initialized CLI make zero Worker requests and writes. First enrollment retains
the existing join/security/initial-pull sequence (3 requests per newly bound machine, 9 for three machines).
Explicit stop/start retain the existing lifecycle ceiling: 16 requests / 32 indexed row writes per cycle.
Two owner-triggered cycles per day on three machines stay at 96 requests / 192 indexed row writes.
Status and already-running starts each add 0 requests and 0 written rows; no new Worker paths are introduced. Nobody watching means zero additional requests or writes.

Validate request/binding and stop behavior in Bun tests, then exercise npm tarball installs and the actual
OS service via `scripts/test-npm-service.mjs` on all five CLI platforms. Release packaging must assert that native
archives contain no `onlyone-executor`. Keep App updates and onlyonecli's npm update/rollback as separate lifecycles.
