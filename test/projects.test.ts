import { expect, test, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createProjectFiles, getProject, listProjects, projectInput, projectMemoryFile } from "../cloud/src/projects";
import { type ToolStore, readMemory, writeOp } from "../cloud/src/tools";
import { createProject } from "../src/projects";
import { DATA, P, newTask, readDoc, matches, remember } from "../src/core";
import { projectTools, localStore, dataActs, think } from "../src/brain";
import { buildPrompt } from "../src/runner";
import { resolveChannels, channels } from "../src/channels";
import { initFilesSchema } from "../cloud/src/files";

const aid = "prj-10000000-0000-4000-8000-000000000001", bid = "prj-10000000-0000-4000-8000-000000000002";
const input = (id = aid) => ({ id, name: id === aid ? "Alpha" : "Beta", host: "project-test-mac", repo: id === aid ? "/work/alpha" : "/work/beta" });
function memoryStore() {
  const files = new Map<string, string>();
  const st: ToolStore = { read: (path) => files.has(path) ? { path, text: files.get(path)!, updated: "2026-11-14" } : null,
    list: (dir) => [...files].filter(([p]) => p.startsWith(dir)).map(([path, text]) => ({ path, text, updated: "2026-11-14" })),
    status: () => ({}), events: () => [], lastSeq: () => 0, act: async () => ({ ok: true }) };
  const add = (a: unknown) => { const r = createProjectFiles(st, a); if (typeof r === "string") throw Error(r); for (const [p, t] of Object.entries(r.changes)) files.set(p, t); return r; };
  return { st, files, add };
}

test("only manually registered projects count; creation validates paths and retries are idempotent", () => {
  const { st, files, add } = memoryStore();
  files.set("memory/projects.md", "| Legacy discovered project | /old/repo |\n");
  files.set("channels/auto.md", "---\nname: discovered repo\n---\n");
  expect(listProjects(st)).toEqual([]);
  expect(projectInput({ ...input(), repo: "/work/../secret" })).toBeString();
  expect(projectInput({ ...input(), repo: "relative" })).toBeString();
  expect(projectInput({ ...input(), name: "bad\nfield: value" })).toBeString();
  expect(createProjectFiles(st, { ...input(), id: "../../escape" })).toBeString();
  const a = add(input());
  expect(Object.keys(a.changes)).toHaveLength(3);
  expect(add(input()).changes).toEqual({});
  expect(createProjectFiles(st, { ...input(bid), repo: "/work/alpha/" })).toBeString();
  expect(getProject(st, aid)?.repo).toBe("/work/alpha");
  expect(files.get("memory/projects.md")).not.toContain("Legacy");
  expect(writeOp("remember", { file: "memory/projects.md", text: "discovered repo" }, st)).toBeString();
  expect(writeOp("remember", { file: projectMemoryFile(bid), text: "x" }, st)).toBeString();
  expect(writeOp("create_task", { title: "x", project_id: bid }, st)).toBeString();
});

test("project tool scopes exclude other project memory and tasks; long memories are readable in sections", () => {
  const { st, files, add } = memoryStore(); add(input()); add(input(bid));
  files.set(projectMemoryFile(aid), "A".repeat(25000)); files.set(projectMemoryFile(bid), "B private rules");
  files.set("tasks/inbox/T-0001.md", `---\nproject_id: ${aid}\n---\n`);
  files.set("tasks/inbox/T-0002.md", `---\nproject_id: ${bid}\n---\n`);
  const a = projectTools(st, aid);
  expect(a.read(projectMemoryFile(bid))).toBeNull();
  expect(a.list("projects/").some((f) => f.text.includes("B private"))).toBe(false);
  expect(a.list("tasks/").map((f) => f.path)).toEqual(["tasks/inbox/T-0001.md"]);
  expect((readMemory(a, projectMemoryFile(aid), undefined, 20000) as any).text).toHaveLength(5000);
  expect((readMemory(a, projectMemoryFile(aid)) as any).truncated).toBe(true);
  expect(projectTools(st).list("projects/").some((f) => f.path.endsWith("memory.md"))).toBe(false);
});

test("real tasks pin their directory and host; project lessons and prompts stay separate", async () => {
  const tasks: string[] = [];
  try {
    mkdirSync(P("agents"), { recursive: true });
    expect(typeof createProject(input())).not.toBe("string"); expect(typeof createProject(input(bid))).not.toBe("string");
    writeFileSync(P(projectMemoryFile(aid)), "# Alpha\n- Alpha alone\n");
    writeFileSync(P(projectMemoryFile(bid)), "# Beta\n- Beta secret\n");
    const id = newTask("project work", "x", { repo: "/wrong", host: "wrong", extra: { project_id: aid } }); tasks.push(id);
    const { meta } = readDoc(P("tasks/inbox", `${id}.md`));
    expect(meta.repo).toBe("/work/alpha"); expect(meta.host).toBe("project-test-mac"); expect(meta.requires).toContain("host:project-test-mac"); expect(meta.channels).toBe(aid);
    expect(matches(meta, ["host:other"])).toBe(false);
    expect(matches(meta, ["host:project-test-mac"])).toBe(true);
    remember("lead", ["Alpha lesson"], id, aid);
    expect(readFileSync(P(projectMemoryFile(aid)), "utf8")).toContain("Alpha lesson");
    expect(buildPrompt(meta, "x", {})).toContain("Alpha alone");
    expect(buildPrompt(meta, "x", {})).not.toContain("Beta secret");
    expect(resolveChannels(["Alpha"])).toEqual([]);
    expect(resolveChannels([{ name: "prj-new", goal: "automatically discovered" }])).toEqual([]);
    expect(channels().find((c) => c.slug === aid)?.project_id).toBe(aid);
    const st = localStore({ root: DATA, status: () => ({}), feed: () => [], acts: dataActs("test", { pull: async () => true, push: async () => true }) });
    const writes = [{ calls: [{ tool: "remember", args: { file: "memory/principles.md", text: "Project-only rule" } }], reply: "" }];
    await think({ text: "记住这个", project_id: aid }, st, { open: async () => ({ send: async () => JSON.stringify(writes.shift()), close() {} }) }, () => {});
    expect(readFileSync(P(projectMemoryFile(aid)), "utf8")).toContain("Project-only rule");
  } finally {
    for (const id of [aid, bid]) rmSync(P("projects", id), { recursive: true, force: true });
    for (const id of tasks) rmSync(P("tasks/inbox", `${id}.md`), { force: true });
    rmSync(P("memory/projects.md"), { force: true });
  }
});

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const workerModule = "../cloud/src/index";
const { OnlyOne } = await import(workerModule);
test("cloud creation is owner-only, atomic, retryable, and machine file commits cannot register projects", async () => {
  const db = new Database(":memory:");
  let failWrites = false;
  const sql = { transactionSync: <T>(fn: () => T): T => db.transaction(fn)(), exec(q: string, ...args: any[]) {
    if (failWrites && q.startsWith("INSERT INTO files") && String(args[0]).endsWith("/memory.md")) throw Error("Simulated disk full");
    if (!args.length && q.trim().replace(/;\s*$/, "").includes(";")) { db.exec(q); return { toArray: () => [] }; }
    const rows = db.query(q).all(...args.map((v) => v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    return { toArray: () => rows };
  } };
  initFilesSchema(sql);
  const { readFile } = await import("../cloud/src/mcp");
  const st: any = { read: (p: string) => readFile(sql, p), list: (dir: string) => sql.exec("SELECT path FROM files WHERE deleted = 0 AND path >= ? AND path < ?", dir, dir.slice(0, -1) + "0").toArray().map((r: any) => readFile(sql, r.path)) };
  let owner = true, pushes = 0;
  const host: any = { sql, credential: () => "test", who: async () => owner ? { scope: "owner" } : "machine", mcp: { store: () => st }, level: () => "normal", pushStatus: () => { pushes++; } };
  const request = (path: string, body?: unknown) => OnlyOne.prototype.handle.call(host, new Request(`https://test${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }));
  try {
    owner = false;
    expect((await request("/api/projects", input())).status).toBe(403);
    expect((await request("/api/files/commit", { changes: [{ path: `projects/${aid}/project.md`, base_version: 0, content: "" }] })).status).toBe(403);
    owner = true;
    failWrites = true;
    await expect(request("/api/projects", input())).rejects.toThrow("Simulated disk full");
    expect(sql.exec("SELECT path FROM files").toArray()).toHaveLength(0);
    failWrites = false;
    expect((await request("/api/projects", input())).status).toBe(200);
    expect((await request("/api/projects", input())).status).toBe(200);
    expect(listProjects(st)).toHaveLength(1); expect(pushes).toBe(1);
    expect(sql.exec("SELECT path FROM files").toArray()).toHaveLength(3);
  } finally { db.close(); }
});
