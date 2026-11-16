// A run's whole process, as the panel beside a conversation shows it (docs/run-trace.md).
// The machine that ran it writes one small JSON file into the data folder (runs/<T-id>/<stamp>.json), where the sync
// already carries it to the Worker, so every client reads the same trace: no new request path, no timer, nothing
// while nobody opens it.

/** One step of a run: what the agent did, in order. `tool` names the tool it called; `say` is what it told the owner;
 *  `fail` is a tool call that came back an error. */
export type RunStep = { at?: string; kind: "tool" | "say" | "fail"; name?: string; text: string };

/** A run from start to finish: who ran it, how it ended, and every step it took. `dropped` counts steps trimmed out
 *  of the middle of a very long run, so the panel never claims to show a sequence it does not have. */
export type RunTrace = {
  id: string; at: string; host?: string; cli?: string; model?: string;
  status?: string; summary?: string; exit?: number;
  steps: RunStep[]; dropped?: number;
};

/** A step is one line; 700 keeps even a long run's file in the tens of kilobytes, so syncing it stays cheap. */
export const RUN_STEP_MAX = 400;
/** How many steps survive in the middle of a very long run: the opening and the tail say what happened. */
export const RUN_STEP_HEAD = 40;
/** Traces kept per task: its task file names the last five runs, so nothing older is reachable anyway. */
export const RUN_KEEP = 12;

/** Where a run's trace lives, keyed by the `## Run <at>` stamp the task file already carries. */
export const runPath = (id: string, at: string) => `runs/${id}/${at.replace(/[^\w]+/g, "-")}.json`;

/** Keep the first steps and the newest ones when a run is longer than one file should hold. */
export function trimSteps(steps: RunStep[]): { steps: RunStep[]; dropped?: number } {
  if (steps.length <= RUN_STEP_MAX) return { steps };
  const tail = steps.slice(-(RUN_STEP_MAX - RUN_STEP_HEAD));
  return { steps: [...steps.slice(0, RUN_STEP_HEAD), ...tail], dropped: steps.length - RUN_STEP_HEAD - tail.length };
}
