// Cleaning up branches and worktrees must skip tasks that are still alive (T-0042): a pr-triage sweep deleted
// T-0036's worktree while that task was running in it, and the uncommitted work was lost. The list the executor puts
// in front of every run is built from the task folders, so these tests pin both the data and the wording of the rule.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDoc } from "../src/core";
import { liveWorktrees } from "../src/worktree";
import { liveWorktreesNote } from "../src/runner";

let tasks = "";

const task = (folder: string, id: string, extra: Record<string, string> = {}) =>
  writeDoc(join(tasks, folder, `${id}.md`), { id, title: `${id} title`, ...extra }, "body\n");

beforeAll(() => {
  tasks = mkdtempSync(join(tmpdir(), "onlyone-live-"));
  // a task running right now, in its own checkout
  task("active", "T-0101", { claimed_by: "hostA", branch: "agent/T-0101-fix", worktree: "/tmp/onlyone/work/app-T-0101" });
  // everything else that is still unfinished: queued, waiting on CI, blocked on a card, on a plain branch
  task("inbox", "T-0102", { branch: "agent/T-0102-next" });
  task("waiting", "T-0103", { branch: "agent/T-0103-wait", worktree: "/tmp/onlyone/work/app-T-0103" });
  task("blocked", "T-0104", { branch: "agent/T-0104-card" });
  // finished work: this one may be cleaned up
  task("done", "T-0100", { branch: "agent/T-0100-landed", worktree: "/tmp/onlyone/work/app-T-0100" });
  task("failed", "T-0099", { branch: "agent/T-0099-dead" });
});
afterAll(() => rmSync(tasks, { recursive: true, force: true }));

test("every unfinished task is listed with the branch and checkout it holds", () => {
  const live = liveWorktrees(tasks);
  expect(live.map((t) => [t.id, t.state])).toEqual([
    ["T-0101", "running"], ["T-0102", "queued"], ["T-0103", "waiting"], ["T-0104", "blocked"],
  ]);
  const running = live[0];
  expect(running.branch).toBe("agent/T-0101-fix");
  expect(running.worktree).toBe("/tmp/onlyone/work/app-T-0101");
  expect(running.host).toBe("hostA");
});

test("finished tasks are not live, so their branches and checkouts may be cleaned up", () => {
  const ids = liveWorktrees(tasks).map((t) => t.id);
  expect(ids).not.toContain("T-0100"); // done
  expect(ids).not.toContain("T-0099"); // failed
});

test("a run does not list itself", () => {
  expect(liveWorktrees(tasks, "T-0101").map((t) => t.id)).toEqual(["T-0102", "T-0103", "T-0104"]);
});

test("the prompt note names the live branches and forbids removing them", () => {
  const note = liveWorktreesNote(tasks, "T-0042");
  expect(note).toContain("# Live tasks — never clean these up");
  expect(note).toContain("git worktree remove");
  expect(note).toContain("tasks/done or tasks/failed");
  expect(note).toContain("- T-0101 (running) · branch `agent/T-0101-fix` · checkout `/tmp/onlyone/work/app-T-0101` · on hostA — T-0101 title");
  expect(note).toContain("- T-0103 (waiting)");
  expect(note).not.toContain("T-0100"); // the landed one is not protected
});

test("with nothing alive the note still states the rule", () => {
  const empty = mkdtempSync(join(tmpdir(), "onlyone-live-empty-"));
  try {
    const note = liveWorktreesNote(empty);
    expect(note).toContain("# Live tasks — never clean these up");
    expect(note.includes("no live task holds a branch or checkout") || note.includes("当前没有活着的任务")).toBe(true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
