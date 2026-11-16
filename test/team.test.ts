import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { localStore, think, type Model } from "../src/brain";
import { P, agentName, loadConfig, readDoc, type Cfg } from "../src/core";
import { startServer } from "../src/server";
import { teamActs, members } from "../src/team";import { runRoutines } from "../src/cli";
import { avatarResponse, validSchedule } from "../cloud/src/team";
import { runTool, listRoutines, writeOp } from "../cloud/src/tools";
import { avatarOf, agentDisplayName } from "../app/avatars";

const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
const id = "test-content-editor", routine = "test-content-daily";
async function fixture(fn: (st: ReturnType<typeof localStore>, generated: string[]) => Promise<void>, generate?: () => Promise<Uint8Array>) {
  mkdirSync(P("journal"), { recursive: true });
  const path = P("settings.json"), previous = existsSync(path) ? readFileSync(path) : null;
  const generated: string[] = [];
  const st = localStore({ status: () => ({}), feed: () => [], acts: teamActs("test", {
    pull: async () => true, push: async () => true,
    generate: async (name) => { generated.push(name); return generate ? generate() : PNG; },
  }) });
  try { await fn(st, generated); } finally {
    rmSync(P("agents", id), { recursive: true, force: true });
    if (previous) writeFileSync(path, previous); else rmSync(path, { force: true });
  }
}
const member = { id, name: "小白", role: "负责内容选题，每轮报告三个选题。" };
const recurring = { name: routine, agent: id, every: "weekdays 09:00", prompt: "整理三个内容选题并向我汇报。", readonly: true };

test("natural-language member + routine writes run in order and confirm only after persistence", async () => {
  await fixture(async (st, generated) => {
    const turns = [
      JSON.stringify({ calls: [{ tool: "upsert_member", args: member }, { tool: "upsert_routine", args: recurring }], reply: "" }),
      JSON.stringify({ calls: [], reply: "已添加小白并设置工作日 9 点汇报选题，头像已生成。" }),
    ];
    const seen: string[] = [];
    const model: Model = { open: async () => ({ send: async (input) => { seen.push(input); return turns.shift()!; }, close() {} }) };
    const result = await think({ text: "添加小白负责内容选题，每个工作日早上9点整理三个选题并汇报。", channel: { slug: "a-project", name: "项目", goal: "代码开发" } }, st, model, () => {
      expect(existsSync(P("agents", id, "avatar.image"))).toBe(true);
      expect(loadConfig().routine.find((r: any) => r.name === routine)?.agent).toBe(id);
    });
    expect(result.calls.map((c) => [c.tool, c.ok])).toEqual([["upsert_member", true], ["upsert_routine", true]]);
    expect(generated).toEqual(["小白"]);
    expect(seen[1]).toContain('"avatar":"saved"');
    expect(agentName(id)).toBe("小白");
    expect(listRoutines(st).find((r) => r.name === routine)).toMatchObject({ every: "weekdays 09:00", agent: id, enabled: true });
    expect(loadConfig().routine.find((r: any) => r.name === routine)?.enabled).toBe(true);
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines[routine].enabled).toBe(true);
    const roster = members();
    expect(agentDisplayName(`${id}@mac`, true, roster)).toBe("小白");
    expect(agentDisplayName("小白@mac", false, roster)).toBe("小白");
    expect(avatarOf("小白@mac", roster)).toBe(roster.find((m) => m.id === id)!.avatar!);
  });
});

test("updates preserve the avatar and unrelated routine fields; uploaded avatars replace generated ones", async () => {
  await fixture(async (st, generated) => {
    expect((await runTool(st, "upsert_member", member)).ok).toBe(true);
    const original = readFileSync(P("agents", id, "avatar.image"));
    expect((await runTool(st, "upsert_member", { id, name: "选题助手" })).ok).toBe(true);
    expect(agentName(id)).toBe("选题助手");
    expect(readFileSync(P("agents", id, "profile.md"), "utf8")).toContain("# 选题助手 —");
    expect(readFileSync(P("agents", id, "avatar.image"))).toEqual(original);
    expect(generated).toHaveLength(1);
    const profile = P("agents", id, "profile.md");
    writeFileSync(profile, readFileSync(profile, "utf8") + "\n## Custom policy\nKeep this owner policy.\n");
    expect((await runTool(st, "upsert_member", { id, role: "整理并评估内容选题。" })).ok).toBe(true);
    const updated = readFileSync(profile, "utf8");
    expect(updated).toContain("Keep this owner policy.");
    expect(updated).toContain("整理并评估内容选题。");
    expect(updated).not.toContain(member.role);
    expect(generated).toHaveLength(1);
    await runTool(st, "upsert_member", { id, name: "选题$&员" });
    expect(agentName(id)).toBe("选题$&员");
    expect(readFileSync(profile, "utf8")).toContain("# 选题$&员 —");
    const dir = P("..", "attachments", "team-test");
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/owner.png`;
    writeFileSync(path, PNG);
    try {
      expect((await runTool(st, "upsert_member", { id, avatar_path: path })).ok).toBe(true);
      expect(generated).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect((await runTool(st, "upsert_member", { id, avatar_path: P("config.toml") })).ok).toBe(false);
    await runTool(st, "upsert_routine", recurring);
    await runTool(st, "upsert_routine", { name: routine, every: "daily 10:30", enabled: false });
    expect(loadConfig().routine.find((r: any) => r.name === routine)).toMatchObject({ every: "daily 10:30", enabled: false, agent: id, prompt: recurring.prompt, readonly: true });
    await runTool(st, "upsert_routine", { name: routine, every: "daily 11:00" });
    expect(loadConfig().routine.find((r: any) => r.name === routine)).toMatchObject({ every: "daily 11:00", enabled: false });
  });
});

test("bad ids, schedules and unknown agents cannot create invalid configuration", async () => {
  await fixture(async (st) => {
    for (const bad of ["../x", "owner", "onlyone", "__proto__"]) expect(typeof writeOp("upsert_member", { ...member, id: bad }, st)).toBe("string");
    expect(typeof writeOp("upsert_member", { ...member, name: "a\nb" }, st)).toBe("string");
    expect(typeof writeOp("upsert_routine", recurring, st)).toBe("string");
    await runTool(st, "upsert_member", { ...member, generate_avatar: false });
    for (const every of ["", "daily 29:00", "weekly FOO 09:00", "0m", "each day", "1d"]) {
      expect(validSchedule(every)).toBe(false);
      expect(typeof writeOp("upsert_routine", { ...recurring, every }, st)).toBe("string");
    }
    for (const every of ["15m", "hourly", "daily 00:00", "weekdays 23:59", "weekly MON 09:00"]) expect(validSchedule(every)).toBe(true);
    expect((await runTool(st, "upsert_routine", { ...recurring, name: "__proto__" })).ok).toBe(false);
    // deleting is validated against the routines that exist, including the built-in ones
    expect(typeof writeOp("delete_routine", { name: "no-such-routine" }, st)).toBe("string");
    expect(typeof writeOp("delete_routine", { name: "../x" }, st)).toBe("string");
    expect(writeOp("delete_routine", { name: "security-check" }, st)).toMatchObject({ tool: "delete_routine", name: "security-check" });
    expect(avatarResponse(new TextEncoder().encode("<svg/>")).status).toBe(415);
    expect(avatarResponse(null).status).toBe(404);
  });
});

test("Codex failures do not create a member or claim success", async () => {
  await fixture(async (st) => {
    const out = await runTool(st, "upsert_member", member);
    expect(out.ok).toBe(false);
    expect((out as any).error).toContain("image generation unavailable");
    expect(existsSync(P("agents", id, "profile.md"))).toBe(false);
  }, async () => { throw new Error("image generation unavailable"); });
});

test("a sync failure is reported and retry keeps the locally saved avatar", async () => {
  await fixture(async (st) => {
    let generated = 0;
    const offline = localStore({ status: () => ({}), feed: () => [], acts: teamActs("test", {
      pull: async () => false, push: async () => false, generate: async () => { generated++; return PNG; },
    }) });
    const out = await runTool(offline, "upsert_member", member);
    expect(out.ok).toBe(false);
    expect((out as any).error).toContain("cloud synchronization failed");
    expect(existsSync(P("agents", id, "avatar.image"))).toBe(true);
    expect((await runTool(st, "upsert_member", member)).ok).toBe(true);
    expect(generated).toBe(1);
  });
});

test("management on the last model round still confirms the saved member and avatar", async () => {
  await fixture(async (st, generated) => {
    let i = 0;
    const model: Model = { open: async () => ({ send: async () => JSON.stringify({
      calls: [{ tool: "upsert_member", args: { ...member, name: `选题员${++i}` } }], reply: "unverified success",
    }), close() {} }) };
    const posts: string[] = [];
    const out = await think({ text: "添加选题员" }, st, model, (reply) => posts.push(reply));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("选题员4");
    expect(posts[0]).not.toContain("unverified success");
    expect(out.ms.first_reply).toBeDefined();
    expect(generated).toHaveLength(1);
  });
});

test("a saved routine becomes a scheduler task for the new member and respects disabling", async () => {
  await fixture(async (st) => {
    await runTool(st, "upsert_member", { ...member, generate_avatar: false });
    await runTool(st, "upsert_routine", { ...recurring, every: "15m" });
    const cfg = loadConfig();
    cfg.routine = cfg.routine.filter((r: any) => r.name === routine);
    const statePath = P("logs", "routine-state.json"), saved = existsSync(statePath) ? readFileSync(statePath) : null;
    try {
      runRoutines(cfg, "test", true);
      const { readdirSync } = await import("node:fs");
      const found = readdirSync(P("tasks", "inbox")).map((f) => P("tasks", "inbox", f)).filter((f) => readDoc(f).meta.source === `routine:${routine}`);
      expect(found).toHaveLength(1);
      expect(readDoc(found[0]).meta.agent).toBe(id);
      expect(readDoc(found[0]).body).toContain(recurring.prompt);
      await runTool(st, "upsert_routine", { name: routine, enabled: false });
      const disabled = loadConfig();
      disabled.routine = disabled.routine.filter((r: any) => r.name === routine);
      runRoutines(disabled, "test", true);
      expect(readdirSync(P("tasks", "inbox")).filter((f) => readDoc(P("tasks", "inbox", f)).meta.source === `routine:${routine}`)).toHaveLength(1);
      found.forEach((f) => rmSync(f));
    } finally {
      if (saved) writeFileSync(statePath, saved); else rmSync(statePath, { force: true });
    }
  });
});

test("delete_routine removes a routine for good, reports a run still in flight, and saving it again restores it", async () => {
  await fixture(async (st) => {
    await runTool(st, "upsert_member", { ...member, generate_avatar: false });
    await runTool(st, "upsert_routine", { ...recurring, every: "15m" });
    const runId = "T-9801";
    mkdirSync(P("tasks", "inbox"), { recursive: true });
    writeFileSync(P("tasks", "inbox", `${runId}.md`), `---\nid: ${runId}\ntitle: ${routine}\nagent: ${id}\nsource: routine:${routine}\n---\nRun.\n`);
    try {
      const out = await runTool(st, "delete_routine", { name: routine });
      expect(out.ok).toBe(true);
      expect((out as any).data).toMatchObject({ ok: true, routine, in_flight: runId });
      expect(listRoutines(st).some((r) => r.name === routine)).toBe(false);
      expect(loadConfig().routine.some((r: any) => r.name === routine)).toBe(false); // the scheduler only runs loadConfig's routines
      expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines[routine].deleted).toBe(true);
      // deleting the same routine again is a no-op, not an error
      expect((await runTool(st, "delete_routine", { name: routine })).ok).toBe(true);
      // saving it again brings it back with its old values, without asking for every field again
      expect((await runTool(st, "upsert_routine", { name: routine, enabled: true })).ok).toBe(true);
      expect(listRoutines(st).find((r) => r.name === routine)).toMatchObject({ agent: id, every: "15m", enabled: true });
      expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines[routine].deleted).toBeUndefined();
    } finally { rmSync(P("tasks", "inbox", `${runId}.md`), { force: true }); }
  });
});

test("deleting a code-defined routine tombstones it so config.toml and the built-in list cannot bring it back", async () => {
  await fixture(async (st) => {
    expect(listRoutines(st).map((r) => r.name)).toContain("security-check");
    expect(loadConfig().routine.some((r: any) => r.name === "security-check")).toBe(true);
    expect((await runTool(st, "delete_routine", { name: "security-check" })).ok).toBe(true);
    expect(listRoutines(st).some((r) => r.name === "security-check")).toBe(false);
    expect(loadConfig().routine.some((r: any) => r.name === "security-check")).toBe(false);
    // the source still defines it, so the tombstone is what keeps it off
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines["security-check"]).toMatchObject({ deleted: true });
  });
});

test("the settings page deletes a routine through the same tombstone the chat uses", async () => {
  await fixture(async (st) => {
    await runTool(st, "upsert_routine", { ...recurring, every: "15m" });
    const server = startServer({ server: { host: "127.0.0.1", port: 0, token: "test" } } as Cfg, async () => {})!;
    const del = (body: object) => fetch(`http://127.0.0.1:${server.port}/api/routines/delete`, {
      method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      expect((await del({})).status).toBe(400);
      const out: any = await (await del({ name: routine })).json();
      expect(out).toMatchObject({ ok: true, routine });
      expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines[routine].deleted).toBe(true);
      expect(loadConfig().routine.some((r: any) => r.name === routine)).toBe(false);
      // pressing delete twice is a no-op, not an error
      expect((await del({ name: routine })).status).toBe(200);
    } finally { server.stop(true); }
  });
});

test("the chat brain deletes a routine before replying and says the run in flight still reports", async () => {
  await fixture(async (st) => {
    await runTool(st, "upsert_member", { ...member, generate_avatar: false });
    await runTool(st, "upsert_routine", { ...recurring, every: "15m" });
    const runId = "T-9802";
    mkdirSync(P("tasks", "inbox"), { recursive: true });
    writeFileSync(P("tasks", "inbox", `${runId}.md`), `---\nid: ${runId}\ntitle: ${routine}\nagent: ${id}\nsource: routine:${routine}\n---\nRun.\n`);
    const posts: string[] = [];
    // the model only ever asks for the delete: the last round must confirm it from the real result, never from the model's own wording
    const model: Model = { open: async () => ({ send: async () => JSON.stringify({ calls: [{ tool: "delete_routine", args: { name: routine } }], reply: "unverified success" }), close() {} }) };
    try {
      const out = await think({ text: "把内容选题那个例行任务删掉" }, st, model, (reply) => posts.push(reply));
      expect(out.calls.length).toBeGreaterThan(0);
      expect(out.calls.every((c) => c.tool === "delete_routine" && c.ok)).toBe(true);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain(`已删除例行任务${routine}`);
      expect(posts[0]).toContain(runId);
      expect(posts[0]).not.toContain("unverified success");
      expect(listRoutines(st).some((r) => r.name === routine)).toBe(false);
    } finally { rmSync(P("tasks", "inbox", `${runId}.md`), { force: true }); }
  });
});
