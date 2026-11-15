import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DATA, P, list, readDoc, writeDoc } from "../src/core";
import { maybeProposeNext } from "../src/cli";

const dirs = ["tasks/inbox", "tasks/active", "tasks/waiting", "tasks/blocked", "decisions/open", "journal"];
const cfg = { idle: { after_minutes: 20 } };
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const state = () => ({ idle_since: ago(60), last_menu: ago(30) });
const menu = (id: string, minutes: number, kind = "menu") =>
  writeDoc(P("decisions/open", `${id}.md`), { id, kind, created: ago(minutes) }, "pending");
const tasks = () => [...list(P("tasks/inbox")), ...list(P("tasks/waiting")), ...list(P("tasks/blocked"))];

beforeEach(() => {
  if (!DATA.startsWith(tmpdir())) throw new Error(`Refusing to use live DATA: ${DATA}`);
  for (const dir of dirs) {
    rmSync(P(dir), { recursive: true, force: true });
    mkdirSync(P(dir), { recursive: true });
  }
});
afterAll(() => {
  for (const dir of dirs) rmSync(P(dir), { recursive: true, force: true });
});

test("a recent pending menu suppresses another even when an older menu sorts first", () => {
  menu("D-F0004", 480);
  menu("D-F0014", 179);
  maybeProposeNext(cfg, "test", state());
  expect(tasks()).toEqual([]);
});

test("an unanswered menu is never refreshed into a second card, however old it is", () => {
  // D-0009/D-0010/D-0011 (2026-11-15): the 180-minute "re-offer" rule raised the same question three times in four
  // hours. One live card is the offer; the supervisor expires it after HUMAN_WAIT_MAX_HOURS instead.
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    menu("D-F0004", 480);
    maybeProposeNext(cfg, "test", state());
    expect(tasks()).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("a menu task still on its way to a card also blocks a second menu", () => {
  // T-0012 was parked waiting on CI when T-0013 started; both ended in needs_decision 27 seconds apart.
  writeDoc(P("tasks/waiting/T-0002.md"), { id: "T-0002", agent: "chief-of-staff", kind: "menu", parked_at: ago(5) }, "menu");
  maybeProposeNext(cfg, "test", state());
  expect(list(P("tasks/inbox"))).toEqual([]);
  writeDoc(P("tasks/blocked/T-0003.md"), { id: "T-0003", agent: "chief-of-staff", kind: "menu", status: "needs_decision" }, "menu");
  maybeProposeNext(cfg, "test", state());
  expect(list(P("tasks/inbox"))).toEqual([]);
});

test("without pending menus the existing 15-minute generation guard still applies", () => {
  maybeProposeNext(cfg, "test", { idle_since: ago(60), last_menu: ago(14) });
  expect(tasks()).toEqual([]);
  maybeProposeNext(cfg, "test", state());
  expect(tasks()).toHaveLength(1);
});

test("active work resets the idle window and prevents a menu", () => {
  writeDoc(P("tasks/active/T-0001.md"), { id: "T-0001" }, "work");
  const st: Record<string, string> = state();
  maybeProposeNext(cfg, "test", st);
  expect(tasks()).toEqual([]);
  expect(st.idle_since).toBeUndefined();
});
