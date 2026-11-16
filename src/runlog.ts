// Turning one run's log into the process the owner can read (docs/run-trace.md).
//
// A run writes its whole transcript to logs/runs/<T-id>-<ms>-<cli>.log (src/runner.ts): with Claude that is one JSON
// event per line (stream-json), with Codex the plain output. The task file itself keeps only the run's summary, because
// it is also the next run's prompt; this file is the full record, beside the task rather than in it.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUN_KEEP, type RunStep, type RunTrace, runPath, trimSteps } from "../cloud/src/runs";
import { P } from "./core";
import { toolStep } from "./runner";

/** Longest single step kept: a Read of a big file or a long answer is elided, the rest of the sequence still reads. */
const MAX_STEP = 700;
const MAX_FILE = 32 * 1024 * 1024; // a run log is a transcript, not an archive: past this the tail is what matters

const clip = (s: string, n = MAX_STEP) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The text of a tool_result block, whatever shape the CLI gave it. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

/**
 * One run's process, read back from its log file. `at` is the `## Run <at>` stamp of the task file, so the pane and
 * the task page name the same run; the summary comes from the run's own result block when the log has one.
 */
export function traceFromLog(o: { id: string; at: string; logFile: string; host?: string; cli?: string; model?: string; status?: string; summary?: string }): RunTrace {
  let text = "";
  try { text = readFileSync(o.logFile, "utf8"); } catch { /* the log is gone (pruned): an empty trace still names the run */ }
  if (text.length > MAX_FILE) text = text.slice(-MAX_FILE);
  const lines = text.split("\n");
  const steps: RunStep[] = [];
  const open = new Map<string, number>(); // tool_use id → its step, until the result comes back
  let model: string | undefined, exit: number | undefined, result: string | undefined, sawJson = false;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    const exitLine = /^\(exit (\d+)\)$/.exec(l);
    if (exitLine) { exit = Number(exitLine[1]); continue; }
    if (!l.startsWith("{")) continue; // the "$ cmd" line, a "[stderr]" tail, plain CLI output
    let e: any;
    try { e = JSON.parse(l); } catch { continue; } // a line still being written
    sawJson = true;
    if (e.type === "system" && e.subtype === "init" && e.model) { model = String(e.model); continue; }
    if (e.type === "assistant") {
      if (e.message?.model) model ??= String(e.message.model);
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use") {
          open.set(c.id, steps.length);
          steps.push({ at: e.timestamp, kind: "tool", name: c.name, text: clip(toolStep(c.name, c.input)) });
        } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          steps.push({ at: e.timestamp, kind: "say", text: clip(c.text.trim()) });
        }
      }
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const i = open.get(c.tool_use_id);
        open.delete(c.tool_use_id);
        if (i === undefined || !c.is_error) continue;
        const s = steps[i];
        const why = resultText(c.content).trim();
        steps[i] = { ...s, kind: "fail", text: clip(why ? `${s.text}\n${why}` : s.text) };
      }
    } else if (e.type === "result" && typeof e.result === "string") {
      result = e.result;
    }
  }
  // a CLI that prints plain text (Codex) still has a process worth reading: its lines are the record
  if (!sawJson) {
    const noise = (l: string) => !l.trim() || l.startsWith("$ ") || l === "[stderr]" || /^\(exit \d+\)$/.test(l.trim());
    for (const line of lines.slice(1).filter((l) => !noise(l))) steps.push({ kind: "say", text: clip(line.trim()) });
  }
  return { id: o.id, at: o.at, host: o.host, cli: o.cli, model: model ?? o.model, status: o.status, summary: o.summary ?? result?.trim().slice(0, 600), exit, ...trimSteps(steps) };
}

/** Write a run's process where the sync carries it to every client: runs/<T-id>/<stamp>.json in the data folder. */
export function writeTrace(trace: RunTrace): void {
  const rel = runPath(trace.id, trace.at);
  const file = P(...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(trace));
  // the task file names the last five runs; older traces are unreachable, so they do not stay in the folder
  const dir = dirname(file);
  const old = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const f of old.slice(0, Math.max(0, old.length - RUN_KEEP))) {
    if (join(dir, f) !== file) rmSync(join(dir, f), { force: true });
  }
}
