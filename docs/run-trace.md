# Run trace (运行过程)

A run record in a conversation names one run: its summary, who ran it, how it ended. Pressing it opens the **whole
process** in the pane beside the conversation — the same pane as the side chat, one at a time — instead of only the
summary: every tool the agent called, what it said to the owner, which calls failed and why.

Two places open it:

- the live line on a task page (`最近：Bash · Run the tests · 刚刚`), which is the run going on now;
- a run's summary in the task's own conversation (`运行记录`), each one press away from its own process.

## Where a process lives

```
runs/<T-id>/<stamp>.json           # <stamp> = the `## Run <at>` line's stamp, colons written as dashes
```

The machine that ran the task writes it, in the data folder, so the existing sync carries it to the Worker and every
client reads the same file — no new request path, no new timer. `cloud/src/runs.ts` holds the shape and the key,
`src/runlog.ts` reads the process out of the run's log and writes it.

```
{ id, at, host, cli, model, status, summary, exit, steps: [{at?, kind: "tool"|"say"|"fail", name?, text}], dropped? }
```

`steps` is the run in order: `tool` is a call (`Read · src/cli.ts`, `Bash · Run the tests`), `say` is what the agent
told the owner, `fail` is a call that came back an error (its own line, with the error under it). A very long run keeps
its first 40 steps and its newest 360, and `dropped` says how many were left out of the middle — the panel never claims
a sequence it does not have. Each step is clipped to 700 characters.

The file is written **once, when the run ends**. Rewriting it while the run goes on would cost a row a minute on the
free plan for a panel nobody may open, and `test/budget.test.ts` has no room for that; a run record is read after the
fact. A run opened while it is still going shows its latest step and says the process is kept when it ends; the panel
reads the file once more when the task stops being active (the status frame says so), so it appears without reopening.

Only the newest `RUN_KEEP` (12) processes of a task stay: its task file names the last five runs, so nothing older is
reachable. Runs recorded before this existed have no file, and the panel says so.

## Reading it

`GET /api/files/read?path=runs/<T-id>/<stamp>.json` — `runs/` is one of the owner-readable prefixes
(`cloud/src/files.ts`), so a phone or a Mac reads it like any report; the run logs themselves (`logs/runs/*.log`) stay
machine-only and are never synced. `runs/` is also `latestOnly` (`cloud/src/budget.ts`): every write was a full copy of
the whole process, so its history is worth nothing.

The task's `run_at` (its metadata, shown by both task views) is the stamp of the run going on now or of the last one,
which is how the panel knows what to ask for before the run's `## Run <at>` line exists.

## Cost

One small file per run, written once and riding the push that already reports the result: no extra request, and nothing
at all while no task runs. Reading it is one request and one row when the owner opens it. `test/budget.test.ts` simulates
the write for every task of its fleet day, so the cost is metered rather than assumed.
