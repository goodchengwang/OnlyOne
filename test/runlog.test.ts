// A run's whole process (docs/run-trace.md): what the panel beside a conversation shows when the owner opens a run
// record. The task file keeps only the run's summary, so this is the record itself — parsed from the run's log.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_KEEP, RUN_STEP_MAX, runPath, trimSteps } from "../cloud/src/runs";
import { P } from "../src/core";
import { traceFromLog, writeTrace } from "../src/runlog";

const dir = () => mkdtempSync(join(tmpdir(), "onlyone-runlog-"));
const line = (o: unknown) => JSON.stringify(o);

/** A Claude stream-json transcript as src/runner.ts writes it: the command line, events, the exit code. */
const claudeLog = () => [
  "$ claude -p --output-format stream-json",
  line({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
  line({ type: "assistant", timestamp: "2026-11-16T06:00:01Z", message: { content: [
    { type: "text", text: "我先看一下代码。" },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/cli.ts" } },
  ] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } }),
  line({ type: "assistant", timestamp: "2026-11-16T06:00:02Z", message: { content: [
    { type: "tool_use", id: "t2", name: "Bash", input: { description: "Run the tests", command: "bun test" } },
  ] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "3 tests failed" }] }] } }),
  line({ type: "result", result: "改好了，测试全绿。" }),
  "(exit 0)",
  "",
  "[stderr]",
].join("\n");

const read = (id: string, at: string) => JSON.parse(readFileSync(P(...runPath(id, at).split("/")), "utf8"));

test("a run's log becomes its process: what it read, what it ran, what failed, how it ended", () => {
  const file = join(dir(), "T-0001.log");
  writeFileSync(file, claudeLog());
  const t = traceFromLog({ id: "T-0001", at: "2026-11-16T06:00:00Z", logFile: file, host: "mac", cli: "claude" });
  // a failing tool call is the same step, marked: the process reads in the order it happened
  expect(t.steps.map((s) => s.kind)).toEqual(["say", "tool", "fail"]);
  expect(t.steps[1].text).toBe("Read · src/cli.ts");
  // a failing tool call keeps what it was doing and why it failed
  expect(t.steps[2].text).toContain("Bash · Run the tests");
  expect(t.steps[2].text).toContain("3 tests failed");
  expect(t.model).toBe("claude-opus-5-5");
  expect(t.exit).toBe(0);
  expect(t.summary).toBe("改好了，测试全绿。");
  // the log's own command line, exit line and stderr tail are not steps
  expect(t.steps.some((s) => s.text.startsWith("$ claude"))).toBe(false);
});

test("a CLI that prints plain text still has a process worth reading", () => {
  const file = join(dir(), "T-0002.log");
  writeFileSync(file, "$ codex exec\n正在读取仓库\n改了 3 个文件\n(exit 0)\n\n[stderr]\n");
  const t = traceFromLog({ id: "T-0002", at: "2026-11-16T06:10:00Z", logFile: file, cli: "codex" });
  expect(t.steps.map((s) => s.text)).toEqual(["正在读取仓库", "改了 3 个文件"]);
});

test("a log still being written is read as far as it goes", () => {
  const file = join(dir(), "T-0003.log");
  writeFileSync(file, `${claudeLog().split("\n").slice(0, 4).join("\n")}\n{"type":"assistant","mess`);
  const t = traceFromLog({ id: "T-0003", at: "2026-11-16T06:20:00Z", logFile: file, host: "mac", cli: "claude" });
  expect(t.steps.length).toBe(2);
  expect(t.status).toBeUndefined();
});

test("a missing log still names the run", () => {
  const t = traceFromLog({ id: "T-0004", at: "2026-11-16T06:30:00Z", logFile: join(dir(), "gone.log"), status: "done", summary: "done" });
  expect(t).toMatchObject({ id: "T-0004", at: "2026-11-16T06:30:00Z", steps: [], status: "done" });
});

test("a very long run keeps its opening and its end, and says how much it left out", () => {
  const steps = Array.from({ length: RUN_STEP_MAX + 60 }, (_, i) => ({ kind: "tool" as const, text: `step ${i}` }));
  const { steps: kept, dropped } = trimSteps(steps);
  expect(kept.length).toBe(RUN_STEP_MAX);
  expect(kept[0].text).toBe("step 0");
  expect(kept[kept.length - 1].text).toBe(`step ${RUN_STEP_MAX + 59}`);
  expect(dropped).toBe(60);
});

test("the process file is keyed by the run's own stamp and carries its status", () => {
  const file = join(dir(), "T-0005.log");
  writeFileSync(file, claudeLog());
  const at = "2026-11-16T06:40:00Z";
  const trace = { ...traceFromLog({ id: "T-9005", at, logFile: file, host: "mac", cli: "claude" }), status: "done", summary: "全部完成" };
  writeTrace(trace);
  // the stamp is a path segment: its colons become dashes so the file is the same name on every client
  expect(runPath("T-9005", at)).toBe("runs/T-9005/2026-11-16T06-40-00Z.json");
  expect(read("T-9005", at)).toMatchObject({ id: "T-9005", at, status: "done", summary: "全部完成" });
  expect(read("T-9005", at).steps.length).toBe(3);
});

test("only the newest traces of a task stay: its task file never names more than a few runs", () => {
  const id = "T-9006";
  for (let i = 0; i < RUN_KEEP + 3; i++) {
    const at = `2026-11-16T07:${String(i).padStart(2, "0")}:00Z`;
    writeTrace({ id, at, steps: [{ kind: "say", text: `run ${i}` }] });
  }
  const files = readdirSync(P("runs", id)).filter((f) => f.endsWith(".json")).sort();
  expect(files.length).toBe(RUN_KEEP);
  // the oldest are the ones gone; the newest run is still there
  expect(files[files.length - 1]).toBe("2026-11-16T07-14-00Z.json");
  expect(files).not.toContain("2026-11-16T07-00-00Z.json");
});

test("a run's process is readable by the owner's clients", () => {
  // the panel reads it through /api/files/read, whose whitelist is the only way a client sees a data file
  mkdirSync(P("runs", "T-9007"), { recursive: true });
  const { readable } = require("../cloud/src/files") as typeof import("../cloud/src/files");
  expect(readable(runPath("T-9007", "2026-11-16T08:00:00Z"))).toBe(true);
  expect(readable("logs/runs/T-9007-1.log")).toBe(false);
});
