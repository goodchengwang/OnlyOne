// Requirement-level worktrees: a task that is likely to conflict, run long, or share a repo with another running
// task gets its own branch and checkout under ~/.onlyone/work. Several requirements on one repo then progress side
// by side, and the owner decides afterwards whether to keep working there or open a PR to the base branch.
// Everything here is local git; it adds no Worker requests or rows (see AGENTS.md, Cloudflare budget).
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HOME_DIR, L, type Cfg } from "./core";

export type GitRepo = { root: string; branch: string; base: string };
export type Worktree = { path: string; branch: string; base: string; repo: string };

function git(cwd: string, args: string[]) {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

/** A branch/task title as a readable slug; non-Latin titles become a short hash so the name stays stable. */
export function slugTitle(title: string, max = 40): string {
  const s = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s;
}

/** The checkout's repository: its root (worktrees share the main repo's root), current branch and base branch. */
export function gitRepo(repo?: string): GitRepo | null {
  if (!repo) return null;
  const dir = resolve(repo.replace(/^~/, homedir()));
  if (!existsSync(dir)) return null;
  // --git-common-dir is the main repo's .git even from inside a linked worktree, so two checkouts of one repo compare equal
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = common.ok && common.out ? common.out.replace(/\/\.git\/?$/, "") : git(dir, ["rev-parse", "--show-toplevel"]).out;
  if (!top || !existsSync(top)) return null;
  const root = (() => { try { return realpathSync(top); } catch { return top; } })();
  const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = current.ok ? current.out : "";
  const head = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const remoteBase = head.ok ? head.out.replace(/^origin\//, "") : "";
  const has = (b: string) => !!b && git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok;
  const base = has(remoteBase) ? remoteBase : has("main") ? "main" : has("master") ? "master" : branch;
  return { root, branch, base };
}

/** Where a task's checkout lives: ~/.onlyone/work/<repo>-<task id>, next to the fleet's other scratch space. */
export function worktreePath(repoRoot: string, taskId: string): string {
  const name = basename(repoRoot).replace(/[^\w.-]+/g, "-");
  return join(HOME_DIR, "work", `${name}-${taskId}`);
}

/** Branch name for a task: agent/<task id>-<slug>. Matches what requeue notes and the Medic already look for. */
export function branchName(taskId: string, title: string): string {
  const slug = slugTitle(title);
  return `agent/${taskId}${slug ? `-${slug}` : ""}`;
}

/**
 * Reuse the task's checkout when it still exists, otherwise create it from the base branch.
 * A branch left over from a removed checkout is reattached instead of recreated.
 */
export function ensureWorktree(o: { repo: string; taskId: string; title: string; existing?: string; branch?: string; base?: string }): Worktree | { error: string } {
  const repo = gitRepo(o.repo);
  if (!repo) return { error: L(`${o.repo} is not a git repository`, `${o.repo} 不是 git 仓库`) };
  if (o.existing && existsSync(o.existing)) {
    const at = git(o.existing, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { path: o.existing, branch: o.branch || (at.ok ? at.out : repo.branch), base: o.base || repo.base, repo: repo.root };
  }
  const branch = o.branch || branchName(o.taskId, o.title);
  const path = worktreePath(repo.root, o.taskId);
  try { mkdirSync(dirname(path), { recursive: true }); } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
  const base = o.base || repo.base;
  const exists = git(repo.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const add = exists ? git(repo.root, ["worktree", "add", path, branch]) : git(repo.root, ["worktree", "add", "-b", branch, path, base]);
  if (!add.ok) return { error: (add.err || add.out || `git worktree add failed`).split("\n")[0] };
  return { path, branch, base, repo: repo.root };
}

export type WorkInfo = { sha?: string; diff?: string; commits: number; committed: boolean; error?: string; pushed?: string; push_error?: string };

/** A commit that exists on one machine only is not delivered work. Push the branch to origin; a repo with no
 *  remote is simply local (no error), a refused push is reported so the task page can show why. */
export function pushBranch(path: string, branch: string): { pushed?: string; push_error?: string } {
  if (!branch) return {};
  if (!git(path, ["remote", "get-url", "origin"]).ok) return {};
  const up = git(path, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (up.ok && up.out) {
    const ahead = git(path, ["rev-list", "--count", `${up.out}..${branch}`]);
    if (ahead.ok && (Number(ahead.out) || 0) === 0) return { pushed: up.out }; // origin already has it
  }
  const p = git(path, ["push", "-u", "origin", branch]);
  if (p.ok) return { pushed: `origin/${branch}` };
  return { push_error: (p.err || p.out).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) };
}

/** The commit a checkout is on right now, so a run's own commits can be told apart from what was already there. */
export function headSha(path: string): string {
  const h = git(path, ["rev-parse", "--short", "HEAD"]);
  return h.ok ? h.out : "";
}

/** Commit whatever the run left uncommitted, push the branch, then describe it against its base (files, +/−, commits). */
export function commitWorktree(path: string, o: { taskId: string; title: string; agent: string; base: string; push?: boolean }): WorkInfo {
  const stat = () => {
    const d = git(path, ["diff", "--shortstat", `${o.base}...HEAD`]);
    const line = (d.ok ? d.out : git(path, ["diff", "--shortstat", o.base]).out).replace(/\s+/g, " ").trim();
    const count = git(path, ["rev-list", "--count", `${o.base}..HEAD`]);
    return { diff: line ? line.replace(/ changed\b/, "").replace(/, /g, " · ") : undefined, commits: count.ok ? Number(count.out) || 0 : 0 };
  };
  const add = git(path, ["add", "-A"]);
  if (!add.ok) return { ...stat(), committed: false, error: add.err || add.out };
  const staged = git(path, ["diff", "--cached", "--name-only"]);
  let committed = false;
  if (staged.ok && staged.out) {
    const message = `${o.title}\n\nTask: ${o.taskId}\n\nAgent: ${o.agent}`;
    let c = git(path, ["commit", "-m", message]);
    // the daemon can run without a global git identity; a commit is better attributed to OnlyOne than lost
    if (!c.ok && /who you are|user\.email|user\.name|empty ident/i.test(`${c.err}\n${c.out}`))
      c = git(path, ["-c", "user.name=OnlyOne", "-c", "user.email=onlyone@localhost", "commit", "-m", message]);
    if (!c.ok) return { ...stat(), committed: false, error: (c.err || c.out).split("\n").slice(-2).join(" ") };
    committed = true;
  }
  const head = git(path, ["rev-parse", "--short", "HEAD"]);
  const on = git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const s = stat();
  // the owner wants the work on the remote, not only on this machine: every auto-commit is pushed
  const sent = o.push === false || s.commits === 0 ? {} : pushBranch(path, on.ok ? on.out : "");
  return { sha: head.ok ? head.out : undefined, ...s, committed, ...sent };
}

/** Should this task work on its own branch? Planner decisions win; otherwise a busy repo or a previous worktree does. */
export function decideWorktree(i: { meta: Record<string, string>; cfg: Cfg; busyRepo: boolean }): { use: boolean; why: string } {
  const { meta } = i;
  if (i.cfg.worktree?.enabled === false) return { use: false, why: "" };
  if (!meta.repo) return { use: false, why: "" };
  if (meta.worktree_mode === "worktree") return { use: true, why: meta.worktree_why || L("Planned for its own branch", "按计划使用独立分支") };
  // once a run has edited the main checkout, a later run stays there: moving mid-task would strand those edits
  if (meta.worktree_ran === "main") return { use: false, why: meta.worktree_why || "" };
  if (meta.worktree && existsSync(meta.worktree)) return { use: true, why: meta.worktree_why || L("This task already has its own worktree", "这个任务已经有自己的 worktree") };
  if (/^routine:/.test(meta.source ?? "")) return { use: false, why: "" };
  if (!gitRepo(meta.repo)) return { use: false, why: "" };
  // a repo another task is already editing wins over a plan that said "main": the two must not block each other
  if (i.busyRepo) return { use: true, why: L("Another task is working in this repo, so this one gets its own worktree", "同一仓库已有任务在跑，这个需求用独立 worktree，互不阻塞") };
  if (meta.worktree_mode === "main") return { use: false, why: meta.worktree_why || "" };
  return { use: false, why: "" };
}
