// Side chat on the primary (docs/side-chat.md): one `claude -p` session per side conversation, in the conversation's
// folder, so the project's CLAUDE.md, skills and memory load as they do for a task. Read-only on purpose: the side chat
// is where the owner thinks and refines a request, and the request goes into the conversation when they push it.
//
// Nothing here touches tasks, the feed or the data repo. The transcript lives in the Worker's `side` table; this file
// only keeps the local session id per conversation (a session id is meaningless on another machine).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Cfg, HOME_DIR, P, ROOT, loadConfig, now, readDoc } from "./core";
import { channels } from "./channels";
import { listProjects, projectStore } from "./projects";
import { claudeDisallowed } from "./gates";
import { recentChat } from "./server";
import { sideChannel, sideTask } from "../cloud/src/side";

export type SideRequest = { conv: string; id: string; text: string; at: string };
export type SideFrame = { conv: string; id: string; text?: string; step?: string; done?: boolean; error?: boolean };

const STATE = join(HOME_DIR, "side.json");
type Session = { session: string; cwd: string; at: string };

function sessions(): Record<string, Session> {
  try {
    const j = JSON.parse(readFileSync(STATE, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}
function saveSession(conv: string, s: Session | null) {
  const all = sessions();
  if (s) all[conv] = s; else delete all[conv];
  try { writeFileSync(STATE, JSON.stringify(all)); } catch { /* a lost session id only costs continuity */ }
}

/** Where a side chat reads and what it is beside: a project channel or a task runs in the project's folder when this
 *  machine has it; the main chat and work channels run in the fleet folder. */
export function sideTarget(conv: string): { cwd: string; title: string; context: string } {
  const slug = sideChannel(conv);
  if (slug) {
    const c = channels().find((x) => x.slug === slug);
    const project = c?.project_id ? listProjects(projectStore()).find((p) => p.id === c.project_id) : undefined;
    const onDisk = !!project && existsSync(project.repo);
    const cwd = onDisk ? project!.repo : ROOT;
    const where = project ? ` The project folder is ${project.repo} on ${project.host}${onDisk ? "." : " — not on this machine, so work from the fleet folder and say so if you need that code."}` : "";
    return { cwd, title: c ? `# ${c.name}` : `# ${slug}`, context: c ? `${c.project_id ? "Project" : "Work topic"} "${c.name}", goal: ${c.goal || "(none)"}.${where}` : "" };
  }
  const tid = sideTask(conv);
  if (tid) {
    const dirs = ["inbox", "active", "waiting", "blocked", "proposed", "done", "failed", "rejected"];
    const file = dirs.map((d) => P("tasks", d, `${tid}.md`)).find(existsSync);
    if (!file) return { cwd: ROOT, title: tid, context: `Task ${tid} (not found in the data repo).` };
    const { meta, body } = readDoc(file);
    const project = meta.project_id ? listProjects(projectStore()).find((p) => p.id === meta.project_id) : undefined;
    const repo = meta.repo || project?.repo || "";
    const cwd = repo && existsSync(repo) ? repo : ROOT;
    const state = file.split(/[\\/]/).slice(-2, -1)[0];
    const request = body.split("\n## ")[0].replace(/^> ?/gm, "").trim().slice(0, 1200);
    const runs = [...body.matchAll(/## Run \S+ · \S+ · \S+\n\*\*(\w+)\*\* — ([^\n]*)/g)].slice(-3).map((m) => `- ${m[1]}: ${m[2]}`);
    return { cwd, title: `${tid} ${meta.title ?? ""}`.trim(), context: `Task ${tid} "${meta.title ?? ""}", state: ${state}, agent: ${meta.agent ?? "?"}${repo ? `, folder ${repo}` : ""}.\nThe owner's request:\n${request}${runs.length ? `\nLatest runs:\n${runs.join("\n")}` : ""}` };
  }
  return { cwd: ROOT, title: "the main chat with OnlyOne", context: "" };
}

/** The stable half of the prompt, appended to the system prompt of the session's first turn (a resumed session keeps it). */
export function sideSystem(title: string, context: string): string {
  return `You are the owner's side chat: a private scratch conversation opened beside "${title}", a conversation in OnlyOne, the owner's own AI agent fleet.

${context ? `${context}\n\n` : ""}How this chat works:
- Nothing said here is posted to the conversation, and nothing here becomes work. You are not running as a task: there is no task card, no branch, no result report.
- You may read anything you need — this project's code, its CLAUDE.md and skills, the fleet's memory and tasks — and answer with file:line references.
- You cannot change anything. File-writing tools are switched off and commits, pushes, merges, releases and task changes are denied. When a change is the answer, describe exactly what to change and where.
- The owner usually uses this chat to turn a rough idea into a request they will push into the conversation with one tap: help make it complete (what changes, where, how it should behave, what to verify) without padding it.
- Answer in the owner's language, concretely and briefly. No preamble, no "I'll help you" — answer.`;
}

/** What a step is called in the panel ("Read · src/cli.ts"), from one stream-json tool_use. */
function stepLabel(name: string, input: any): string {
  const i = input ?? {};
  const v = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.prompt || "";
  return `${name}${v ? ` · ${String(v).split("\n")[0].slice(0, 120)}` : ""}`;
}

/** The command for one turn: the first turn opens the session with the instructions, later turns resume it. */
export function sideCommand(cfg: Cfg, first: boolean, session: string, title: string, context: string): string[] {
  const c = cfg.clis?.claude ?? {};
  const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", c.permission_mode ?? "bypassPermissions",
    // the same model a task runs on, unless `[side] model` asks for a faster one
    "--model", cfg.side?.model ?? c.model ?? "claude-opus-5-5",
    "--strict-mcp-config", // no connector round trips for a scratch chat; skills and the project still load
    "--settings", JSON.stringify({ attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false }),
    // read-only: no file writes, and the same hard gates a task run has
    "--disallowedTools", ...claudeDisallowed(cfg), "Write", "Edit", "MultiEdit", "NotebookEdit"];
  if (first) cmd.push("--session-id", session, "--append-system-prompt", sideSystem(title, context));
  else cmd.push("--resume", session);
  return cmd;
}

/** The turn's message: the conversation it sits beside (main chat or channel only; a task's own request is already in
 *  the system prompt), then the owner's words. */
export function sidePrompt(conv: string, text: string): string {
  const chat = sideTask(conv) ? [] : recentChat("", { channel: sideChannel(conv), limit: 10 });
  return [
    chat.length ? `The conversation this side chat sits beside, just before (oldest first; not part of this chat):\n${chat.join("\n")}` : "",
    `The owner's message in the side chat:\n${text}`,
  ].filter(Boolean).join("\n\n");
}

let running = false;
const queue: SideRequest[] = [];

/** Queue one turn. One at a time, outside the inbox drain, so a slow answer never delays the owner's messages. */
export function queueSideTurn(req: SideRequest) {
  if (queue.some((q) => q.id === req.id)) return;
  queue.push(req);
  void pump();
}

/** One frame back to the Worker (its owner sockets fan it out to the panel). No dependency on the cloud bridge.
 *  The final frame is the answer and exists nowhere else on the machine, so it is retried before it is given up. */
async function post(cfg: Cfg, frame: SideFrame) {
  const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
  if (!url || !cfg.server?.token) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await Bun.sleep(attempt * 2000);
    const r = await fetch(`${url}/api/host/side`, {
      method: "POST", headers: { Authorization: `Bearer ${cfg.server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(frame), signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (r?.ok) return;
  }
  console.error(`side chat ${frame.conv}: the ${frame.done ? "answer" : "step"} could not be delivered`);
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const req = queue.shift()!;
      if (Date.now() - Date.parse(req.at) > 60 * 60_000) { await post(loadConfig(), { conv: req.conv, id: req.id, done: true, error: true, text: "This side-chat message waited an hour for a computer; it was dropped." }); continue; }
      try { await turn(req); }
      catch (err) { console.error(`side chat ${req.conv}: ${err}`); }
    }
  } finally { running = false; }
}

async function turn(req: SideRequest) {
  const cfg = loadConfig();
  const target = sideTarget(req.conv);
  const prev = sessions()[req.conv];
  const first = !prev || prev.cwd !== target.cwd;
  const session = first ? crypto.randomUUID() : prev.session;
  const cmd = sideCommand(cfg, first, session, target.title, target.context);
  const limitMs = (cfg.side?.timeout_minutes ?? 10) * 60_000;
  const idleMs = 4 * 60_000;

  mkdirSync(P("logs", "runs"), { recursive: true });
  const logFile = P("logs", "runs", `side-${req.conv.replace(/[^\w-]+/g, "-")}-${Date.now()}.log`);
  const prompt = sidePrompt(req.conv, req.text);
  const proc = Bun.spawn(cmd, {
    cwd: existsSync(target.cwd) ? target.cwd : ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
  });

  let text = "", step = "", lastPost = 0, lastOutput = Date.now(), alive = true;
  const sendStep = async (label: string) => {
    step = label;
    if (Date.now() - lastPost < 5000) return; // the panel needs progress, not a request per tool call
    lastPost = Date.now();
    await post(cfg, { conv: req.conv, id: req.id, step: label });
  };
  const onLine = (line: string) => {
    lastOutput = Date.now();
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "text" && !e.parent_tool_use_id) text += c.text;
        if (c.type === "tool_use") void sendStep(stepLabel(c.name, c.input));
      }
    } else if (e.type === "result") {
      if (typeof e.result === "string" && e.result.trim()) text = e.result;
      if (e.is_error) text = `${text}\n\n${String(e.result ?? e.subtype ?? "the run failed")}`.trim();
    }
  };
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "", all = "";
    for await (const chunk of stream) {
      const t = dec.decode(chunk, { stream: true });
      all += t;
      buf += t;
      const parts = buf.split("\n");
      buf = parts.pop()!;
      parts.forEach(onLine);
    }
    if (buf) onLine(buf);
    return all;
  };
  const timer = setTimeout(() => { alive = false; proc.kill(); }, limitMs);
  const watch = setInterval(() => { if (Date.now() - lastOutput > idleMs) { alive = false; proc.kill(); } }, 20_000);
  let raw = "", err = "";
  try {
    [raw, err] = await Promise.all([read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)]);
    await proc.exited;
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
  try { writeFileSync(logFile, `$ ${cmd.join(" ")}\n\n${raw}\n\n[stderr]\n${err}`); } catch { /* the log is only for debugging */ }

  // a resume can fail when the session file is gone (another machine, a cleaned ~/.claude): start a fresh one next turn
  const lost = !first && /No conversation found|Session .* not found|--resume/i.test(err);
  if (lost) saveSession(req.conv, null);
  else saveSession(req.conv, { session, cwd: target.cwd, at: now() });

  const answer = text.trim();
  if (answer) await post(cfg, { conv: req.conv, id: req.id, done: true, text: answer });
  else await post(cfg, {
    conv: req.conv, id: req.id, done: true, error: true,
    text: alive ? `The side chat produced no answer.${step ? ` It stopped after: ${step}.` : ""}` : `The side chat stopped after ${Math.round(limitMs / 60_000)} minutes${step ? `; last step: ${step}` : ""}.`,
  });
}
