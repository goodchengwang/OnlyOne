import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { killDevelopmentGroup, serveDevelopment } from "../src/dev-executor";
import { lockDaemon } from "../src/daemon-lock";
import { desktopBinding, plistEscape, stopDevelopmentDesktop } from "../src/desktop";

const url = "https://example.com";
const waitFor = async (done: () => boolean) => {
  for (let n = 0; n < 200; n++) { if (done()) return; await Bun.sleep(25); }
  throw new Error("Development process did not reach the expected state");
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
function fixture() {
  const root = mkdtempSync("/tmp/oo-dev-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "data"));
  writeFileSync(join(root, "src/cli.ts"), 'console.log("before");');
  writeFileSync(join(root, "onlyone.toml"), `[cloud]\nurl = "${url}"\n[server]\ntoken = "fixture"\n`);
  writeFileSync(join(root, "data/config.toml"), '[fleet]\nprimary = "fixture"\n');
  const stub = join(root, "daemon.ts");
  writeFileSync(stub, `
    import { writeFileSync, existsSync } from "node:fs";
    import { lockDaemon } from ${JSON.stringify(join(import.meta.dir, "../src/daemon-lock.ts"))};
    import { watchDevelopment, watchDevelopmentOwner } from ${JSON.stringify(join(import.meta.dir, "../src/dev-reload.ts"))};
    const home = process.env.ONLYONE_HOME;
    process.once("exit", lockDaemon(home + "/data"));
    watchDevelopmentOwner();
    const worker = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"]);
    writeFileSync(home + "/worker", String(worker.pid));
    const stop = () => {
      const timer = setInterval(() => { if (!existsSync(home + "/hold")) { clearInterval(timer); process.exit(0); } }, 25);
    };
    process.on("SIGTERM", stop);
    await watchDevelopment(home, stop);
    writeFileSync(home + "/service-ready", String(process.pid));
    setInterval(() => {}, 1000);
  `);
  return { root, stub, cli: [process.execPath, stub] };
}
async function invoke(root: string, action: string, serverUrl = url) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { desktop } from ${JSON.stringify(join(import.meta.dir, "../src/desktop.ts"))};
    await desktop({root:${JSON.stringify(root)}});
  `], { stdin: new Blob([JSON.stringify({ action, url: serverUrl })]), stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, error, state: output ? JSON.parse(output.trim()) : null };
}
const pidAt = (root: string, file = "service-ready") => Number(readFileSync(join(root, file), "utf8"));

// The daemon is already reaped when cleanup runs, so its pid may be recycled. Darwin then answers
// EPERM (not ESRCH) for a group that holds none of our children: that is "already gone", not a failure.
// A real signal error must still surface, or teardown would fail silently.
test("cleanup survives a recycled process group id", () => {
  const real = process.kill;
  const failWith = (code: string) => {
    process.kill = (() => { throw Object.assign(new Error(`kill ${code}`), { code }); }) as typeof process.kill;
  };
  try {
    for (const code of ["EPERM", "ESRCH"]) {
      failWith(code);
      expect(() => killDevelopmentGroup(4321)).not.toThrow();
    }
    failWith("EINVAL");
    expect(() => killDevelopmentGroup(4321)).toThrow("EINVAL");
  } finally { process.kill = real; }
});

test.skipIf(process.platform !== "darwin")("bun dev owns source reload, stop and all executor children without launchd", async () => {
  const f = fixture();
  const session = serveDevelopment(f);
  let pid = 0, worker = 0;
  try {
    expect(statSync(join(f.root, "dev-control.sock")).mode & 0o777).toBe(0o600);
    expect(() => serveDevelopment(f)).toThrow("already using");
    const releaseControl = lockDaemon(join(f.root, "cli/app-control"));
    let started = false;
    const starting = invoke(f.root, "start").then(result => { started = true; return result; });
    try {
      await Bun.sleep(150);
      expect(started).toBe(false);
      expect(existsSync(join(f.root, "service-ready"))).toBe(false);
    } finally { releaseControl(); }
    expect(await starting).toMatchObject({ code: 0, state: { running: true, mode: "development" } });
    pid = pidAt(f.root); worker = pidAt(f.root, "worker");
    expect(await invoke(f.root, "start")).toMatchObject({ code: 0 });
    expect(pidAt(f.root)).toBe(pid);
    expect(await invoke(f.root, "stop", "https://other.example.com")).toMatchObject({ code: 1 });
    expect(alive(pid)).toBe(true);
    writeFileSync(join(f.root, "src/cli.ts"), 'console.log("after");');
    await waitFor(() => pidAt(f.root) !== pid);
    await waitFor(() => !alive(pid) && !alive(worker));
    pid = pidAt(f.root); worker = pidAt(f.root, "worker");
    writeFileSync(join(f.root, "hold"), "active task");
    expect(await invoke(f.root, "stop")).toMatchObject({ code: 0, state: { running: false } });
    await waitFor(() => !alive(pid) && !alive(worker));
    expect(await invoke(f.root, "start")).toMatchObject({ code: 0 });
    pid = pidAt(f.root); worker = pidAt(f.root, "worker");
    const releaseStop = lockDaemon(join(f.root, "cli/app-control"));
    try { await stopDevelopmentDesktop(desktopBinding(url, f.root)); }
    finally { releaseStop(); }
    await waitFor(() => !alive(pid) && !alive(worker));
    expect(await invoke(f.root, "start")).toMatchObject({ code: 0 });
    pid = pidAt(f.root); worker = pidAt(f.root, "worker");
    session.close();
    await waitFor(() => !alive(pid) && !alive(worker));
    expect(existsSync(join(f.root, "dev-control.sock"))).toBe(false);
    expect(await invoke(f.root, "start")).toMatchObject({ code: 1 });
    const job = `gui/${process.getuid!()}/${desktopBinding(url, f.root).label}`;
    expect(Bun.spawnSync(["launchctl", "print", job]).exitCode).not.toBe(0);
  } finally { session.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 20_000);

test.skipIf(process.platform !== "darwin")("SIGKILL of the dev owner kills the executor and its running agent; next dev start recovers", async () => {
  const f = fixture();
  const owner = Bun.spawn([process.execPath, "-e", `
    import { serveDevelopment } from ${JSON.stringify(join(import.meta.dir, "../src/dev-executor.ts"))};
    serveDevelopment(${JSON.stringify(f)});
    setInterval(()=>{},1000);
  `], { stdout: "ignore", stderr: "pipe" });
  let session: ReturnType<typeof serveDevelopment> | undefined;
  try {
    await waitFor(() => existsSync(join(f.root, "dev-control.sock")));
    expect(await invoke(f.root, "start")).toMatchObject({ code: 0 });
    const pid = pidAt(f.root), worker = pidAt(f.root, "worker");
    writeFileSync(join(f.root, "hold"), "active task");
    owner.kill("SIGKILL"); await owner.exited;
    await waitFor(() => !alive(pid) && !alive(worker));
    session = serveDevelopment(f);
    expect(await invoke(f.root, "start")).toMatchObject({ code: 0 });
    expect(pidAt(f.root)).not.toBe(pid);
  } finally {
    owner.kill("SIGKILL"); await owner.exited;
    session?.close(); rmSync(f.root, { recursive: true, force: true });
  }
}, 15_000);

const hasLaunchd = process.platform === "darwin" && Bun.spawnSync(["launchctl", "print", `gui/${process.getuid!()}`]).exitCode === 0;
test.skipIf(!hasLaunchd)("development retires an obsolete launchd job only for the same data mirror", async () => {
  for (const sameHome of [true, false]) {
    const f = fixture(), other = fixture();
    const old = sameHome ? f : other;
    const origin = `http://localhost:${20000 + Math.floor(Math.random() * 40000)}`;
    for (const home of [f.root, other.root])
      writeFileSync(join(home, "onlyone.toml"), `[cloud]\nurl = "${origin}"\n[server]\ntoken = "fixture"\n`);
    const label = `dev.onlyone.development.${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const job = `gui/${process.getuid!()}/${label}`;
    const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
    const s = (text: string) => `<string>${plistEscape(text)}</string>`;
    writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>Label</key>${s(label)}<key>ProgramArguments</key><array>${[...old.cli, "daemon"].map(s).join("")}</array>
      <key>EnvironmentVariables</key><dict><key>ONLYONE_HOME</key>${s(old.root)}<key>ONLYONE_DATA_DIR</key>${s(join(old.root, "data"))}</dict>
      <key>RunAtLoad</key><true/></dict></plist>`);
    const session = serveDevelopment(f);
    try {
      expect(Bun.spawnSync(["launchctl", "bootstrap", `gui/${process.getuid!()}`, plist]).exitCode).toBe(0);
      await waitFor(() => existsSync(join(old.root, "service-ready")));
      const oldPid = pidAt(old.root);
      expect(await invoke(f.root, "start", origin)).toMatchObject({ code: 0, state: { running: true } });
      expect(alive(oldPid)).toBe(!sameHome);
      expect(Bun.spawnSync(["launchctl", "print", job]).exitCode === 0).toBe(!sameHome);
    } finally {
      session.close();
      Bun.spawnSync(["launchctl", "bootout", job]);
      Bun.spawnSync(["launchctl", "enable", job]);
      rmSync(plist, { force: true });
      rmSync(f.root, { recursive: true, force: true }); rmSync(other.root, { recursive: true, force: true });
    }
  }
}, 15_000);
