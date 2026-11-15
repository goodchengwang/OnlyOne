import { expect, test } from "bun:test";
import { backoffMinutes, HUMAN_WAIT_MAX_HOURS, humanWaitExpired, isMergeCard, isNoChangeRoutine, mergeHeadline, tooManyWakes, waitKind, waitMeta } from "../src/waits";

test("CI wait_check backs off 5 → 10 → 20 → 40 minutes", () => {
  expect([0, 1, 2, 3, 4, 9].map(backoffMinutes)).toEqual([5, 10, 20, 40, 40, 40]);
});

test("human waits get no timed wake-up; CI waits do", () => {
  expect(waitKind({ waiting_on: "owner 手动 make publish" })).toBe("human");
  expect(waitKind({ waiting_on: "等你点合并 nsh #1022" })).toBe("human");
  expect(waitKind({ waiting_on: "CI run https://github.com/o/r/actions/runs/1" })).toBe("ci");
  expect(waitKind({ wait_kind: "ci", waiting_on: "owner" })).toBe("ci");
  const h = waitMeta({ wait_kind: "human", wait_minutes: 30 }, 0);
  expect(h.wake_at).toBeUndefined();
  const c = waitMeta({ waiting_on: "CI", wait_minutes: 500 }, 0);
  expect(c.wake_at).toBe(new Date(120 * 60_000).toISOString());
});

test("more than 6 wake-ups blocks the task", () => {
  expect(tooManyWakes(6)).toBe(false);
  expect(tooManyWakes(7)).toBe(true);
});

test("an unanswered human wait is woken once after 24h to wrap up, never twice", () => {
  const parked = new Date("2026-11-14T21:45:00Z").getTime();
  const meta = { wait_kind: "human", parked_at: new Date(parked).toISOString() };
  expect(humanWaitExpired(meta, parked + 3 * 3_600_000)).toBe(false); // young human waits still wake only on events
  expect(humanWaitExpired(meta, parked + (HUMAN_WAIT_MAX_HOURS + 1) * 3_600_000)).toBe(true);
  expect(humanWaitExpired({ ...meta, human_wait_expired: "yes" }, parked + 999 * 3_600_000)).toBe(false); // only once
  expect(humanWaitExpired({ wait_kind: "ci", parked_at: meta.parked_at }, parked + 999 * 3_600_000)).toBe(false);
  expect(humanWaitExpired({ wait_kind: "human" }, parked + 999 * 3_600_000)).toBe(false); // no timestamp: no deadline
});

test("D: merge cards are recognised and lead with the PR link", () => {
  expect(isMergeCard({ question: "现在合并 omamail #457 吗？" })).toBe(true);
  expect(isMergeCard({ question: "Merge gpui-fast #101?" })).toBe(true);
  expect(isMergeCard({ question: "#1004 用哪种修法？" })).toBe(false);
  expect(isMergeCard({ question: "合并哪几项？", kind: "menu" })).toBe(false);
  expect(mergeHeadline("见 https://github.com/huacnlee/omamail/pull/457 head 7c0b2a0")).toBe("https://github.com/huacnlee/omamail/pull/457 需要你点合并");
});

test("routine runs without changes stay out of the owner channel", () => {
  expect(isNoChangeRoutine("routine:own-prs-ci", "本轮没有修改或推送。")).toBe(true);
  expect(isNoChangeRoutine("owner@chat", "本轮没有修改")).toBe(false);
  expect(isNoChangeRoutine("routine:pr-review", "审了 nsh #981，发了评论")).toBe(false);
});
