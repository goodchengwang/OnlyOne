// onlyone init / install / update — out-of-the-box setup and self-update.
import { $ } from "bun";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { CODE, DATA, HOME_DIR, P } from "./core";
import { createInterface } from "node:readline/promises";
import { desktopBinding } from "./desktop";
import { npmBuild } from "./release";

export async function setupQuestion(label: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup needs an interactive terminal. Run onlyone in a terminal, or use onlyone init <url> --token <machine-token>.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(label + " ")).trim(); }
  finally { input.close(); }
}

const STATE_DIRS = [
  "tasks/proposed", "tasks/rejected", "tasks/waiting", "tasks/inbox", "tasks/active", "tasks/blocked", "tasks/failed", "tasks/done",
  "decisions/open", "decisions/closed", "journal", "fleet/hosts", "reports/daily", "evolution", "reviews",
];

/** Copy template files that don't exist yet (never overwrite user-evolved agents/memory/policies). */
function seedTemplates() {
  const walk = (rel: string) => {
    for (const e of readdirSync(join(CODE, "templates", rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) { mkdirSync(P(r), { recursive: true }); walk(r); }
      else if (!existsSync(P(r))) cpSync(join(CODE, "templates", r), P(r));
    }
  };
  walk("");
  for (const d of STATE_DIRS) { mkdirSync(P(d), { recursive: true }); if (!readdirSync(P(d)).length) writeFileSync(P(d, ".gitkeep"), ""); }
}

/** Worker host: owner email login → POST /api/host/join → this machine's token. */
async function joinViaLogin(url: string, host: string, ask = setupQuestion): Promise<string | null> {
  const post = async (path: string, body: unknown, auth?: string) => {
    const r = await fetch(url + path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }).catch(() => null);
    return { ok: !!r?.ok, status: r?.status ?? 0, json: (await r?.json().catch(() => ({}))) as any };
  };
  const email = (await ask("owner email:")).trim();
  if (!email) return null;
  const s = await post("/api/auth/start", { email });
  if (!s.ok) { console.error(`login failed (${s.status}): ${s.json?.error ?? ""}`); return null; }
  const code = (await ask("code from the email:")).trim();
  const v = await post("/api/auth/verify", { email, code });
  if (!v.ok || typeof v.json?.session !== "string" || !v.json.session) { console.error(`verification failed (${v.status}): ${v.json?.error ?? ""}`); return null; }
  const j = await post("/api/host/join", { host }, v.json.session);
  await post("/api/auth/logout", {}, v.json.session); // the session was only needed to mint the machine token
  if (!j.ok || typeof j.json?.token !== "string" || !j.json.token) { console.error(`join failed (${j.status}): ${j.json?.error ?? ""}; or use: onlyone init ${url} --token <machine-token>`); return null; }
  return String(j.json.token);
}

/** Join a deployed cloud. Re-running init keeps the fixed coordinator and existing mirror. */
export async function init(opts: { worker?: string; token?: string; ask?: typeof setupQuestion } = {}) {
  const { pull, readOnlyOneToml, writeOnlyOneToml, setSyncData } = await import("./sync");
  const me = process.env.ONLYONE_HOST || hostname().split(".")[0];
  const saved = readOnlyOneToml();
  const url = desktopBinding((opts.worker || saved.cloud?.url || await (opts.ask ?? setupQuestion)("your deployed OnlyOne Worker URL:")).trim()).url;
  if (saved.server?.token && saved.cloud?.url !== url) throw new Error("This home belongs to a different installation. Use an empty ONLYONE_HOME.");
  if (opts.token && saved.server?.token && opts.token !== saved.server.token) throw new Error("This home already has a different machine credential. Use an empty ONLYONE_HOME.");
  let token = opts.token ?? (url === saved.cloud?.url ? saved.server?.token : undefined);
  if (token) {
    const response = await fetch(url + "/api/host/security", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!response) { console.error("Could not reach cloud; local data was kept"); process.exitCode = 1; return; }
    if (!response.ok || !(await response.json() as { primary?: string }).primary) {
      console.error(`Stored machine credential was rejected (${response.status}); local data was kept. Check this device in your Worker before signing in again.`); process.exitCode = 1; return;
    }
  }
  token ??= await joinViaLogin(url, me, opts.ask);
  if (!token) { process.exitCode = 1; return; }
  if (saved.server?.token && (token !== saved.server.token || url !== saved.cloud?.url)) {
    console.error("This home belongs to a different installation. Use an empty ONLYONE_HOME.");
    process.exitCode = 1; return;
  }
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HOME_DIR, 0o700);
  mkdirSync(DATA, { recursive: true });
  writeOnlyOneToml({ cloud: { url }, server: { token } });
  setSyncData(DATA, HOME_DIR);
  if (!(await pull())) { console.error(`Could not sync from ${url}`); process.exitCode = 1; return; }
  if (!existsSync(P("config.toml"))) { console.error("Cloud has no initial config; rerun bun run deploy:cloud"); process.exitCode = 1; return; }
  for (const d of STATE_DIRS) mkdirSync(P(d), { recursive: true });
  writeLocalConfig(me);
  console.log(`✔ joined ${url}; data mirrored to ${DATA}\n  next: onlyone install (runs the daemon as a service)`);
  return true;
}

function writeLocalConfig(me: string) {
  if (!existsSync(P("config.local.toml")))
    writeFileSync(P("config.local.toml"), `# per-machine overrides & secrets (never synced)\n[host]\n# name = "${me}"\n# caps = []\n# max_parallel = 3\n\n[notify]\n# slack_bot_token = ""\n# discord_bot_token = ""\n`);
}

// ------------------------------------------------------------------ self-update
const REJECTED = () => join(HOME_DIR, "update-rejected"); // machine-local: a release this host already refused

/** A release whose tests failed here is not tried again until origin moves on — otherwise every check
 *  re-installs the same bad code and wakes the medic again. An explicit `onlyone update` still retries. */
export function updateRejected(up: string, file = REJECTED()): boolean {
  try { return readFileSync(file, "utf8").trim() === up; } catch { return false; }
}

/** Fast-forward framework code if origin has new commits that pass tests. Returns true if updated. */
export async function selfUpdate(opts: { busy?: number; force?: boolean } = {}): Promise<boolean> {
  if (npmBuild) return opts.force ? (await import("./npm-runtime")).stageNpmUpdate() : false;
  // never swap code (and then restart) under running work: defer until this host is idle
  if ((opts.busy ?? 0) > 0 && !opts.force) return false;
  const g = (...a: string[]) => $`git ${a}`.cwd(CODE).quiet().nothrow();
  if (!existsSync(join(CODE, ".git"))) return false;
  if ((await g("status", "--porcelain", "--untracked-files=no")).stdout.toString().trim()) return false; // local edits → skip
  if ((await g("remote", "get-url", "origin")).exitCode !== 0) return false;
  if ((await g("fetch", "-q", "origin")).exitCode !== 0) return false;
  const head = (await g("rev-parse", "HEAD")).stdout.toString().trim();
  const upstream = await g("rev-parse", "--verify", "@{u}");
  if (upstream.exitCode !== 0) return false;
  const up = upstream.stdout.toString().trim();
  if (!up || head === up) return false;
  if (!opts.force && updateRejected(up)) return false; // already failed its tests here; wait for the next release
  // upstream history may have been rewritten (e.g. scrubbed); with no local edits, follow it — tests below still guard the switch
  if ((await g("merge-base", "--is-ancestor", "HEAD", "@{u}")).exitCode !== 0) {
    // diverged: follow upstream only when it already has every local commit's change (a rewrite); unpushed work stays
    if ((await g("cherry", "@{u}", "HEAD")).stdout.toString().split("\n").some((l) => l.startsWith("+"))) return false;
    await g("reset", "--hard", "-q", "@{u}");
  }
  else await g("merge", "--ff-only", "-q", "@{u}");
  const deps = await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
  const test = await $`bun test`.cwd(CODE).quiet().nothrow();
  if (deps.exitCode !== 0 || test.exitCode !== 0) {
    await g("reset", "--hard", "-q", head); // roll back a bad release
    await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
    try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(REJECTED(), up); } catch {}
    console.error(`self-update to ${up.slice(0, 7)} failed tests → rolled back to ${head.slice(0, 7)}`);
    const { medic } = await import("./medic");
    const { loadConfig } = await import("./core");
    void medic(`self-update ${head.slice(0, 7)} → ${up.slice(0, 7)} failed (deps exit ${deps.exitCode}, tests exit ${test.exitCode}); rolled back.\n${test.stdout.toString().slice(-3000)}${test.stderr.toString().slice(-3000)}`,
      loadConfig(), { auto: true, kind: "update" });
    return false;
  }
  seedTemplates(); // new template agents/policies appear; existing ones untouched
  console.log(`self-updated ${head.slice(0, 7)} → ${up.slice(0, 7)}`);
  return true;
}

// ------------------------------------------------------------------ service install
export const SERVICE = "onlyone";
const LABEL = "dev.onlyone.daemon";
export async function install() {
  if (npmBuild) return (await import("./npm-service")).installNpmService();
  const bun = Bun.which("bun") ?? join(homedir(), ".bun/bin/bun");
  const cli = join(CODE, "src", "cli.ts");
  const path = [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin"), join(homedir(), "go/bin"), join(homedir(), ".local/share/mise/shims"),
    join(homedir(), ".local/share/mise/command-wrappers/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  if (process.platform === "linux") {
    const unit = join(homedir(), `.config/systemd/user/${SERVICE}.service`);
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, `[Unit]
Description=OnlyOne fleet daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${bun} ${cli} daemon
Restart=always
RestartSec=10
# stopping lets running agents finish (the daemon drains), so a restart never throws work away.
# The stop timeout must outlast the longest agent run (clis.timeout_minutes, default 60), or systemd
# SIGKILLs the agents mid-run and the restarted daemon redoes them.
KillMode=mixed
TimeoutStopSec=90min
Environment=PATH=${path}
Environment=ONLYONE_DATA_DIR=${DATA}
Nice=5
# keep the box awake while the fleet runs
ExecStartPre=-/usr/bin/true

[Install]
WantedBy=default.target
`);
    await $`systemctl --user daemon-reload`.nothrow();
    await $`systemctl --user enable --now ${SERVICE}.service`.nothrow();
    await $`loginctl enable-linger ${process.env.USER ?? ""}`.nothrow(); // run without a login session / monitor
    console.log(`✔ systemd user service installed: ${unit}
  logs:   journalctl --user -u ${SERVICE} -f
  24/7:   linger enabled (runs with no one logged in). To prevent sleep on this always-on box:
          sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`);
  } else if (process.platform === "darwin") {
    const plist = join(homedir(), `Library/LaunchAgents/${LABEL}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${bun}</string><string>${cli}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>ONLYONE_DATA_DIR</key><string>${DATA}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(DATA, "logs", "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(DATA, "logs", "daemon.log")}</string>
</dict></plist>
`);
    mkdirSync(join(DATA, "logs"), { recursive: true });
    await $`launchctl bootout gui/${process.getuid!()} ${plist}`.quiet().nothrow();
    await $`launchctl bootstrap gui/${process.getuid!()} ${plist}`.nothrow();
    console.log(`✔ launchd agent installed: ${plist} (caffeinate -i keeps it awake while plugged in; when the lid closes the fleet simply continues without this Mac)`);
  } else if (process.platform === "win32") {
    const cmd = `"${bun}" "${cli}" daemon`;
    await $`schtasks /Create /F /SC ONLOGON /RL LIMITED /TN ${SERVICE} /TR ${cmd}`.nothrow();
    await $`schtasks /Run /TN ${SERVICE}`.nothrow();
    console.log(`✔ Scheduled Task '${SERVICE}' installed (runs at logon, restarts with the daemon's own loop). Disable sleep: powercfg /change standby-timeout-ac 0`);
  }
}
