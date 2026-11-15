// Development source bootstrap only. Release desktop apps use onlyonecli app control.
import { createHash } from "node:crypto";
import { npmBuild } from "./release";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lockDaemon } from "./daemon-lock";
import type { DesktopStatus } from "./desktop-status";

export function desktopBinding(value: string, root = join(homedir(), ".onlyone")) {
  const url = new URL(value);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Enter an OnlyOne server origin, without a path or credentials");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("OnlyOne requires HTTPS except on localhost");
  const home = resolve(root);
  const key = createHash("sha256").update(home + "\0" + url.origin).digest("hex").slice(0, 24);
  return { url: url.origin, home, label: `dev.onlyone.development.${key}` };
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
export async function enrollDesktop(binding: ReturnType<typeof desktopBinding> & { data?: string }, session: string, cli = command()) {
  const { home, url } = binding;
  const data = binding.data ?? join(home, "data");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const cfgPath = join(home, "onlyone.toml");
  const saved = existsSync(cfgPath) ? Bun.TOML.parse(readFileSync(cfgPath, "utf8")) as any : {};
  if (saved.cloud?.url && saved.cloud.url !== url) throw new Error("This executor belongs to another cloud");
  const env = { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: data, ONLYONE_CONF: cfgPath, ONLYONE_SYNC: "", ONLYONE_SYNC_FAKE: "", ONLYONE_NO_MEDIC: "1" };
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
  if (!existsSync(join(data, "config.toml"))) {
    // init reads the stored credential; it is not passed as an argument.
    const result = await run([...cli, "init", url], env);
    if (result.code !== 0) throw new Error(`Executor initialization failed: ${result.stderr}`);
  }
  for (const directory of ["journal", "logs", "tasks/inbox", "tasks/active", "tasks/done", "tasks/failed", "tasks/blocked", "tasks/waiting", "tasks/proposed", "tasks/rejected", "decisions/open", "decisions/closed", "fleet/hosts"])
    mkdirSync(join(data, directory), { recursive: true });
}

export async function desktop(options: { root?: string; cli?: string[] } = {}) {
  if (npmBuild) throw new Error("Release apps must use onlyone app");
  if (process.platform !== "darwin") throw new Error("Automatic execution is available on macOS");
  const input = JSON.parse(await Bun.stdin.text()) as { action?: string; url?: string; session?: string };
  if (typeof input.url !== "string" || !["start", "stop", "status"].includes(input.action ?? "")) throw new Error("Invalid executor request");
  const { HOME_DIR, DATA } = await import("./core");
  const { npmServiceStatus, stopNpmService } = await import("./npm-service");
  const source = desktopBinding(input.url, options.root ?? HOME_DIR);
  const home = source.home;
  const data = options.root ? join(home, "data") : DATA;
  const binding = { ...source, home, data };
  const { label, url } = binding;
  const saved = existsSync(join(home, "onlyone.toml")) ? Bun.TOML.parse(readFileSync(join(home, "onlyone.toml"), "utf8")) as any : {};
  if (saved.cloud?.url && desktopBinding(saved.cloud.url).url !== url) throw new Error("onlyonecli is connected to another server; local data was kept");
  const domain = `gui/${process.getuid!()}`, service = `${domain}/${label}`;
  const inspect = () => run(["/bin/launchctl", "print", service]);
  const pidOf = (state: { stdout: string }) => state.stdout.match(/\bpid = (\d+)/)?.[1];
  const status = async (): Promise<DesktopStatus> => {
    const running = !!pidOf(await inspect());
    return running ? { running, stopping: !existsSync(join(home, "enabled")), mode: "development" } : options.root ? { running: false, stopping: false, mode: null } : npmServiceStatus();
  };
  if (input.action === "status") { console.log(JSON.stringify(await status())); return; }
  if (input.action === "stop" && !existsSync(home)) { console.log(JSON.stringify(await status())); return; }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let unlock: () => void;
  for (;;) {
    try { unlock = lockDaemon(join(home, "cli", "app-control")); break; }
    catch (error) {
      if (!(error instanceof Error) || !/already using|executor is starting/.test(error.message)) throw error;
      await Bun.sleep(250);
    }
  }
  process.once("exit", unlock);
  try {
    const stop = () => stopDevelopmentDesktop(binding);
    if (input.action === "stop") {
      await stop();
      if (!options.root) await stopNpmService();
      console.log(JSON.stringify(await status()));
      return;
    }
    const cli = options.cli ?? command();
    if (cli.length < 2) throw new Error("Use onlyonecli for release executors");
    const sourceMarker = join(home, "dev-source");
    if (!options.root && npmServiceStatus().mode === "release") await stopNpmService();
    await enrollDesktop(binding, input.session ?? "", cli);
    const local = join(data, "config.local.toml");
    // Dedicated development homes need only the outbound bridge.
    const overrides = existsSync(local) ? readFileSync(local, "utf8") : "";
    if (!saved.server?.token && !/^\[server\]/m.test(overrides)) appendFileSync(local, "\n[server]\nenabled = false\n[tunnel]\nmode = \"off\"\n", { mode: 0o600 });
    if (!saved.server?.token && !/^\[cloud\]/m.test(overrides)) appendFileSync(local, `\n[cloud]\nurl = ${JSON.stringify(url)}\n`, { mode: 0o600 });
    const path = [dirname(process.execPath), join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");
    const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    let state = await inspect();
    const loaded = state.stdout.match(/\n\s*arguments = \{\n([\s\S]*?)\n\s*\}/)?.[1]
      .trim().split("\n").map((line) => line.trim());
    const args = [...cli, "daemon"];
    const changed = JSON.stringify(loaded) !== JSON.stringify(args);
    if (state.code === 0 && (changed || !existsSync(join(home, "enabled")))) {
      await stop();
      state = await inspect();
    }
    writeFileSync(sourceMarker, cli[1], { mode: 0o600 });
    writeFileSync(plist, executorPlist(label, args, home, path, true), { mode: 0o600 });
    writeFileSync(join(home, "enabled"), "", { mode: 0o600 });
    const enabled = await run(["/bin/launchctl", "enable", service]);
    if (enabled.code) throw new Error(enabled.stderr);
    if (state.code) {
      const installed = await run(["/bin/launchctl", "bootstrap", domain, plist]);
      if (installed.code) throw new Error(installed.stderr);
    } else if (!pidOf(state)) {
      const started = await run(["/bin/launchctl", "kickstart", service]);
      if (started.code) throw new Error(started.stderr);
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      state = await run(["/bin/launchctl", "print", service]);
      const pid = state.stdout.match(/\bpid = (\d+)/)?.[1];
      const ready = join(home, "service-ready");
      if (pid && existsSync(ready) && readFileSync(ready, "utf8").trim() === pid) { console.log(JSON.stringify(await status())); return; }
      await Bun.sleep(250);
    }
    throw new Error(`Executor did not become ready; see ${join(home, "executor.log")}`);
  } finally { process.off("exit", unlock); unlock(); }
}

/** The source executor is development-only; formal desktop apps always use onlyonecli. */
export async function stopDevelopmentDesktop(binding: ReturnType<typeof desktopBinding>) {
  if (process.platform !== "darwin") return;
  const job = `gui/${process.getuid!()}/${binding.label}`;
  const state = await run(["/bin/launchctl", "print", job]);
  if (state.code) return;
  rmSync(join(binding.home, "enabled"), { force: true });
  const disabled = await run(["/bin/launchctl", "disable", job]);
  if (disabled.code) throw new Error(disabled.stderr);
  if (/\bpid = \d+/.test(state.stdout)) {
    const signalled = await run(["/bin/launchctl", "kill", "SIGTERM", job]);
    if (signalled.code) throw new Error(signalled.stderr);
    while (/\bpid = \d+/.test((await run(["/bin/launchctl", "print", job])).stdout)) await Bun.sleep(250);
  }
  const unloaded = await run(["/bin/launchctl", "bootout", job]);
  if (unloaded.code && !(await run(["/bin/launchctl", "print", job])).code) throw new Error(unloaded.stderr);
}
