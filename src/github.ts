// GitHub etiquette: agents use normal `gh` commands (mostly GraphQL), not per-item REST loops via `gh api`,
// so the owner's shared quota is never exhausted. A free `gh api rate_limit` check pauses GitHub-heavy work if low.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cfg, HOME_DIR } from "./core";

const CACHE = join(HOME_DIR, "github-rate.json");
type Rate = { core: number; graphql: number; reset: number; checked: number };

/** REST shapes agents must not loop over (hard-gated for Claude Code). GraphQL & notifications stay allowed. */
export const GH_REST_GATES = [
  "Bash(gh api repos/:*)", "Bash(gh api /repos/:*)", "Bash(gh api users/:*)", "Bash(gh api /users/:*)",
  "Bash(gh api orgs/:*)", "Bash(gh api /orgs/:*)", "Bash(gh api search/:*)", "Bash(gh api /search/:*)",
  "Bash(gh api --paginate:*)",
];

async function rate(): Promise<Rate | null> {
  const c: Rate | null = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
  if (c && Date.now() - c.checked < 5 * 60_000) return c;
  if (!Bun.which("gh")) return c; // Bun.spawn throws on a missing binary, which would fail the whole tick
  const p = Bun.spawn(["gh", "api", "rate_limit"], { stdout: "pipe", stderr: "ignore" }); // free call
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) return c;
  try {
    const r = JSON.parse(out).resources;
    const v = { core: r.core.remaining, graphql: r.graphql.remaining, reset: Math.min(r.core.reset, r.graphql.reset) * 1000, checked: Date.now() };
    mkdirSync(join(CACHE, ".."), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(v));
    return v;
  } catch { return c; }
}

/** Pause GitHub-heavy tasks while quota is low (leaves the owner headroom on the shared account). */
export async function githubStarved(cfg: Cfg): Promise<{ starved: boolean; note: string }> {
  const r = await rate();
  if (!r) return { starved: false, note: "" };
  const min = cfg.github?.min_remaining ?? 1000;
  const mins = Math.max(0, Math.round((r.reset - Date.now()) / 60_000));
  return {
    starved: (r.core < min || r.graphql < min) && r.reset > Date.now(),
    note: `GitHub quota (shared with the owner): REST ${r.core}, GraphQL ${r.graphql} left, resets in ${mins}m. Use normal gh commands `
      + `(gh pr list/view/diff/checks, gh issue list/view, gh search, gh run list/view); \`gh api\` only for graphql or one notifications call.`,
  };
}

/** The owner's login from the repo's origin URL (github.com/<login>/<repo>), so signed text names the real account. */
export function repoOwner(repo: string): string {
  if (!Bun.which("git")) return "";
  const p = Bun.spawnSync(["git", "-C", repo, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  return /github\.com[:/]([^/]+)\//.exec(p.stdout.toString().trim())?.[1] ?? "";
}

/** The PR that already carries this branch, in any state: a finished task must not open a second one. */
export function prForBranch(repo: string, branch: string): { url: string; state: string } | null {
  if (!Bun.which("gh") || !branch) return null;
  const p = Bun.spawnSync(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url,state"],
    { cwd: repo, stdout: "pipe", stderr: "ignore" });
  if (p.exitCode !== 0) return null;
  try { return (JSON.parse(p.stdout.toString()) as { url: string; state: string }[])[0] ?? null; } catch { return null; }
}

/** Open a PR for a pushed branch. Merging stays behind a card; opening one does not (policies/autonomy.md). */
export function openPr(o: { repo: string; branch: string; base: string; title: string; body: string; agent: string }): { url?: string; error?: string } {
  if (!Bun.which("gh")) return { error: "gh is not installed" };
  const owner = repoOwner(o.repo);
  const body = `${o.body}\n\n---\nTask · ${o.title} · branch \`${o.branch}\`\n\n🤖 OnlyOne (${o.agent}) · AI agent acting for @${owner || "the owner"}\n`;
  const p = Bun.spawnSync(["gh", "pr", "create", "--head", o.branch, "--base", o.base, "--title", o.title, "--body", body],
    { cwd: o.repo, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  if (p.exitCode === 0) return { url: out.split("\n").filter(Boolean).pop() ?? "" };
  return { error: (p.stderr.toString().trim() || out).split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) };
}
