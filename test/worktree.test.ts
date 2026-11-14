// Requirement-level worktrees: the decision, the checkout, and the commit the executor makes before the owner
// chooses between keeping the branch and opening a PR.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HOME_DIR } from "../src/core";
import { branchName, commitWorktree, decideWorktree, ensureWorktree, gitRepo, slugTitle, worktreePath } from "../src/worktree";

let repo = "";
const git = (args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString() || p.stdout.toString());
  return p.stdout.toString().trim();
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "onlyone-wt-"));
  git(["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "-A"]);
  git(["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-m", "init"]);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("gitRepo reads the root, current branch and base branch", () => {
  const r = gitRepo(repo)!;
  expect(r.root).toBe(realpathSync(repo));
  expect(r.branch).toBe("main");
  expect(r.base).toBe("main");
  expect(gitRepo(join(repo, "nope"))).toBeNull();
  expect(gitRepo(undefined)).toBeNull();
});

test("branch and checkout names are stable and readable", () => {
  expect(slugTitle("Add worktree support!")).toBe("add-worktree-support");
  expect(slugTitle("需求级 worktree")).toBe("worktree");
  expect(branchName("T-0101", "Add worktree support!")).toBe("agent/T-0101-add-worktree-support");
  expect(branchName("T-0102", "需求级 worktree")).toBe("agent/T-0102-worktree");
  const at = worktreePath(realpathSync(repo), "t-0101");
  expect(at).toBe(join(HOME_DIR, "work", `${basename(realpathSync(repo))}-t-0101`));
});

test("ensureWorktree creates a branch from the base and reuses it afterwards", () => {
  const wt = ensureWorktree({ repo, taskId: "T-0101", title: "Add worktree support" });
  expect("error" in wt).toBe(false);
  if ("error" in wt) return;
  expect(wt.branch).toBe("agent/T-0101-add-worktree-support");
  expect(wt.base).toBe("main");
  expect(existsSync(wt.path)).toBe(true);
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main"); // the main checkout is untouched
  // a second run of the same task works in the same checkout
  const again = ensureWorktree({ repo, taskId: "T-0101", title: "Add worktree support", existing: wt.path, branch: wt.branch, base: wt.base });
  expect("error" in again).toBe(false);
  if (!("error" in again)) expect(again.path).toBe(wt.path);
});

test("commitWorktree commits the run's work against its base and describes it", () => {
  const wt = ensureWorktree({ repo, taskId: "T-0102", title: "Fix the header" });
  if ("error" in wt) throw new Error(wt.error);
  writeFileSync(join(wt.path, "header.txt"), "fixed\n");
  const first = commitWorktree(wt.path, { taskId: "T-0102", title: "Fix the header", agent: "lead", base: wt.base });
  expect(first.committed).toBe(true);
  expect(first.commits).toBe(1);
  expect(first.sha).toBeTruthy();
  expect(first.diff).toContain("1 file");
  expect(first.error).toBeUndefined();
  // nothing left to commit: same head, no new commit, and the card is not raised again
  const second = commitWorktree(wt.path, { taskId: "T-0102", title: "Fix the header", agent: "lead", base: wt.base });
  expect(second.committed).toBe(false);
  expect(second.sha).toBe(first.sha!);
  expect(second.commits).toBe(1);
  // the commit carries the agent trailer
  expect(git(["log", "-1", "--format=%B", wt.branch])).toContain("Agent: lead");
});

test("decideWorktree: planner wins, a busy repo gets a worktree, routines and small tasks stay on main", () => {
  const cfg = {} as any;
  expect(decideWorktree({ meta: { repo }, cfg, busyRepo: false })).toEqual({ use: false, why: "" });
  expect(decideWorktree({ meta: { repo, worktree_mode: "worktree", worktree_why: "multi-file feature" }, cfg, busyRepo: false }))
    .toEqual({ use: true, why: "multi-file feature" });
  expect(decideWorktree({ meta: { repo, worktree_mode: "main", worktree_why: "one-line fix" }, cfg, busyRepo: false }))
    .toEqual({ use: false, why: "one-line fix" });
  // a repo another task is already editing wins over a plan that said main ...
  expect(decideWorktree({ meta: { repo, worktree_mode: "main", worktree_why: "one-line fix" }, cfg, busyRepo: true }).use).toBe(true);
  expect(decideWorktree({ meta: { repo }, cfg, busyRepo: true }).use).toBe(true);
  // ... but a task that already edited the main checkout never moves (its edits would be stranded)
  expect(decideWorktree({ meta: { repo, worktree_ran: "main" }, cfg, busyRepo: true }).use).toBe(false);
  expect(decideWorktree({ meta: { repo, source: "routine:pr-review" }, cfg, busyRepo: true }).use).toBe(false);
  expect(decideWorktree({ meta: {}, cfg, busyRepo: true }).use).toBe(false);
  expect(decideWorktree({ meta: { repo, worktree_mode: "worktree" }, cfg: { worktree: { enabled: false } }, busyRepo: false }).use).toBe(false);
  // a task that already has a live checkout keeps it
  const live = ensureWorktree({ repo, taskId: "T-0103", title: "Keep me" });
  if ("error" in live) throw new Error(live.error);
  expect(decideWorktree({ meta: { repo, worktree: live.path }, cfg, busyRepo: false }).use).toBe(true);
});
