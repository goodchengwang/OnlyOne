import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { desktopBinding, enrollDesktop, executorPlist } from "../src/desktop";
import { lockDaemon } from "../src/daemon-lock";
import { ignored } from "../src/sync";

test("desktop bindings share the CLI home, isolate development service labels and reject unsafe addresses", () => {
  const a = desktopBinding("https://EXAMPLE.com:443/", "/tmp/app");
  expect(a).toEqual(desktopBinding("https://example.com", "/tmp/app"));
  expect(a.home).toBe("/tmp/app");
  expect(a.label).not.toBe(desktopBinding("https://example.com", "/tmp/other-home").label);
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
    expect(config.server).toBeUndefined();
    expect((Bun.TOML.parse(bootstrap) as any).cloud.url).toBe(server.url.origin);
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

test.skipIf(!hasLaunchd)("development source service reloads and drains without a bundled runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-source-service-"));
  const binding = desktopBinding(`http://localhost:${20000 + Math.floor(Math.random() * 40000)}`, root);
  const job = `gui/${process.getuid!()}/${binding.label}`;
  const stub = join(root, "daemon.ts");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/cli.ts"), 'console.log("source");');
  mkdirSync(join(binding.home, "data"), { recursive: true });
  writeFileSync(join(binding.home, "onlyone.toml"), `[cloud]\nurl = ${JSON.stringify(binding.url)}\n[server]\ntoken = "test-machine"\n`);
  writeFileSync(join(binding.home, "data/config.toml"), '[fleet]\nprimary = "test"\n');
  writeFileSync(stub, `
    import { writeFileSync, appendFileSync, existsSync } from "node:fs";
    const home = process.env.ONLYONE_HOME;
    appendFileSync(home + "/starts", process.pid + "\\n");
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      writeFileSync(home + "/stopping", "yes");
      setInterval(() => { if (!existsSync(home + "/hold")) process.exit(0); }, 50);
    };
    process.on("SIGTERM", stop);
    const { watchDevelopment } = await import(${JSON.stringify(join(import.meta.dir, "../src/dev-reload.ts"))});
    await watchDevelopment(${JSON.stringify(root)}, stop);
    writeFileSync(home + "/service-ready", String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const invoke = async (action: string) => {
    const code = `import { desktop } from ${JSON.stringify(join(import.meta.dir, "../src/desktop.ts"))}; await desktop(${JSON.stringify({ root, cli: [process.execPath, stub] })});`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdin: new Blob([JSON.stringify({ action, url: binding.url })]), stdout: "pipe", stderr: "pipe" });
    const [exit, error, output] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  try {
    expect(await invoke("start")).toMatchObject({ running: true, mode: "development" });
    const pid = readFileSync(join(binding.home, "service-ready"), "utf8");
    await invoke("start");
    expect(readFileSync(join(binding.home, "starts"), "utf8").trim().split("\n")).toEqual([pid]);
    writeFileSync(join(root, "src/cli.ts"), 'console.log("changed");');
    for (let n = 0; n < 100 && readFileSync(join(binding.home, "service-ready"), "utf8") === pid; n++) await Bun.sleep(100);
    expect(readFileSync(join(binding.home, "service-ready"), "utf8")).not.toBe(pid);
    writeFileSync(join(binding.home, "hold"), "active task");
    let done = false;
    const stopping = invoke("stop").then(s => { done = true; return s; });
    await Bun.sleep(10_500);
    expect(done).toBe(false);
    expect(await invoke("status")).toMatchObject({ running: true, stopping: true });
    rmSync(join(binding.home, "hold"));
    expect(await stopping).toEqual({ running: false, stopping: false, mode: null });
    const starts = readFileSync(join(binding.home, "starts"), "utf8");
    await Bun.sleep(1500);
    expect(readFileSync(join(binding.home, "starts"), "utf8")).toBe(starts);
  } finally {
    Bun.spawnSync(["/bin/launchctl", "bootout", job], { stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["/bin/launchctl", "enable", job], { stdout: "ignore", stderr: "ignore" });
    rmSync(join(homedir(), "Library/LaunchAgents", `${binding.label}.plist`), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
