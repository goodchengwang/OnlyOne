// Automatic cleanup of finished tasks' branches and checkouts (D-0041 A): a done/failed task whose work is fully in
// the base branch should not need a pr-triage run to notice it. These tests pin every hard condition — a live task, an
// uncommitted edit, an unmerged branch, or a path outside ~/.onlyone/work must never be deleted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDoc } from "../src/core";
import { cleanupMergedWorktrees, fullyInBase } from "../src/worktree";

let tmp = "";
let repo = "";
let tasks = "";
let work = "";

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
const commit = (cwd: string, msg: string) => git(cwd, "commit", "-q", "-m", msg);
const branchExists = (b: string) => Bun.spawnSync(["git", "-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${b}`]).exitCode === 0;

/** A branch with one new file, checked out in its own worktree under the fleet's scratch space. */
function branchWithWorktree(branch: string, path: string, file: string) {
  git(repo, "worktree", "add", path, "-b", branch, "main");
  writeFileSync(join(path, file), `${file}\n`);
  git(path, "add", "-A");
  commit(path, file);
}

const task = (folder: string, id: string, extra: Record<string, string>) =>
  writeDoc(join(tasks, folder, `${id}.md`), { id, title: `${id} title`, repo, base_branch: "main", ...extra }, "body\n");

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "onlyone-cleanup-"));
  repo = join(tmp, "repo");
  tasks = join(tmp, "tasks");
  work = join(tmp, "work");
  mkdirSync(repo, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  // a CI runner has no git identity; set it in the repo so every commit and merge works there too
  git(repo, "config", "user.name", "OnlyOne");
  git(repo, "config", "user.email", "onlyone@localhost");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  commit(repo, "init");

  // landed by squash: main gets the file, the branch keeps its own commit (ancestor test alone would say "unmerged")
  const squash = join(work, "repo-T-1001");
  branchWithWorktree("agent/T-1001-landed", squash, "b.txt");
  writeFileSync(join(repo, "b.txt"), "b.txt\n");
  git(repo, "add", "-A");
  commit(repo, "squash T-1001");
  task("done", "T-1001", { branch: "agent/T-1001-landed", worktree: squash });

  // landed by a plain merge
  const merged = join(work, "repo-T-1002");
  branchWithWorktree("agent/T-1002-merged", merged, "c.txt");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge T-1002", "agent/T-1002-merged");
  task("done", "T-1002", { branch: "agent/T-1002-merged", worktree: merged });

  // finished, but its branch is not in main yet: never delete
  const open = join(work, "repo-T-1003");
  branchWithWorktree("agent/T-1003-open", open, "d.txt");
  task("done", "T-1003", { branch: "agent/T-1003-open", worktree: open });

  // finished, but a live task (a follow-up that continues the same branch) still holds it: off limits
  const live = join(work, "repo-T-1004");
  branchWithWorktree("agent/T-1004-live", live, "e.txt");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge T-1004", "agent/T-1004-live");
  task("done", "T-1004", { branch: "agent/T-1004-live", worktree: live });
  writeDoc(join(tasks, "active", "T-1009.md"), { id: "T-1009", title: "T-1009 title", repo, branch: "agent/T-1004-live", worktree: live, follows: "T-1004" }, "body\n");

  // landed, but the checkout holds uncommitted work
  const dirty = join(work, "repo-T-1005");
  branchWithWorktree("agent/T-1005-dirty", dirty, "f.txt");
  writeFileSync(join(repo, "f.txt"), "f.txt\n");
  git(repo, "add", "-A");
  commit(repo, "squash T-1005");
  writeFileSync(join(dirty, "unsaved.txt"), "not committed\n");
  task("done", "T-1005", { branch: "agent/T-1005-dirty", worktree: dirty });

  // a checkout outside the fleet's scratch space is never deleted
  const outside = join(tmp, "outside", "repo-T-1006");
  mkdirSync(join(tmp, "outside"), { recursive: true });
  branchWithWorktree("agent/T-1006-outside", outside, "g.txt");
  task("failed", "T-1006", { branch: "agent/T-1006-outside", worktree: outside });

  // the checkout was already removed by hand; the merged local branch is all that is left (today's common state)
  const gone = join(work, "repo-T-1007");
  branchWithWorktree("agent/T-1007-gone", gone, "h.txt");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge T-1007", "agent/T-1007-gone");
  git(repo, "worktree", "remove", gone);
  task("done", "T-1007", { branch: "agent/T-1007-gone", worktree: gone });
});
afterAll(() => {
  try { if (existsSync(repo)) git(repo, "worktree", "prune"); } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

test("fullyInBase sees squash merges, plain merges and open branches", () => {
  expect(fullyInBase(repo, "agent/T-1001-landed", "main")).toBe(true); // squash
  expect(fullyInBase(repo, "agent/T-1002-merged", "main")).toBe(true); // merge
  expect(fullyInBase(repo, "agent/T-1003-open", "main")).toBe(false);
  expect(fullyInBase(repo, "main", "main")).toBe(false);
});

test("a dry run reports what it would delete and deletes nothing", () => {
  const r = cleanupMergedWorktrees({ tasksDir: tasks, workRoot: work, dry: true });
  expect(r.removed.map((x) => x.id).sort()).toEqual(["T-1001", "T-1002", "T-1007"]);
  expect(existsSync(join(work, "repo-T-1001"))).toBe(true);
  expect(branchExists("agent/T-1001-landed")).toBe(true);
});

test("merged finished tasks lose their checkout and local branch", () => {
  const r = cleanupMergedWorktrees({ tasksDir: tasks, workRoot: work });
  expect(r.removed.map((x) => x.id).sort()).toEqual(["T-1001", "T-1002", "T-1007"]);
  const byId = Object.fromEntries(r.removed.map((x) => [x.id, x]));
  expect(byId["T-1001"].branchRemoved && byId["T-1001"].worktreeRemoved).toBe(true);
  expect(byId["T-1002"].branchRemoved && byId["T-1002"].worktreeRemoved).toBe(true);
  expect(byId["T-1007"].branchRemoved && byId["T-1007"].worktreeRemoved).toBe(false); // checkout was already gone
  expect(existsSync(join(work, "repo-T-1001"))).toBe(false);
  expect(branchExists("agent/T-1001-landed")).toBe(false);
  expect(branchExists("agent/T-1002-merged")).toBe(false);
  expect(branchExists("agent/T-1007-gone")).toBe(false);
  expect(existsSync(join(work, "repo-T-1002"))).toBe(false);
});

test("unmerged, live, dirty and out-of-scope checkouts are kept with a reason", () => {
  const r = cleanupMergedWorktrees({ tasksDir: tasks, workRoot: work });
  expect(r.removed).toEqual([]);
  const why = Object.fromEntries(r.kept.map((k) => [k.id, k.why]));
  expect(why["T-1003"]).toContain("not fully in main");
  expect(why["T-1004"]).toContain("live task");
  expect(why["T-1005"]).toContain("uncommitted");
  expect(why["T-1006"]).toContain("outside");
  expect(existsSync(join(work, "repo-T-1003"))).toBe(true);
  expect(existsSync(join(work, "repo-T-1004"))).toBe(true);
  expect(existsSync(join(work, "repo-T-1005"))).toBe(true);
  expect(branchExists("agent/T-1003-open")).toBe(true);
  expect(branchExists("agent/T-1004-live")).toBe(true);
});

test("a second sweep is a no-op", () => {
  const r = cleanupMergedWorktrees({ tasksDir: tasks, workRoot: work });
  expect(r.removed).toEqual([]);
});

/** Scratch dirs the fleet leaves in ~/.onlyone/work: downloads and archives, not git worktrees. */
const scratch = (name: string, ageMs = 0) => {
  const p = join(work, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "payload.bin"), "x\n");
  if (ageMs) utimesSync(p, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return p;
};
const OLD_MS = 30 * 86_400_000;

test("old scratch dirs of finished tasks are removed, everything unattributable stays", () => {
  const old = scratch("T-1001-release-v1", OLD_MS); // finished task, old
  const fresh = scratch("T-1001-shots"); // finished task, but just now
  const liveTask = scratch("T-1009-shots", OLD_MS); // T-1009 is live: its id wins over any finished T-1009
  const loose = scratch("v015-verify", OLD_MS); // no task owns this name
  const checkout = scratch("T-1002-clone", OLD_MS); // has .git: a checkout, not scratch
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const link = join(work, "T-1001-link");
  symlinkSync(fresh, link); // utimes would follow the link and age its target

  const dry = cleanupMergedWorktrees({ tasksDir: tasks, workRoot: work, dry: true });
  expect(dry.scratchRemoved.map((x) => x.path)).toEqual([old]);
  expect(existsSync(old)).toBe(true);

  const r = cleanupMergedWorktrees({ tasksDir: tasks, workRoot: work });
  expect(r.scratchRemoved.map((x) => x.id)).toEqual(["T-1001"]);
  expect(existsSync(old)).toBe(false);
  for (const keep of [fresh, liveTask, loose, checkout, link]) expect(existsSync(keep)).toBe(true);
});

