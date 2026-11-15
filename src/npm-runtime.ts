import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLI_VERSION } from "./release";
import { HOME_DIR, DATA } from "./core";
import { lockDaemon } from "./daemon-lock";
import launcher from "../npm/launcher.cjs" with { type: "text" };

export type NpmRelease = { binary: string; version: string };
export type NpmCurrent = NpmRelease & { previous?: NpmRelease; next?: NpmRelease; pending?: boolean };
export const runtimeDir = () => join(HOME_DIR, "cli");
export const currentPath = () => join(runtimeDir(), "current.json");
export function currentRelease(): NpmCurrent { return JSON.parse(readFileSync(currentPath(), "utf8")); }
export function writeCurrent(state: NpmCurrent) {
  const file = currentPath();
  writeFileSync(file + ".next", JSON.stringify(state), { mode: 0o600 });
  renameSync(file + ".next", file);
}

/** npm's global install may be read-only; only private version directories are changed by remote updates. */
export function ensureNpmRuntime() {
  const node = process.env.ONLYONE_NODE, npm = process.env.ONLYONE_NPM_CLI;
  if (!node || !npm) throw new Error("Run onlyone through its npm command with Node.js and npm installed");
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir(), 0o700);
  if (!existsSync(currentPath())) {
    const dir = join(runtimeDir(), "releases", CLI_VERSION);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const binary = join(dir, process.platform === "win32" ? "onlyone.exe" : "onlyone");
    copyFileSync(process.execPath, binary);
    chmodSync(binary, 0o700);
    writeCurrent({ binary, version: CLI_VERSION });
  }
  writeFileSync(join(runtimeDir(), "launcher.cjs"), launcher, { mode: 0o600 });
  writeFileSync(join(runtimeDir(), "service.json"), JSON.stringify({
    ONLYONE_HOME: HOME_DIR, ONLYONE_DATA_DIR: DATA, ONLYONE_CONF: resolve(process.env.ONLYONE_CONF || join(HOME_DIR, "onlyone.toml")),
    ONLYONE_NODE: node, ONLYONE_NPM_CLI: npm, PATH: process.env.PATH || "",
  }), { mode: 0o600 });
  return [node, join(runtimeDir(), "launcher.cjs"), "--service"];
}

async function npmCommand(args: string[]) {
  const node = process.env.ONLYONE_NODE, npm = process.env.ONLYONE_NPM_CLI;
  if (!node || !npm) throw new Error("npm location is missing; run onlyone again from your terminal");
  const child = Bun.spawn([node, npm, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_update_notifier: "false" } });
  const timer = setTimeout(() => child.kill(), 5 * 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`npm failed (${code}): ${err.slice(-1500)}`);
    return out.trim();
  } finally { clearTimeout(timer); }
}

export function newerCliVersion(latest: string, current: string) {
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error("npm latest did not return a stable OnlyOne version");
  const a = latest.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
export async function checkNpmUpdate() {
  const version: unknown = JSON.parse(await npmCommand(["view", "onlyonecli@latest", "version", "--json"]));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("npm latest did not return a stable OnlyOne version");
  return { version, available: newerCliVersion(version, existsSync(currentPath()) ? currentRelease().version : CLI_VERSION) };
}

export async function stageNpmUpdate() {
  if (!existsSync(currentPath())) ensureNpmRuntime();
  const unlock = lockDaemon(join(runtimeDir(), "update"));
  try {
    const current = currentRelease();
    if (current.next || current.pending) throw new Error("An OnlyOne update is already waiting for restart");
    const { version, available } = await checkNpmUpdate();
    if (!available) return false;
    const dir = join(runtimeDir(), "releases", version);
    // Never overwrite a binary that another process (especially Windows) may still be running.
    const attempt = join(dir, `install-${Date.now()}-${process.pid}`);
    mkdirSync(attempt, { recursive: true, mode: 0o700 });
    try {
      await npmCommand(["install", "--prefix", attempt, "--ignore-scripts", "--no-audit", "--no-fund", "--include=optional", "--save-exact", `onlyonecli@${version}`]);
      const manifest = JSON.parse(readFileSync(join(attempt, "node_modules", "onlyonecli", "package.json"), "utf8"));
      if (manifest.version !== version) throw new Error("Downloaded OnlyOne version does not match the requested version");
      const binary = join(attempt, "node_modules", `onlyone-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`, "bin", process.platform === "win32" ? "onlyone.exe" : "onlyone");
      for (const args of [["--version"], ["--self-check"]]) {
        const result = Bun.spawnSync([binary, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
        if (result.exitCode !== 0 || (args[0] === "--version" && result.stdout.toString().trim() !== version)) throw new Error("Downloaded OnlyOne failed startup self-check");
      }
      writeCurrent({ ...current, next: { version, binary } });
      return true;
    } catch (error) { rmSync(attempt, { recursive: true, force: true }); throw error; }
  } finally { unlock(); }
}

/** Called only after the old daemon has drained and flushed its final state. */
export function activateNpmUpdate() {
  if (!existsSync(currentPath())) return;
  const current = currentRelease();
  if (current.next) writeCurrent({ ...current.next, previous: { binary: current.binary, version: current.version }, pending: true });
}

export function requestNpmRestart() {
  writeFileSync(join(dirname(DATA), "restart-requested"), `${new Date().toISOString()} force`, { mode: 0o600 });
}
