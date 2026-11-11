import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { deploymentConfig, templateFiles } from "../cloud/deploy";
import { claimPrimary } from "../cloud/src/bootstrap";
import { handleFiles, initFilesSchema } from "../cloud/src/files";
import { sendResend } from "../cloud/src/resend";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { ONLYONE_WORKER_NAME: "onlyone", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), ONLYONE_DOMAIN: "onlyone.example.com",
  ONLYONE_OWNER_EMAIL: "Owner@example.com", ONLYONE_MAIL_FROM: "login@example.com", ONLYONE_RESEND_API_KEY: "test-resend" };

test("standalone configuration and templates do not depend on an executor home", () => {
  expect(deploymentConfig(env).owner).toBe("owner@example.com");
  expect(() => deploymentConfig({ ...env, ONLYONE_RESEND_API_KEY: "" })).toThrow("ONLYONE_RESEND_API_KEY");
  expect(() => deploymentConfig({ ...env, ONLYONE_DOMAIN: "bad/path" })).toThrow("ONLYONE_DOMAIN");
  const files = templateFiles("https://onlyone.example.com", "owner@example.com");
  const config = Bun.TOML.parse(Buffer.from(files.find((f) => f.path === "config.toml")!.content, "base64").toString()) as any;
  expect(config.fleet.primary).toBe("");
  expect(config.cloud.url).toBe("https://onlyone.example.com");
  expect(config.email.to).toBe("owner@example.com");
  expect(files.some((f) => f.path === "agents/lead/profile.md")).toBe(true);
});

test("concurrent first joins choose one coordinator and preserve it on rejoin", async () => {
  const db = new Database(":memory:");
  const sql = { exec(q: string, ...bindings: any[]) {
    if (!bindings.length && q.trim().replace(/;\s*$/, "").includes(";")) { db.exec(q); return { toArray: () => [] }; }
    const rows = db.query(q).all(...bindings.map((v) => v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    return { toArray: () => rows as any[] };
  } };
  try {
    initFilesSchema(sql);
    expect(await claimPrimary(sql, "mac")).toBeNull();
    const req = new Request("https://onlyone/api/files/commit", { method: "POST", body: JSON.stringify({ msg: "seed", changes: templateFiles("https://onlyone.example.com", "owner@example.com") }) });
    expect((await handleFiles(sql, req, new URL(req.url), "deploy"))?.ok).toBe(true);
    const results = await Promise.all([claimPrimary(sql, "mac"), claimPrimary(sql, "linux")]);
    expect(new Set(results).size).toBe(1);
    expect(await claimPrimary(sql, "third")).toBe(results[0]);
    const config = new TextDecoder().decode(sql.exec("SELECT content FROM files WHERE path = 'config.toml'").toArray()[0].content);
    expect((Bun.TOML.parse(config) as any).fleet.primary).toBe(results[0]);
    expect(sql.exec("SELECT version FROM files WHERE path = 'config.toml'").toArray()[0].version).toBe(2);
  } finally { db.close(); }
});

test("Resend uses HTTPS, a timeout and never includes provider error bodies in errors", async () => {
  const request = (async (input: any, init: any) => {
    expect(input).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer test-resend");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ from: "OnlyOne <login@example.com>", to: ["owner@example.com"], subject: "code", text: "test" });
    return new Response("sensitive provider response", { status: 403 });
  }) as typeof fetch;
  await expect(sendResend("test-resend", "login@example.com", "owner@example.com", "code", "test", request)).rejects.toThrow("Resend HTTP 403");
  const timeout = (async () => { throw new Error("sensitive transport details"); }) as unknown as typeof fetch;
  await expect(sendResend("test-resend", "login@example.com", "owner@example.com", "code", "test", timeout)).rejects.toThrow("Resend request failed or timed out");
});

test("CLI initializes a new app mirror and repeating init preserves its data", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-rejoin-"));
  const content = Buffer.from('[fleet]\nprimary = "first-mac"\n');
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== "Bearer new-token") return Response.json({}, { status: 401 });
    if (url.pathname === "/api/host/security") return Response.json({ primary: "first-mac" });
    if (url.pathname === "/api/files/changes") return Response.json({ rev: 1, more: false, files: url.searchParams.get("since") === "0" ? [{
      path: "config.toml", version: 1, rev: 1, deleted: false, content: content.toString("base64"), hash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    }] : [] });
    return Response.json({}, { status: 404 });
  } });
  const url = server.url.origin;
  try {
    const run = async () => {
      const process = Bun.spawn(["bun", "src/cli.ts", "init", url, "--token", "new-token"], {
        cwd: join(import.meta.dir, ".."), env: { ...globalThis.process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: "", ONLYONE_SYNC: "", ONLYONE_SYNC_FAKE: "" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
      expect({ code, stderr, joined: stdout.includes("joined") }).toEqual({ code: 0, stderr: "", joined: true });
    };
    await run();
    expect(readFileSync(join(home, "data", "config.toml"), "utf8")).toBe(content.toString());
    await run();
    expect(readFileSync(join(home, "data", "config.toml"), "utf8")).toBe(content.toString());
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
