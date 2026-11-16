// Side chat: a private scratch conversation beside a conversation (docs/side-chat.md). Pure shapes and rules, shared by
// the Worker (storage and routes), the primary (running a turn) and the app (the panel); no I/O here.
//
// A side chat is keyed by the conversation it sits beside: `main`, `ch:<slug>` (a work or project channel) or
// `task:<T-id>`. It is never a feed event: nothing here can reach the conversation's history, and nothing here is work.

export type SideMessage = { id: string; role: "owner" | "agent"; text: string; ts: string; error?: boolean };
/** What the panel shows while the primary is answering; `step` is the agent's latest step ("Read · src/cli.ts"). */
export type SidePending = { id: string; at: string; step?: string };
export type SideChat = { conv: string; messages: SideMessage[]; pending?: SidePending; updated: string };

/** Conversation keys a side chat may hang off. A channel slug is CHANNEL_SLUG; a task id is TASK_ID. */
export const SIDE_CONV = /^(main|ch:[a-z0-9][a-z0-9-]{0,47}|task:T-[\w-]*\d{4})$/;
export const SIDE_MESSAGES = 80; // the newest kept; older ones fall off the top
export const SIDE_TEXT_MAX = 20_000;
export const SIDE_PENDING_MS = 20 * 60_000; // a turn this old never comes back (the primary died mid-answer)

export const emptySide = (conv: string, updated = new Date().toISOString()): SideChat => ({ conv, messages: [], updated });

/** The conversation a route belongs to, as a side-chat key. Pages that are not conversations have none. */
export function sideConv(page: string, scope?: string | null, taskId?: string | null): string | null {
  if (page === "channel") return scope ? `ch:${scope}` : "main";
  if (page === "task" && taskId) return /^T-[\w-]*\d{4}$/.test(taskId) ? `task:${taskId}` : null;
  return null;
}

/** The channel slug a side chat belongs to ("ch:onlyone-client-app" → "onlyone-client-app"), if any. */
export const sideChannel = (conv: string): string | undefined => (conv.startsWith("ch:") ? conv.slice(3) : undefined);
/** The task a side chat belongs to, if any. */
export const sideTask = (conv: string): string | undefined => (conv.startsWith("task:") ? conv.slice(5) : undefined);

const clean = (c: Partial<SideChat>, conv: string): SideChat => ({
  conv,
  messages: (Array.isArray(c.messages) ? c.messages : [])
    .filter((m): m is SideMessage => !!m && typeof m.text === "string" && (m.role === "owner" || m.role === "agent") && typeof m.ts === "string")
    .map((m) => ({ id: String(m.id ?? ""), role: m.role, text: m.text.slice(0, SIDE_TEXT_MAX), ts: m.ts, ...(m.error ? { error: true } : {}) })),
  ...(c.pending && typeof c.pending.id === "string" ? { pending: { id: c.pending.id, at: String(c.pending.at ?? ""), ...(c.pending.step ? { step: String(c.pending.step) } : {}) } } : {}),
  updated: String(c.updated ?? ""),
});

/** A row's text back into a chat (tolerates anything: a corrupt row reads as empty rather than breaking the panel). */
export function parseSide(text: string, conv: string): SideChat {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? clean(j, conv) : emptySide(conv);
  } catch {
    return emptySide(conv);
  }
}

/** Append a message, drop the oldest past the cap, and drop a `pending` that cannot still be answered. */
export function addSideMessage(chat: SideChat, m: Omit<SideMessage, "ts"> & { ts?: string }, now = Date.now()): SideChat {
  const ts = m.ts ?? new Date(now).toISOString();
  const messages = [...chat.messages, { ...m, text: m.text.slice(0, SIDE_TEXT_MAX), ts }].slice(-SIDE_MESSAGES);
  return { conv: chat.conv, messages, updated: ts };
}

/** The primary's final frame: append the answer (or the error) under the pending turn's id, and clear pending. */
export function answerSide(chat: SideChat, r: { id: string; text: string; error?: boolean }, now = Date.now()): SideChat {
  return addSideMessage({ ...chat, pending: undefined }, { id: r.id, role: "agent", text: r.text, ...(r.error ? { error: true } : {}) }, now);
}

/** An interim frame: the step the agent is on, so a reconnecting client shows it too. */
export function stepSide(chat: SideChat, s: { id: string; step: string; at?: string }): SideChat {
  if (!chat.pending || chat.pending.id !== s.id) return chat;
  return { ...chat, pending: { ...chat.pending, step: s.step.slice(0, 200) } };
}

/** A `pending` nobody will answer any more (a POST clears one this old before queueing the next turn). */
export const stalePending = (p: SidePending | undefined, now = Date.now()): boolean => !!p && now - Date.parse(p.at) > SIDE_PENDING_MS;
