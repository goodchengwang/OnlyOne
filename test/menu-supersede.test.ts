// One live next-steps menu, and metrics that actually see the owner's overrides.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let core: typeof import("../src/core"), dec: typeof import("../src/decisions"), met: typeof import("../src/metrics");
beforeAll(async () => {
  process.env.ONLYONE_SYNC = "local";
  core = await import("../src/core");
  if (!core.DATA.startsWith(tmpdir())) throw new Error(`DATA=${core.DATA} is not a temp dir; refusing to touch real data`);
  for (const d of ["decisions/open", "decisions/closed", "tasks/blocked", "tasks/inbox", "tasks/done", "fleet", "journal", "memory", "logs/runs"])
    mkdirSync(`${core.DATA}/${d}`, { recursive: true });
  dec = await import("../src/decisions");
  met = await import("../src/metrics");
});
afterAll(() => {
  for (const d of ["decisions/open", "decisions/closed", "tasks/blocked", "tasks/inbox", "tasks/done", "fleet"])
    rmSync(core.P(d), { recursive: true, force: true });
});

const menuTask = (id: string) => core.writeDoc(core.P("tasks", "blocked", `${id}.md`), { id, agent: "chief-of-staff", kind: "menu", status: "needs_decision" }, "menu");
const menu = (taskId: string, question = "先做哪几项？") => dec.openDecision(
  { id: taskId, agent: "chief-of-staff", kind: "menu" },
  { status: "needs_decision", summary: "ctx", question, recommendation: "1", options: ["1. a", "2. b"] } as any, "h");
const openMenus = () => core.list(core.P("decisions", "open")).filter((p) => core.readDoc(p).meta.kind === "menu");

test("a fresh menu card replaces the older unanswered one instead of stacking", () => {
  menuTask("T-M001");
  const first = menu("T-M001");
  menuTask("T-M002");
  const second = menu("T-M002");
  // one live card, the old one closed with a pointer (content preserved, no lessons written)
  expect(openMenus().map((p) => core.readDoc(p).meta.id)).toEqual([second]);
  const old = core.readDoc(core.P("decisions", "closed", `${first}.md`)).meta;
  expect(old.superseded_by).toBe(second);
  expect(old.answered_by).toBe("superseded");
  expect(old.overrode_recommendation).toBeUndefined();
  // the old menu task ends instead of sitting blocked (the supervisor would otherwise resume it)
  expect(existsSync(core.P("tasks", "blocked", "T-M001.md"))).toBe(false);
  expect(core.readDoc(core.P("tasks", "done", "T-M001.md")).meta.superseded_by).toBe(second);
  expect(existsSync(core.P("tasks", "blocked", "T-M002.md"))).toBe(true);
});

test("ordinary decision cards are never superseded by a menu", () => {
  const work = dec.openDecision({ id: "T-W001", agent: "lead", kind: "worktree" },
    { status: "needs_decision", summary: "ctx", question: "提 PR 还是继续改？", recommendation: "A", options: ["A: PR", "B: 继续"] } as any, "h");
  menuTask("T-M003");
  menu("T-M003");
  expect(existsSync(core.P("decisions", "open", `${work}.md`))).toBe(true);
});

test("owner_overrode_recommendation counts the recorded override field, not the answered_by text", () => {
  core.writeDoc(core.P("decisions", "closed", "D-9001.md"),
    { id: "D-9001", agent: "chief-of-staff", kind: "menu", answered_by: "owner(chat)", answered: core.now(), recommendation: "1,2,3", answer: "都不要", overrode_recommendation: "yes" }, "x");
  core.writeDoc(core.P("decisions", "closed", "D-9002.md"),
    { id: "D-9002", agent: "lead", answered_by: "owner(chat)", answered: core.now(), recommendation: "A", answer: "A" }, "x");
  const m = met.computeMetrics(7);
  expect(m.decisions.owner_overrode_recommendation).toBe(1);
});
