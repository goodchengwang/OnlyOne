// A finished worktree task used to stop at a "Committed on agent/…. What next?" card, and on 2026-11-16 the owner
// answered "open a PR" to every one of the 15 such cards (D-0013…D-0038) — several of them held the task for 20–48
// minutes first. Opening a PR is already inside "do without asking", so the branch becomes a PR on its own and a card
// is only raised for what the machine could not do: push the branch, or open the PR.
import { expect, test } from "bun:test";
import { prForWorktree } from "../src/worktree";

const tree = { repo: "/tmp/repo", branch: "agent/T-0001-fix", base: "main" };
const work = { title: "fix the thing", body: "did it", agent: "lead" };

test("a pushed branch with no PR becomes a PR, not a question", () => {
  const asked: string[] = [];
  const r = prForWorktree(tree, { ...work, pushed: "origin/agent/T-0001-fix" }, {
    find: () => null,
    create: (o) => { asked.push(o.branch); return { url: "https://github.com/o/r/pull/9" }; },
  });
  expect(r).toEqual({ pr: "https://github.com/o/r/pull/9", created: true });
  expect(asked).toEqual(["agent/T-0001-fix"]);
});

test("an existing PR for the branch is reused, never opened twice", () => {
  let created = 0;
  const r = prForWorktree(tree, { ...work, pushed: "origin/agent/T-0001-fix" }, {
    find: () => ({ url: "https://github.com/o/r/pull/8", state: "OPEN" }),
    create: () => { created++; return { url: "https://github.com/o/r/pull/10" }; },
  });
  expect(r).toEqual({ pr: "https://github.com/o/r/pull/8", created: false });
  expect(created).toBe(0);
});

test("a refused push and a refused gh still reach the owner", () => {
  const noPush = prForWorktree(tree, { ...work, pushError: "remote rejected" }, { find: () => null, create: () => ({ url: "x" }) });
  expect("ask" in noPush && noPush.ask).toContain("remote rejected");
  const noPr = prForWorktree(tree, { ...work, pushed: "origin/agent/T-0001-fix" }, { find: () => null, create: () => ({ error: "gh: not logged in" }) });
  expect("ask" in noPr && noPr.ask).toBe("gh: not logged in");
});

test("no push at all (no remote, or push disabled) is local work, not a question", () => {
  const r = prForWorktree(tree, work, { find: () => null, create: () => ({ url: "x" }) });
  expect(r).toEqual({ local: true });
});
