// Development source bootstrap only. Release desktop apps use onlyonecli app control.
import { createHash } from "node:crypto";
import { npmBuild } from "./release";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lockDaemon } from "./daemon-lock";

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

const command = () => process.argv[1]?.startsWith("/$bunfs/")
  ? [process.execPath]
  : [process.execPath, resolve(import.meta.dir, "cli.ts")];

async function run(args: string[], env = process.env) {
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

/** Only a fresh binding calls join + init (3 requests); later app opens are entirely local. */
export async function enrollDesktop(binding: ReturnType<typeof desktopBinding> & { data?: string; conf?: string }, session: string, cli = command()) {
  const { home, url } = binding;
  const data = binding.data ?? join(home, "data");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const cfgPath = binding.conf ?? join(home, "onlyone.toml");
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
    mkdirSync(dirname(cfgPath), { recursive: true, mode: 0o700 });
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

export async function desktop(options: { root?: string } = {}) {
  if (npmBuild) throw new Error("Release apps must use onlyone app");
  const { appRequest } = await import("./cli-app");
  const input = appRequest(await Bun.stdin.text());
  const { HOME_DIR } = await import("./core");
  const home = options.root ?? HOME_DIR;
  let unlock: (() => void) | undefined;
  // Release control holds the same lock when switching back from development.
  if (input.action === "start") for (;;) {
    try { unlock = lockDaemon(join(home, "cli/app-control")); break; }
    catch (error) {
      if (!(error instanceof Error) || !/already using|executor is starting/.test(error.message)) throw error;
      await Bun.sleep(100);
    }
  }
  try {
    const response = await fetch("http://localhost/control", {
      unix: join(home, "dev-control.sock"), method: "POST", body: JSON.stringify(input),
    }).catch(() => { throw new Error("Start the development app with bun dev; its executor runs only while bun dev is running"); });
    if (!response.ok) throw new Error(await response.text());
    console.log(await response.text());
  } finally { unlock?.(); }
}

/** The source executor is development-only; formal desktop apps always use onlyonecli. */
export async function stopDevelopmentDesktop(binding: ReturnType<typeof desktopBinding> & { data?: string }) {
  if (process.platform !== "darwin") return;
  try {
    const response = await fetch("http://localhost/control", {
      unix: join(binding.home, "dev-control.sock"), method: "POST",
      body: JSON.stringify({ action: "stop", url: binding.url }),
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (error) {
    if (!["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  await stopDevelopmentJobs(binding);
}

export async function stopDevelopmentJobs(binding: ReturnType<typeof desktopBinding> & { data?: string }) {
  if (process.platform !== "darwin") return;
  // Earlier builds hashed only the URL; retire that job only if it owns this exact mirror.
  const label = `dev.onlyone.development.${createHash("sha256").update(binding.url).digest("hex").slice(0, 24)}`;
  await stopDevelopmentJob(binding);
  rmSync(join(homedir(), "Library/LaunchAgents", `${binding.label}.plist`), { force: true });
  const state = await run(["/bin/launchctl", "print", `gui/${process.getuid!()}/${label}`]);
  const lines = state.stdout.split("\n").map(line => line.trim());
  if (state.code || !lines.includes(`ONLYONE_HOME => ${binding.home}`) ||
      !lines.includes(`ONLYONE_DATA_DIR => ${binding.data ?? join(binding.home, "data")}`)) return;
  await stopDevelopmentJob({ ...binding, label });
  rmSync(join(homedir(), "Library/LaunchAgents", `${label}.plist`), { force: true });
}

async function stopDevelopmentJob(binding: ReturnType<typeof desktopBinding>) {
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
