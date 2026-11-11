import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceDefinition, systemdQuote, systemdEnvironment } from "../src/npm-service";
import { displayRev } from "../src/release";

const setup = join(import.meta.dir, "../src/setup.ts");
async function initialize(home: string, url: string, answers = ["owner@example.com", "ABCD1234"]) {
  const code = `import { init } from ${JSON.stringify(setup)}; const answers = ${JSON.stringify(answers)}; await init({ worker: ${JSON.stringify(url)}, ask: async () => answers.shift() ?? "" });`;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: "", ONLYONE_SYNC: "", ONLYONE_SYNC_FAKE: "", ONLYONE_NO_MEDIC: "1" }, stdout: "pipe", stderr: "pipe" });
  const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, output: out + err };
}

test("email enrollment reuses the existing endpoints, persists only a private machine token and resumes a failed pull", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-npm-setup-"));
  const calls: string[] = [];
  let broken = true;
  const content = Buffer.from('[fleet]\nprimary = "coordinator"\n');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push(path);
    if (path === "/api/auth/start") { expect(await req.json()).toEqual({ email: "owner@example.com" }); return Response.json({ ok: true }); }
    if (path === "/api/auth/verify") { expect(await req.json()).toEqual({ email: "owner@example.com", code: "ABCD1234" }); return Response.json({ session: "temporary-session" }); }
    if (path === "/api/host/join" || path === "/api/auth/logout") {
      expect(req.headers.get("authorization")).toBe("Bearer temporary-session");
      return Response.json(path.endsWith("join") ? { token: "machine-secret" } : { ok: true });
    }
    expect(req.headers.get("authorization")).toBe("Bearer machine-secret");
    if (path === "/api/host/security") return Response.json({ primary: "coordinator" });
    if (path === "/api/files/changes") return broken ? Response.json({}, { status: 503 }) : Response.json({ rev: 1, more: false, files: [{ path: "config.toml", version: 1, rev: 1, deleted: false, content: content.toString("base64"), hash: new Bun.CryptoHasher("sha256").update(content).digest("hex") }] });
    return Response.json({}, { status: 404 });
  } });
  try {
    const first = await initialize(home, server.url.origin);
    expect(first.status).toBe(1);
    expect(first.output).toContain("Could not sync");
    const saved = readFileSync(join(home, "onlyone.toml"), "utf8");
    expect(saved).toContain("machine-secret");
    expect(saved).not.toContain("temporary-session");
    expect(first.output).not.toMatch(/machine-secret|temporary-session|ABCD1234/);
    if (process.platform !== "win32") expect(statSync(join(home, "onlyone.toml")).mode & 0o777).toBe(0o600);
    broken = false;
    const retry = await initialize(home, server.url.origin, []);
    expect(retry.status).toBe(0);
    expect(existsSync(join(home, "data/config.toml"))).toBe(true);
    expect(existsSync(join(home, "data/tasks/inbox"))).toBe(true);
    expect(calls.filter(p => p === "/api/auth/start")).toHaveLength(1);
    expect(calls.slice(0, 4)).toEqual(["/api/auth/start", "/api/auth/verify", "/api/host/join", "/api/auth/logout"]);
    const other = await initialize(home, "https://another.example.com", []);
    expect(other.status).toBe(1);
    expect(other.output).toContain("different installation");
    expect(readFileSync(join(home, "onlyone.toml"), "utf8")).toBe(saved);
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("wrong email code never registers a machine or writes credentials", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-npm-code-"));
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname; calls.push(path);
    return path.endsWith("start") ? Response.json({}) : Response.json({ error: "Invalid code" }, { status: 401 });
  } });
  try {
    const result = await initialize(home, server.url.origin);
    expect(result.status).toBe(1);
    expect(result.output).toContain("verification failed (401)");
    expect(calls).toEqual(["/api/auth/start", "/api/auth/verify"]);
    expect(existsSync(join(home, "onlyone.toml"))).toBe(false);
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("services quote paths and preserve a custom home without exposing machine credentials", () => {
  const args = ["/node path/node", "/private path/a&b/launcher.cjs", "--service"], home = "/private path/a&b";
  const linux = serviceDefinition("linux", args, home);
  expect(linux).toContain('ExecStart="/node path/node" "/private path/a&b/launcher.cjs" "--service"');
  expect(linux).toContain('Environment="ONLYONE_HOME=/private path/a&b"');
  expect(systemdQuote('a%$"\\')).toBe('"a%%$$\\"\\\\"');
  const mac = serviceDefinition("darwin", args, home);
  expect(mac).toContain("a&amp;b/launcher.cjs");
  expect(mac).toContain("<key>KeepAlive</key><true/>");
  const windows = serviceDefinition("win32", ["C:\\Program Files\\node.exe", "C:\\User Space\\service.cjs"], home);
  expect(windows).toContain("&quot;C:\\User Space\\service.cjs&quot;");
  expect(windows).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(windows).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  expect(windows).not.toContain("HighestAvailable");
});

test("npm semantic versions are never truncated like git commits", () => {
  expect(displayRev("10.20.300")).toBe("10.20.300");
  expect(displayRev("abcdef012345")).toBe("abcdef0");
});


test("systemd commands recover a missing bus address without overriding session settings", () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-user-bus-"));
  try {
    writeFileSync(join(home, "bus"), "");
    const env = { XDG_RUNTIME_DIR: home, PATH: "/tools" };
    expect(systemdEnvironment(env)).toEqual({ ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus` });
    const explicit = { ...env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/session" };
    expect(systemdEnvironment(explicit)).toEqual(explicit);
    expect(systemdEnvironment({ XDG_RUNTIME_DIR: join(home, "missing") })).toEqual({ XDG_RUNTIME_DIR: join(home, "missing") });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
