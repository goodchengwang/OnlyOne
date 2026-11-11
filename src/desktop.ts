// The Mac app's non-interactive bootstrap. Credentials arrive on stdin, never argv.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lockDaemon } from "./daemon-lock";

export function desktopBinding(value: string, root = join(homedir(), ".onlyone", "app")) {
  const url = new URL(value);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Enter an OnlyOne server origin, without a path or credentials");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("OnlyOne requires HTTPS except on localhost");
  const key = createHash("sha256").update(url.origin).digest("hex").slice(0, 24);
  return { url: url.origin, home: join(root, key), label: `dev.onlyone.app.executor.${key}` };
}

export const plistEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function executorPlist(label: string, command: string[], home: string, path: string, development = false) {
  const s = (v: string) => `<string>${plistEscape(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${s(label)}
<key>ProgramArguments</key><array>${command.map(s).join("")}</array>
<key>EnvironmentVariables</key><dict><key>ONLYONE_HOME</key>${s(home)}<key>ONLYONE_DATA_DIR</key>${s(join(home, "data"))}<key>ONLYONE_CONF</key>${s(join(home, "onlyone.toml"))}<key>PATH</key>${s(path)}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>PathState</key><dict><key>${plistEscape(join(home, "enabled"))}</key><true/></dict></dict>
<key>ExitTimeOut</key><integer>5400</integer>
<key>ThrottleInterval</key><integer>${development ? 1 : 10}</integer>
<key>StandardOutPath</key>${s(join(home, "executor.log"))}
<key>StandardErrorPath</key>${s(join(home, "executor.log"))}
</dict></plist>\n`;
}

const command = () => process.argv[1]?.startsWith("/$bunfs/")
  ? [process.execPath]
  : [process.execPath, resolve(import.meta.dir, "cli.ts")];

async function run(args: string[], env = process.env) {
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

/** Only a fresh binding calls join + init (3 requests); later app opens are entirely local. */
export async function enrollDesktop(binding: ReturnType<typeof desktopBinding>, session: string, cli = command()) {
  const { home, url } = binding;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const cfgPath = join(home, "onlyone.toml");
  const saved = existsSync(cfgPath) ? Bun.TOML.parse(readFileSync(cfgPath, "utf8")) as any : {};
  if (saved.cloud?.url && saved.cloud.url !== url) throw new Error("This executor belongs to another cloud");
  const env = { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: join(home, "data"), ONLYONE_CONF: cfgPath, ONLYONE_SYNC: "", ONLYONE_SYNC_FAKE: "", ONLYONE_NO_MEDIC: "1" };
  if (!saved.server?.token) {
    if (!session) throw new Error("Sign in before starting the executor");
    const response = await fetch(`${url}/api/host/join`, {
      method: "POST", headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
      body: JSON.stringify({ host: hostname().split(".")[0] }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as { token?: string };
    if (!response.ok || typeof body.token !== "string" || !body.token) throw new Error(`Machine registration failed (${response.status})`);
    // Persist only the machine credential, even if the first pull is interrupted.
    writeFileSync(cfgPath, `[cloud]\nurl = ${JSON.stringify(url)}\n[server]\ntoken = ${JSON.stringify(body.token)}\n`, { mode: 0o600 });
  }
  if (!existsSync(join(home, "data", "config.toml"))) {
    // init reads the stored credential; it is not passed as an argument.
    const result = await run([...cli, "init", url], env);
    if (result.code !== 0) throw new Error(`Executor initialization failed: ${result.stderr}`);
  }
  for (const directory of ["journal", "logs", "tasks/inbox", "tasks/active", "tasks/done", "tasks/failed", "tasks/blocked", "tasks/waiting", "tasks/proposed", "tasks/rejected", "decisions/open", "decisions/closed", "fleet/hosts"])
    mkdirSync(join(home, "data", directory), { recursive: true });
  const local = join(home, "data", "config.local.toml");
  // App executors only need the outbound cloud bridge, never a local chat listener or tunnel.
  const overrides = existsSync(local) ? readFileSync(local, "utf8") : "";
  if (!/^\[server\]/m.test(overrides)) appendFileSync(local, "\n[server]\nenabled = false\n[tunnel]\nmode = \"off\"\n", { mode: 0o600 });
  if (!/^\[cloud\]/m.test(overrides)) appendFileSync(local, `\n[cloud]\nurl = ${JSON.stringify(url)}\n`, { mode: 0o600 });
}

export async function desktop(options: { root?: string; cli?: string[] } = {}) {
  if (process.platform !== "darwin") throw new Error("Automatic execution is available on macOS");
  const input = JSON.parse(await Bun.stdin.text()) as { action?: string; url?: string; session?: string };
  if (typeof input.url !== "string" || !["start", "stop"].includes(input.action ?? "")) throw new Error("Invalid executor request");
  const binding = desktopBinding(input.url, options.root);
  const { home, label } = binding;
  if (input.action === "stop" && !existsSync(home)) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const unlock = lockDaemon(home);
  process.once("exit", unlock);
  const domain = `gui/${process.getuid!()}`, service = `${domain}/${label}`;
  if (input.action === "stop") {
    // disable affects future loads; PathState also prevents this loaded job from respawning.
    rmSync(join(home, "enabled"), { force: true });
    const disabled = await run(["/bin/launchctl", "disable", service]);
    if (disabled.code) throw new Error(disabled.stderr);
    const state = await run(["/bin/launchctl", "print", service]);
    if (state.code === 0 && /\bpid = \d+/.test(state.stdout)) {
      const stopped = await run(["/bin/launchctl", "kill", "SIGTERM", service]);
      if (stopped.code) throw new Error(stopped.stderr);
    }
    return;
  }
  let cli = options.cli ?? command();
  const development = cli.length > 1;
  const sourceMarker = join(home, "dev-source");
  const enableWatch = development && !existsSync(sourceMarker);
  await enrollDesktop(binding, input.session ?? "", cli);
  if (development) writeFileSync(sourceMarker, cli[1], { mode: 0o600 });
  else rmSync(sourceMarker, { force: true });
  if (cli.length === 1) {
    // launchd must survive the app being moved or replaced during an update.
    const runtime = join(home, "runtime", "onlyone-executor");
    mkdirSync(dirname(runtime), { recursive: true, mode: 0o700 });
    const version = createHash("sha256").update(readFileSync(cli[0])).digest("hex");
    const stamp = `${runtime}.sha256`;
    if (!existsSync(runtime) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== version) {
      const replacing = existsSync(runtime);
      const next = `${runtime}.next`;
      copyFileSync(cli[0], next);
      chmodSync(next, 0o700);
      renameSync(next, runtime);
      writeFileSync(stamp, version, { mode: 0o600 });
      if (replacing) writeFileSync(join(home, "restart-requested"), `${new Date().toISOString()} force`, { mode: 0o600 });
    }
    cli = [runtime];
  }
  const path = [dirname(process.execPath), join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, executorPlist(label, [...cli, "daemon"], home, path, development), { mode: 0o600 });
  writeFileSync(join(home, "enabled"), "", { mode: 0o600 });
  const enabled = await run(["/bin/launchctl", "enable", service]);
  if (enabled.code) throw new Error(enabled.stderr);
  let state = await run(["/bin/launchctl", "print", service]);
  if (enableWatch && /\bpid = \d+/.test(state.stdout)) {
    const restarted = await run(["/bin/launchctl", "kill", "SIGTERM", service]);
    if (restarted.code) throw new Error(restarted.stderr);
  }
  if (state.code) {
    const installed = await run(["/bin/launchctl", "bootstrap", domain, plist]);
    if (installed.code) throw new Error(installed.stderr);
  } else if (!/\bpid = \d+/.test(state.stdout)) {
    const started = await run(["/bin/launchctl", "kickstart", service]);
    if (started.code) throw new Error(started.stderr);
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    state = await run(["/bin/launchctl", "print", service]);
    const pid = state.stdout.match(/\bpid = (\d+)/)?.[1];
    const ready = join(home, "service-ready");
    if (pid && existsSync(ready) && readFileSync(ready, "utf8").trim() === pid) return;
    await Bun.sleep(250);
  }
  throw new Error(`Executor did not become ready; see ${join(home, "executor.log")}`);
}
