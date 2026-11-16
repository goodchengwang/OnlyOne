# Side chat (侧边聊天)

Every conversation — the main chat, a work channel, a project channel, a task page — can open a **side chat**
beside it. A side chat is a private scratch conversation with a real agent: it can read the conversation's code and
memory and use skills, it never appears in the conversation's history, and nothing it does becomes work. When the
owner is done, **Push to conversation** sends the edited text into the conversation as a normal message, so the chat
brain turns it into a task or a task follow-up.

Two uses the owner named:

1. Refine a feature in the side chat first, then push the finished request into the conversation to have it built.
2. Ask questions about a project without leaving a trace in the conversation or the main chat.

## What a side chat is not

- Not a task: no task card, no agent run log, no branch, commit or PR, no notifications.
- Not history: its messages are never feed events, never counted as unread, never in the channel digest.
- Not a second way to change things: the side agent is read-only. File edits, commits, pushes, merges, releases and
  task changes are denied mechanically (the same hard gates as a task run, plus Write / Edit / MultiEdit /
  NotebookEdit). If the answer implies a change, the agent proposes it; the owner pushes it.

## The agent

One `claude -p` session per side conversation (`--session-id` on the first turn, `--resume` afterwards), on the
primary, with the conversation's folder as its working directory, so project `CLAUDE.md`, skills and memory load
exactly as they do for a task. The instructions are appended to the system prompt on the first turn (a resumed
session keeps its system prompt). Each turn carries the conversation context (name, goal or task state, and the last
few lines of the conversation) in its message, not in the session's own history.

Working directory: a project channel or a task in a project runs in the project's folder when that folder is on this
machine; otherwise the fleet folder. The fleet folder is also what the main chat and work channels use.

The model is the one task runs use (`[clis.claude] model`); `[side] model` in `config.toml` picks a faster one for this
chat alone.

Turns are serialized and run one at a time, outside the inbox drain, so a slow side answer never delays the owner's
real messages. A turn stops after ten minutes (`side.timeout_minutes` in `config.toml`) or four minutes without output,
and the panel shows how long it has been waiting.

## Storage

One row per side conversation in the Durable Object:

```
side(conv TEXT PRIMARY KEY, json TEXT, updated INTEGER)
```

`conv` is `main`, `ch:<slug>` or `task:<T-id>`. `json` is `{conv, messages: [{id, role, text, ts, error?}],
pending?: {id, at, step?}, updated}`, keeping the newest 80 messages. It is separate from `events`: no feed row, no
indexed scan, no file sync, nothing in the data repo. A phone and a Mac therefore see the same side chat, and a reply
that arrives while a socket is down is still there when the client reopens the panel.

`pending` is what the panel shows as "working": `POST /api/side` sets it, the primary clears it with the final
frame. A new message clears a `pending` older than 20 minutes (the daemon died mid-turn).

## Transport

| Route | Who | What |
|---|---|---|
| `GET /api/side?conv=` | owner session | the transcript (one row read) |
| `POST /api/side {conv, text, client_id}` | owner session | append the owner message, set pending, queue the turn |
| `DELETE /api/side?conv=` | owner session | clear this side chat |
| `POST /api/host/side {conv, id, text, step, done, error, session}` | machine | the primary's interim and final frames |

`POST /api/side` queues `{type: "side", conv, id, text}` on the existing owner→fleet inbox (the same hibernating
socket that already carries chat messages), so there is no new poller and no new timer.

The primary answers over the existing owner sockets as `{"$side": {conv, message, pending}}` frames — the same
socket that already pushes `$status`. Interim frames (the step the agent is on) are coalesced to at most one every
five seconds; the final frame carries the answer. A client ignores frames for other conversations.

**Push to conversation** uses the existing `POST /api/messages`: main chat and channels pass `channel`, a task page
passes `reply_to` + `thread`. Nothing new to learn, and the same rules apply (a task follow-up reopens a finished
task; the chat brain creates the task otherwise).

## Cost (Cloudflare free plan)

A side chat is a user action, never a timer. One turn is two requests (the owner's POST and the primary's final
frame) plus up to six interim frames for a long turn, and roughly six rows (session lookup, one transcript read and
write, one inbox row, the primary's read and write). Opening the panel is one request and one row read; clearing it
is one write. Nothing runs while nobody types, so unattended cost is zero; `test/budget.test.ts` still reserves a
day's worth of turns so the headroom is explicit.

## Out of scope for this version

Images and files in a side chat, editing or regenerating a single message, and side chats on pages that are not
conversations (settings, machines).
