// Requirement-level worktrees: a task that is likely to conflict, run long, or share a repo with another running
// task gets its own branch and checkout under ~/.onlyone/work. Several requirements on one repo then progress side
// by side, and the owner decides afterwards whether to keep working there or open a PR to the base branch.
// Everything here is local git; it adds no Worker requests or rows (see AGENTS.md, Cloudflare budget).
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { HOME_DIR, L, P, list, readDoc, type Cfg } from "./core";
import { openPr, prForBranch } from "./github";

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

export type BranchPr = { pr: string; created: boolean } | { ask: string } | { local: true };

/** A finished worktree task left a fresh commit on its branch. Turning that into a PR is already "do without
 *  asking", and on 2026-11-16 the owner answered "open a PR" to every one of the 15 such cards (D-0013…D-0038),
 *  each of which held the task for minutes to hours — so the branch becomes a PR here and a card is only raised
 *  for what the machine could not do itself (no push, no PR). The gh calls are injected so this stays testable. */
export function prForWorktree(
  tree: { repo: string; branch: string; base: string },
  o: { title: string; body: string; agent: string; pushed?: string; pushError?: string },
  gh: { find: typeof prForBranch; create: typeof openPr } = { find: prForBranch, create: openPr },
): BranchPr {
  // a refused push is the owner's to unblock; no push at all (no remote, or push disabled) is simply local work
  if (!o.pushed) return o.pushError ? { ask: L(`分支推送失败：${o.pushError}`, `the branch was not pushed: ${o.pushError}`) } : { local: true };
  const existing = gh.find(tree.repo, tree.branch);
  if (existing && existing.state !== "CLOSED") return { pr: existing.url, created: false }; // a closed PR was refused, not delivered
  const made = gh.create({ repo: tree.repo, branch: tree.branch, base: tree.base, title: o.title, body: o.body, agent: o.agent });
  return made.url ? { pr: made.url, created: true } : { ask: made.error ?? "gh pr create failed" };
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

/**
 * Tasks that are still alive — queued, running, waiting on a condition, or blocked on a card — with the branch and
 * checkout they hold. Their work is not finished: a checkout can hold uncommitted edits and is somebody's working
 * directory right now, so no run may clean these up, even when the diff looks fully merged (T-0042).
 */
export type LiveWorktree = { id: string; title: string; state: "running" | "queued" | "waiting" | "blocked"; branch?: string; worktree?: string; host?: string };

const LIVE_FOLDERS = [["active", "running"], ["inbox", "queued"], ["waiting", "waiting"], ["blocked", "blocked"]] as const;

export function liveWorktrees(tasksDir = P("tasks"), excludeId?: string): LiveWorktree[] {
  const out: LiveWorktree[] = [];
  for (const [folder, state] of LIVE_FOLDERS)
    for (const path of list(join(tasksDir, folder), /^T-.*\.md$/)) {
      const { meta } = readDoc(path);
      if (!meta.id || meta.id === excludeId) continue;
      out.push({ id: meta.id, title: meta.title ?? "", state,
        ...(meta.branch ? { branch: meta.branch } : {}), ...(meta.worktree ? { worktree: meta.worktree } : {}),
        ...((meta.claimed_by || meta.host) && meta.host !== "any" ? { host: meta.claimed_by || meta.host } : {}) });
    }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- merged-work cleanup (D-0041 A)
// The owner asked for this on 2026-11-17: a finished task's branch and checkout should not need a pr-triage run to
// notice them. The rules are deliberately narrower than "looks merged" — see the comment on cleanupMergedWorktrees.

/** Is everything the branch changed already in `base`? A squash merge leaves a different commit, so an ancestor test
 *  alone would keep those branches forever; compare instead the files the branch touched against the base's version. */
export function fullyInBase(repo: string, branch: string, base: string): boolean {
  if (!branch || !base || branch === base) return false;
  if (git(repo, ["merge-base", "--is-ancestor", branch, base]).ok) return true; // plain merge, or built straight on base
  const mb = git(repo, ["merge-base", base, branch]);
  if (!mb.ok || !mb.out) return false;
  const changed = git(repo, ["diff", "--name-only", "-z", mb.out, branch]);
  if (!changed.ok) return false;
  const files = changed.out.split("\0").filter(Boolean);
  if (!files.length) return true; // the branch never changed anything
  // every file the branch touched must now hold the same content in the base branch (covers squashed merges)
  return git(repo, ["diff", "--quiet", branch, base, "--", ...files]).ok;
}

export type CleanedWorktree = { id: string; branch?: string; worktree?: string; branchRemoved: boolean; worktreeRemoved: boolean };
export type CleanupResult = {
  removed: CleanedWorktree[];
  kept: { id: string; why: string }[];
  /** Plain scratch directories of finished tasks (release downloads, extracted archives) that were removed. */
  scratchRemoved: { id: string; path: string }[];
};

/**
 * Remove the branch and checkout of tasks that are finished (done/failed) AND whose work is fully in their base branch.
 * Hard conditions, all of which must hold — anything else is reported in `kept`, never deleted:
 *   - the task is in tasks/done or tasks/failed (a live task's checkout is never touched: T-0036 lost work to a sweep),
 *   - no queued/running/waiting/blocked task still holds that branch or checkout,
 *   - the checkout is inside ~/.onlyone/work (never delete anything elsewhere),
 *   - the checkout has no uncommitted changes,
 *   - the branch is fully in the base branch (squash merges included).
 *
 * It also removes plain scratch directories left by finished tasks (see the second half of the function).
 */
export function cleanupMergedWorktrees(
  o: { tasksDir?: string; workRoot?: string; only?: string[]; dry?: boolean; scratchDays?: number } = {},
): CleanupResult {
  const tasksDir = o.tasksDir ?? P("tasks");
  const workRoot = resolve((o.workRoot ?? join(HOME_DIR, "work")).replace(/^~/, homedir()));
  const inside = (p: string) => p === workRoot || p.startsWith(workRoot + sep);
  const live = liveWorktrees(tasksDir);
  const liveBranches = new Set(live.map((t) => t.branch).filter(Boolean));
  const liveTrees = new Set(live.map((t) => (t.worktree ? resolve(t.worktree.replace(/^~/, homedir())) : "")).filter(Boolean));
  const liveIds = live.map((t) => t.id);
  const res: CleanupResult = { removed: [], kept: [], scratchRemoved: [] };
  for (const folder of ["done", "failed"] as const)
    for (const file of list(join(tasksDir, folder), /^T-.*\.md$/)) {
      const { meta } = readDoc(file);
      const id = meta.id || basename(file, ".md");
      if (o.only && !o.only.includes(id)) continue;
      if (!meta.branch && !meta.worktree) continue;
      const treePath = meta.worktree ? resolve(meta.worktree.replace(/^~/, homedir())) : "";
      if (liveBranches.has(meta.branch) || (treePath && liveTrees.has(treePath))) { res.kept.push({ id, why: "a live task still holds it" }); continue; }
      if (treePath && !inside(treePath)) { res.kept.push({ id, why: `checkout ${meta.worktree} is outside ${workRoot}` }); continue; }
      const repo = gitRepo(meta.repo);
      if (!repo) { res.kept.push({ id, why: "repo not found" }); continue; }
      const base = meta.base_branch || repo.base;
      const branch = meta.branch && meta.branch !== repo.base ? meta.branch : "";
      const hasBranch = !!branch && git(repo.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
      const treeExists = !!treePath && existsSync(treePath);
      if (!hasBranch && !treeExists) continue; // nothing left to delete
      if (hasBranch && !fullyInBase(repo.root, branch, base)) { res.kept.push({ id, why: `branch ${branch} is not fully in ${base}` }); continue; }
      if (treeExists) {
        const dirty = git(treePath, ["status", "--porcelain"]);
        if (!dirty.ok || dirty.out) { res.kept.push({ id, why: "checkout has uncommitted changes" }); continue; }
      }
      const rec: CleanedWorktree = { id, ...(branch ? { branch } : {}), ...(treePath ? { worktree: treePath } : {}), branchRemoved: false, worktreeRemoved: false };
      if (o.dry) { res.removed.push(rec); continue; }
      if (treeExists) {
        const rm = git(repo.root, ["worktree", "remove", treePath]);
        if (!rm.ok) { res.kept.push({ id, why: `worktree remove failed: ${(rm.err || rm.out).split("\n")[0]}` }); continue; }
        rec.worktreeRemoved = true;
      }
      if (hasBranch) {
        const del = git(repo.root, ["branch", "-D", branch]);
        if (!del.ok) { res.kept.push({ id, why: `branch -D failed: ${(del.err || del.out).split("\n")[0]}` }); continue; }
        rec.branchRemoved = true;
      }
      res.removed.push(rec);
    }
  // Plain scratch directories (release downloads, extracted archives, screenshots) pile up in the same folder but are
  // not git worktrees, so the loop above never sees them: 1.3GB of them had to be swept by hand on 2026-11-17. They are
  // attributed to a task by name (`<task id>`, `<task id>-...`), which is how the fleet names them. Only removed when:
  //   - the name belongs to a task in tasks/done or tasks/failed (a live task's id is skipped even if it also finished one),
  //   - the entry is a plain directory, a symlink or a checkout (has .git) is left alone,
  //   - it is older than scratchDays (default 7) so a just-finished task's files stay readable for a while.
  const finished = new Map<string, string>();
  for (const folder of ["done", "failed"] as const)
    for (const file of list(join(tasksDir, folder), /^T-.*\.md$/)) {
      const { meta } = readDoc(file);
      finished.set(meta.id || basename(file, ".md"), folder);
    }
  const ownerOf = (name: string) => {
    if (liveIds.some((id) => name === id || name.startsWith(id + "-"))) return "";
    let best = "";
    for (const id of finished.keys()) if ((name === id || name.startsWith(id + "-")) && id.length > best.length) best = id;
    return best;
  };
  const maxAge = (o.scratchDays ?? 7) * 86_400_000;
  if (existsSync(workRoot))
    for (const name of readdirSync(workRoot)) {
      if (name.startsWith(".")) continue;
      const path = join(workRoot, name);
      if (liveTrees.has(path)) continue;
      const id = ownerOf(name);
      if (!id) continue;
      if (o.only && !o.only.includes(id)) continue;
      let st;
      try { st = lstatSync(path); } catch { continue; }
      if (!st.isDirectory()) continue; // symlinks and files are never touched
      if (existsSync(join(path, ".git"))) continue; // a checkout: only git worktree removal may take it
      if (Date.now() - st.mtimeMs < maxAge) continue;
      if (o.dry) { res.scratchRemoved.push({ id, path }); continue; }
      try { rmSync(path, { recursive: true, force: true }); res.scratchRemoved.push({ id, path }); }
      catch (e) { res.kept.push({ id, why: `scratch ${name} not removed: ${e}` }); }
    }
  return res;
}
