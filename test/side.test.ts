// Side chat (docs/side-chat.md): the conversation keys, the transcript rules the Worker applies, and the command the
// primary runs. The panel and the routes are covered by app/App.test.tsx and the Worker's own standalone run.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA } from "../src/core";
import { sideCommand, sidePrompt, sideSystem, sideTarget } from "../src/side";
import {
  SIDE_CONV, SIDE_MESSAGES, addSideMessage, answerSide, emptySide, parseSide, sideChannel, sideConv, sideTask, stalePending, stepSide,
} from "../cloud/src/side";

const put = (p: string, s: string) => { mkdirSync(dirname(join(DATA, p)), { recursive: true }); writeFileSync(join(DATA, p), s); };

test("a side chat hangs off the conversation on screen", () => {
  expect(sideConv("channel", null)).toBe("main");
  expect(sideConv("channel", "onlyone-releases")).toBe("ch:onlyone-releases");
  expect(sideConv("channel", "prj-fc4d1356-397f-4522-b214-9a44cb3a4a88")).toBe("ch:prj-fc4d1356-397f-4522-b214-9a44cb3a4a88");
  expect(sideConv("task", "onlyone-releases", "T-0031")).toBe("task:T-0031");
  // not conversations
  expect(sideConv("team")).toBeNull();
  expect(sideConv("doc")).toBeNull();
  expect(sideConv("task", null, "bogus")).toBeNull();
});

test("only the three conversation shapes are accepted, from any client", () => {
  for (const ok of ["main", "ch:a", "ch:prj-fc4d1356-397f-4522-b214-9a44cb3a4a88", "task:T-0031"]) expect(SIDE_CONV.test(ok)).toBe(true);
  for (const bad of ["", "chasb", "ch:", "ch:UPPER", "ch:../../x", "task:", "task:T-31", "main ", "xmain"]) expect(SIDE_CONV.test(bad)).toBe(false);
  expect(sideChannel("ch:onlyone-releases")).toBe("onlyone-releases");
  expect(sideChannel("main")).toBeUndefined();
  expect(sideTask("task:T-0031")).toBe("T-0031");
});

test("the transcript keeps the newest messages and a retry never doubles one", () => {
  let chat = emptySide("main", "2026-11-16T00:00:00.000Z");
  chat = addSideMessage(chat, { id: "m1", role: "owner", text: "先把需求聊清楚" }, Date.parse("2026-11-16T00:00:01Z"));
  expect(chat.messages).toHaveLength(1);
  expect(chat.updated).toBe("2026-11-16T00:00:01.000Z");
  for (let i = 0; i < SIDE_MESSAGES + 5; i++) chat = addSideMessage(chat, { id: `x${i}`, role: "agent", text: `answer ${i}` });
  expect(chat.messages).toHaveLength(SIDE_MESSAGES);
  expect(chat.messages.at(-1)!.text).toBe(`answer ${SIDE_MESSAGES + 4}`);
  // the tail is what survives: the owner's first message is long gone, the newest answer is there
  expect(chat.messages.some((m) => m.id === "m1")).toBe(false);
});

test("an answer clears the pending turn; a step only touches its own turn", () => {
  const asked = { ...emptySide("ch:x"), pending: { id: "s-1", at: "2026-11-16T00:00:00.000Z" } };
  expect(stepSide(asked, { id: "s-2", step: "Read · a.ts" })).toBe(asked);
  const stepped = stepSide(asked, { id: "s-1", step: "Read · a.ts" });
  expect(stepped.pending!.step).toBe("Read · a.ts");
  const answered = answerSide(stepped, { id: "s-1", text: "看 `src/cli.ts:12`" }, Date.parse("2026-11-16T00:00:09Z"));
  expect(answered.pending).toBeUndefined();
  expect(answered.messages).toEqual([{ id: "s-1", role: "agent", text: "看 `src/cli.ts:12`", ts: "2026-11-16T00:00:09.000Z" }]);
  const failed = answerSide(stepped, { id: "s-1", text: "stopped", error: true });
  expect(failed.messages[0].error).toBe(true);
});

test("a corrupt row reads as an empty side chat, not a crash", () => {
  expect(parseSide("not json", "main")).toMatchObject({ conv: "main", messages: [] });
  expect(parseSide('{"messages":[{"role":"nobody","text":"x","ts":"t"},{"role":"owner","text":"hi","ts":"t"},{"role":"agent","text":5,"ts":"t"}]}', "main").messages)
    .toEqual([{ id: "", role: "owner", text: "hi", ts: "t" }]);
});

test("a pending turn nobody answered goes away", () => {
  const at = "2026-11-16T00:00:00.000Z";
  expect(stalePending({ id: "s-1", at }, Date.parse("2026-11-16T00:19:00Z"))).toBe(false);
  expect(stalePending({ id: "s-1", at }, Date.parse("2026-11-16T00:21:00Z"))).toBe(true);
  expect(stalePending(undefined)).toBe(false);
});

test("the first turn opens a session with the rules; later turns resume it without them", () => {
  const first = sideCommand({}, true, "u-1", "# OnlyOne releases", 'Work topic "OnlyOne releases"');
  expect(first.join(" ")).toContain("--session-id u-1");
  expect(first.join(" ")).toContain("--append-system-prompt");
  expect(first).not.toContain("--resume");
  expect(first[first.indexOf("--model") + 1]).toBe("claude-opus-5-5");

  const later = sideCommand({}, false, "u-1", "# OnlyOne releases", "");
  expect(later.join(" ")).toContain("--resume u-1");
  expect(later.join(" ")).not.toContain("--append-system-prompt");
  expect(later.join(" ")).not.toContain("--session-id");

  // read-only either way: no file writes, and the same hard gates as a task run
  for (const cmd of [first, later]) {
    const deny = cmd.slice(cmd.indexOf("--disallowedTools") + 1);
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash(gh pr merge:*)", "Bash(npm publish:*)"]) expect(deny).toContain(t);
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  }
});

test("the system prompt says what the side chat is, and the turn carries the conversation", () => {
  const sys = sideSystem("# OnlyOne releases", 'Work topic "OnlyOne releases"');
  expect(sys).toContain("# OnlyOne releases");
  expect(sys).toContain("cannot change anything");
  const prompt = sidePrompt("main", "先把这个功能的边界想清楚");
  expect(prompt).toContain("先把这个功能的边界想清楚");
  // a task's own request is in the system prompt, so its turn carries no main-chat transcript
  const task = sidePrompt("task:T-0031", "继续");
  expect(task).not.toContain("The conversation this side chat sits beside");
});

test("a task's side chat reads in the task's folder and knows what the task asked for", () => {
  put("tasks/active/T-0031.md", `---\nid: T-0031\ntitle: side chat\nagent: lead\nrepo: ${process.cwd()}\n---\n> 为会话增加 side 聊天\n\n## Owner follow-up 2026-11-16\n> more\n`);
  const t = sideTarget("task:T-0031");
  expect(t.cwd).toBe(process.cwd());
  expect(t.title).toContain("T-0031");
  expect(t.context).toContain("为会话增加 side 聊天");
  // the main chat reads the fleet folder, where memory and tasks live
  const main = sideTarget("main");
  expect(main.cwd).toBe(DATA);
  expect(main.title).toContain("main chat");
});
