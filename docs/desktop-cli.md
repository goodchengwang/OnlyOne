# Desktop clients and onlyonecli

Release apps on macOS, Windows and Linux invoke the npm-installed `onlyone app` command. They contain no executor
binary and never fall back to a bundled binary or source checkout. Install Node.js 22+ and `onlyonecli` first; a
missing or older CLI gets an installation/update message in the app. Windows resolves the npm cmd shim through
system PowerShell (without a profile); Unix uses the installed command through sh. Linux retains the user-bus
environment so App launches use the same systemd user service as the terminal. No global npm install runs silently.

`onlyone app` reads `{action: "start" | "stop" | "status" | "check-update" | "update", url, session?}` on stdin and returns a final JSON line
`{protocol: 1, running, stopping, mode, cli: {version, latest?, available?, pending?}}`. Sessions never enter command lines, service definitions or saved config.
The command is available only through onlyonecli's npm launcher. The npm manifest declares `onlyoneAppProtocol: 1`.
CLI publication must precede App distribution; the App tag workflow verifies that protocol declaration and the
actual availability of each desktop platform package before building;
the renamed Windows platform package requires first publication and trusted publisher setup as described in README.md.

The App and terminal share `ONLYONE_HOME` (default `~/.onlyone`), the npm runtime's current version and OS service.
The App control command also reuses the saved CLI profile's data/config paths, Node/npm and PATH, even when the
GUI does not inherit the terminal's environment. It does not rewrite that profile when merely reconnecting.
The service uses launchd on macOS, systemd user services on Linux, and the current user's logon task on Windows. Opening an App
reuses the CLI service; closing its window leaves the service running. Stopping writes the CLI's local stop marker;
the daemon receives a filesystem notification, stops taking work, drains tasks and flushes results. Only then is the
OS service disabled. The launcher respects that marker and does not respawn a stopped daemon or mistake an explicit
stop for a failed update. There are no added cloud timers, status requests or npm update polls.

There is no compatibility or data migration for old desktop packages. This is a fresh App architecture. Existing
onlyonecli bindings are reused; another Worker is rejected without altering its data. `bun dev` on macOS runs
this checkout with an executor owned by that development command, using a private local Unix socket for App
control. It shares the CLI home and drains an existing release service or obsolete development launchd job
before starting source execution. It never installs a development service. Closing or killing `bun dev`
immediately kills the executor and its agent processes, including after SIGKILL of the development owner;
unfinished tasks are recovered on the next start. Source saves still validate and drain before restarting.
A release App can stop the local development executor before starting onlyonecli. No release App can fall back to source.

Budget: status and reopening an initialized CLI make zero Worker requests and writes. First enrollment retains
the existing join/security/initial-pull sequence (3 requests per newly bound machine, 9 for three machines).
Explicit stop/start retain the existing lifecycle ceiling: 16 requests / 32 indexed row writes per cycle.
Two owner-triggered cycles per day on three machines stay at 96 requests / 192 indexed row writes.
Status and already-running starts each add 0 requests and 0 written rows; no new Worker paths are introduced. Nobody watching means zero additional requests or writes.
Development ownership checks run locally every 250 ms: for three machines they add 0 Worker requests and
0 row writes per day, including while idle. Killing development adds no shutdown upload.

Validate request/binding and stop behavior in Bun tests, then exercise npm tarball installs and the actual
OS service via `scripts/test-npm-service.mjs` on all five CLI platforms. Release packaging must assert that native
archives contain no `onlyone-executor`. Keep App updates and onlyonecli's npm update/rollback as separate lifecycles.

The settings view offers explicit CLI checks and downloads. Checks query npm latest once; they do not install or
contact the Worker. Update downloads into the existing private npm runtime, validates version and startup, drains
the running service, then activates and confirms the candidate. A failed candidate rolls back through the existing
launcher. A stopped service stays stopped; its selected update is confirmed on its next start. No update polling is
added. A registry version older than the selected CLI never causes a downgrade.
