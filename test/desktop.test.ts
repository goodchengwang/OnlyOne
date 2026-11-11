import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { desktopBinding, enrollDesktop, executorPlist } from "../src/desktop";
import { lockDaemon } from "../src/daemon-lock";
import { ignored } from "../src/sync";

test("desktop cloud bindings normalize origins, isolate data and reject unsafe addresses", () => {
  const a = desktopBinding("https://EXAMPLE.com:443/", "/tmp/app");
  expect(a).toEqual(desktopBinding("https://example.com", "/tmp/app"));
  expect(a.home).not.toBe(desktopBinding("https://other.example.com", "/tmp/app").home);
  expect(desktopBinding("http://localhost:8799").url).toBe("http://localhost:8799");
  for (const value of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=secret", "file:///tmp"])
    expect(() => desktopBinding(value)).toThrow();
});

test("launchd keeps cloud credentials out of argv and escapes paths", () => {
  const plist = executorPlist("dev.onlyone.test", ["/tmp/A&B/onlyone", "daemon"], "/tmp/it's <private>", "/bin");
  expect(plist).toContain("A&amp;B");
  expect(plist).toContain("it&apos;s &lt;private&gt;");
  expect(plist).toContain("ONLYONE_HOME");
  expect(plist).toContain("KeepAlive");
  expect(plist).not.toContain("token");
});

test("daemon lock excludes duplicate executors, recovers a dead PID and is never synced", () => {
  const data = mkdtempSync(join(tmpdir(), "onlyone-lock-"));
  try {
    const unlock = lockDaemon(data);
    expect(() => lockDaemon(data)).toThrow("already using");
    unlock();
    mkdirSync(join(data, ".daemon-lock"));
    writeFileSync(join(data, ".daemon-lock/pid"), "2147483647");
    lockDaemon(data)();
    expect(existsSync(join(data, ".daemon-lock"))).toBe(false);
    expect(ignored(".daemon-lock/pid")).toBe(true);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("app enrollment uses the login session once, initializes the mirror, and reopens without cloud requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-desktop-"));
  const calls: string[] = [];
  const content = Buffer.from('[fleet]\nprimary = "first-mac"\n');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    calls.push(url.pathname);
    if (url.pathname === "/api/host/join") {
      expect(request.headers.get("authorization")).toBe("Bearer owner-session");
      expect((await request.json() as any).host).toBeTruthy();
      return Response.json({ token: "machine-secret" });
    }
    if (request.headers.get("authorization") !== "Bearer machine-secret") return Response.json({}, { status: 401 });
    if (url.pathname === "/api/host/security") return Response.json({ primary: "first-mac" });
    if (url.pathname === "/api/files/changes") return Response.json({ rev: 1, more: false, files: [{
      path: "config.toml", version: 1, rev: 1, deleted: false, content: content.toString("base64"), hash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    }] });
    return Response.json({}, { status: 404 });
  } });
  try {
    const binding = desktopBinding(server.url.origin, root);
    await enrollDesktop(binding, "owner-session", [process.execPath, join(import.meta.dir, "../src/cli.ts")]);
    expect(calls).toEqual(["/api/host/join", "/api/host/security", "/api/files/changes"]);
    const bootstrap = readFileSync(join(binding.home, "onlyone.toml"), "utf8");
    expect(bootstrap).toContain("machine-secret");
    expect(bootstrap).not.toContain("owner-session");
    expect(statSync(join(binding.home, "onlyone.toml")).mode & 0o777).toBe(0o600);
    expect(statSync(binding.home).mode & 0o777).toBe(0o700);
    expect(existsSync(join(binding.home, "data/journal"))).toBe(true);
    const config = Bun.TOML.parse(readFileSync(join(binding.home, "data/config.local.toml"), "utf8")) as any;
    expect(config.server.enabled).toBe(false);
    expect(config.cloud.url).toBe(server.url.origin);
    await enrollDesktop(binding, "new-session");
    expect(calls).toHaveLength(3);
    writeFileSync(join(binding.home, "onlyone.toml"), '[cloud]\nurl = "https://other.example.com"\n');
    await expect(enrollDesktop(binding, "owner-session")).rejects.toThrow("another cloud");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("rejected enrollment never creates a credential or data mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-desktop-rejected-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}, { status: 401 }) });
  try {
    const binding = desktopBinding(server.url.origin, root);
    await expect(enrollDesktop(binding, "expired")).rejects.toThrow("401");
    expect(existsSync(join(binding.home, "onlyone.toml"))).toBe(false);
    expect(existsSync(join(binding.home, "data"))).toBe(false);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("uninitialized daemon explains how to bind instead of crashing while writing its journal", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-uninitialized-"));
  try {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "daemon"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: "", ONLYONE_NO_MEDIC: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(error).toContain("not initialized");
    expect(error).not.toContain("ENOENT");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const hasLaunchd = process.platform === "darwin" && Bun.spawnSync(["/bin/launchctl", "print", `gui/${process.getuid!()}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
for (const source of [false, true]) {
test.skipIf(!hasLaunchd)(`launchd reuses, reloads and stops the ${source ? "source" : "packaged"} executor`, async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-launchd-"));
  const binding = desktopBinding(`http://localhost:${20000 + Math.floor(Math.random() * 40000)}`, root);
  const service = `gui/${process.getuid!()}/${binding.label}`;
  const ctl = async (...args: string[]) => {
    const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  };
  const stub = join(root, "daemon.ts");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/cli.ts"), 'console.log("original source");');
  mkdirSync(join(binding.home, "data"), { recursive: true });
  writeFileSync(join(binding.home, "onlyone.toml"), `[cloud]\nurl = ${JSON.stringify(binding.url)}\n[server]\ntoken = "test-machine"\n`);
  writeFileSync(join(binding.home, "data/config.toml"), "[fleet]\nprimary = \"test\"\n");
  writeFileSync(stub, `#!${process.execPath}
    import { writeFileSync, appendFileSync } from "node:fs";
    const root = process.env.ONLYONE_HOME;
    appendFileSync(root + "/starts", process.pid + "\\n");
    const stop = () => {
      writeFileSync(root + "/stopping", "yes");
      setTimeout(() => { writeFileSync(root + "/finished", "yes"); process.exit(0); }, 200);
    };
    process.on("SIGTERM", stop);
    if (${source}) {
      const { watchDevelopment } = await import(${JSON.stringify(join(import.meta.dir, "../src/dev-reload.ts"))});
      await watchDevelopment(${JSON.stringify(root)}, stop);
    }
    writeFileSync(root + "/service-ready", String(process.pid));
    setInterval(() => {}, 1000);
  `);
  chmodSync(stub, 0o700);
  const invoke = async (action: string) => {
    const code = `import { desktop } from ${JSON.stringify(join(import.meta.dir, "../src/desktop.ts"))}; await desktop(${JSON.stringify({ root, cli: source ? [process.execPath, stub] : [stub] })});`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdin: new Blob([JSON.stringify({ action, url: binding.url, session: "" })]), stdout: "pipe", stderr: "pipe" });
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
  };
  try {
    await invoke("start");
    let pid = readFileSync(join(binding.home, "service-ready"), "utf8");
    const runtime = join(binding.home, "runtime/onlyone-executor");
    if (!source) expect(readFileSync(runtime, "utf8")).toBe(readFileSync(stub, "utf8"));
    const stamp = source ? 0 : statSync(runtime).mtimeMs;
    expect((await ctl("print", service)).stdout).toContain(`pid = ${pid}`);
    await invoke("start");
    if (!source) expect(statSync(runtime).mtimeMs).toBe(stamp);
    expect(readFileSync(join(binding.home, "starts"), "utf8").trim().split("\n")).toEqual([pid]);
    let starts = 1;
    if (source) {
      expect(existsSync(join(binding.home, "dev-source"))).toBe(true);
      writeFileSync(join(root, "src/cli.ts"), 'console.log("updated source");');
      for (let n = 0; n < 120; n++) {
        await Bun.sleep(50);
        if (readFileSync(join(binding.home, "service-ready"), "utf8") !== pid) break;
      }
      expect(existsSync(join(binding.home, "finished"))).toBe(true);
      const next = readFileSync(join(binding.home, "service-ready"), "utf8");
      expect(next).not.toBe(pid);
      pid = next;
      starts++;
    }
    rmSync(join(binding.home, "finished"), { force: true });
    await invoke("stop");
    for (let n = 0; n < 30 && !existsSync(join(binding.home, "finished")); n++) await Bun.sleep(50);
    expect(existsSync(join(binding.home, "stopping"))).toBe(true);
    expect(existsSync(join(binding.home, "finished"))).toBe(true);
    await Bun.sleep(11_000); // launchd's default restart throttle is ten seconds.
    expect(readFileSync(join(binding.home, "starts"), "utf8").trim().split("\n")).toHaveLength(starts);
    await invoke("start");
    expect(readFileSync(join(binding.home, "starts"), "utf8").trim().split("\n")).toHaveLength(starts + 1);
    if (!source) {
      appendFileSync(stub, "\n// updated runtime\n");
      await invoke("start");
      expect(readFileSync(runtime, "utf8")).toContain("updated runtime");
      expect(readFileSync(join(binding.home, "restart-requested"), "utf8")).toContain("force");
    }
  } finally {
    await ctl("bootout", service);
    await ctl("enable", service);
    rmSync(join(homedir(), "Library/LaunchAgents", `${binding.label}.plist`), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
}
