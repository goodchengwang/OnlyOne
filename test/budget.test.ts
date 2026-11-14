// Hard rule: OnlyOne runs on Cloudflare's free plan (cloud/src/budget.ts, AGENTS.md). One simulated fleet day — three
// machines ticking every minute, three idle guest workers, each writing a heartbeat and journal lines and working through tasks — must stay
// under TARGET (a fifth of the free plan) in requests and rows written. Raising a pace or adding a sync round trip
// that breaks this needs a design change, not a bigger number here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUEST_IDLE_MS, LAZY_PUSH_MS, PULL_MIN_MS, TARGET } from "../cloud/src/budget";
import * as sync from "../src/sync";

const HOSTS = ["h1", "h2", "h3"], TASKS_PER_HOST = 40, DAY_MIN = 24 * 60;
/** Cloudflare bills index rows too: files (pk + rev index) and history (pk + path index) roughly triple SQLite's count. */
const INDEX_FACTOR = 3;
/** Traffic outside the files API on the same day (src/cloud.ts, app/App.tsx): dashboard pushes on every shape change
 *  plus one every ~15 min, two inbox reads per owner message, owner sends, socket pings at 1/20 of a request, and the
 *  owner app's status fetch on each reconnect. Each costs about two rows written where it writes at all. */
const CHANNEL_REQUESTS = (HOSTS.length * TASKS_PER_HOST * 2 + 1) * 3; // three owner clients, pushed membership changes only
const OTHER_REQUESTS = CHANNEL_REQUESTS + (HOSTS.length * TASKS_PER_HOST * 2 + 96) + 50 * 3 + Math.ceil(DAY_MIN / 20) + 50;
/** Three guest workers running as services all day (src/guest.ts): one request per idle ask, and the Worker rewrites
 *  each guest's last_seen (no index on it) at most once a minute, so at most one row per ask. */
const GUESTS = 3, GUEST_ASKS = GUESTS * Math.ceil(DAY_MIN * 60_000 / GUEST_IDLE_MS);
// The receipt index only includes owner sends with client_id; fleet events add no index rows.
// Three fresh computer enrollments in a day: start + verify + join + logout + status + initial file pull.
// Allow 100 written rows each (auth rows, indexed security/join events, first coordinator CAS and usage saves).
// These are user actions, never a timer: an unattended installation adds zero enrollment requests or writes.
const ENROLL_REQUESTS = HOSTS.length * 6, ENROLL_ROWS = HOSTS.length * 100;
// Active source development: ten valid reloads/hour for eight hours on all three Macs.
// Development lifecycle messages stay local and reloads do not force lazy heartbeat/journal uploads.
// Validation/debouncing is local; reserve eight requests and 16 indexed rows for reconnect/state/usage per reload.
// With no saves there are no reload requests, rows or cloud timers.
const DEV_RELOADS = HOSTS.length * 8 * 10, DEV_REQUESTS = DEV_RELOADS * 8, DEV_ROWS = DEV_RELOADS * 16;
// Two owner-requested version switches or stop/start cycles per Mac/day: conservatively allow 16 lifecycle/
// reconnect requests and 32 indexed writes each. Status queries and opening an unchanged version stay local.
const SERVICE_CHANGES = HOSTS.length * 2, SERVICE_REQUESTS = SERVICE_CHANGES * 16, SERVICE_ROWS = SERVICE_CHANGES * 32;
// Three owner-created members/routines per day: each of three clients fetches the avatar and (if open) settings
// once, plus one state push per change (2 rows). File traffic is measured below; no unattended requests/writes.
// Three manual project creations/day; each writes metadata, initial memory and index (measured below).
// Three clients refresh the shared channel snapshot once per creation; its first message may pull the new record once.
// Plus 20 memory opens/client/day.
// No project timer: unattended cost is zero. Reads write no rows; reserve 2 metering rows per owner request.
const PROJECT_REQUESTS = 3 * (1 + HOSTS.length + 1) + HOSTS.length * 20, PROJECT_ROWS = PROJECT_REQUESTS * 2;
const TEAM_REQUESTS = 3 * (3 + 3 + 1), TEAM_ROWS = 3 * 2;
const RECEIPT_ROWS = 50;
const OTHER_ROWS = RECEIPT_ROWS + (HOSTS.length * TASKS_PER_HOST * 2 + 96) * 2 + 50 * 6 + 2_000; // + events the fleet reports

let W = "", t: sync.Transport;
const saved = { ...sync.syncTiming };
beforeAll(async () => {
  W = mkdtempSync(join(tmpdir(), "onlyone-budget-"));
  // All hosts share this transport in one process; durability is irrelevant to billing.
  // Avoid thousands of disk fsyncs on macOS while exercising the same Worker SQL.
  t = await sync.fakeTransport(":memory:", "budget");
});
afterAll(() => { Object.assign(sync.syncTiming, saved); try { rmSync(W, { recursive: true, force: true }); } catch {} });

test("a fleet day stays under the free-plan target", async () => {
  let clock = Date.parse("2026-11-07T00:00:00Z");
  Object.assign(sync.syncTiming, { now: () => clock, pullMinMs: PULL_MIN_MS, lazyPushMs: LAZY_PUSH_MS });
  const dirs = Object.fromEntries(HOSTS.map((h) => { const d = join(W, h, "data"); mkdirSync(d, { recursive: true }); return [h, d]; }));
  const as = (h: string) => { sync.setSyncData(dirs[h]); sync.setTransport(t); return dirs[h]; };
  for (const [h, d] of Object.entries(dirs)) {
    mkdirSync(join(d, "channels"), { recursive: true });
    writeFileSync(join(d, "channels", `${h}-quality.md`), `---\nname: ${h} quality\ngoal: Reliability\nstatus: active\n---\n`);
  }
  const workAt = new Set(Array.from({ length: TASKS_PER_HOST }, (_, i) => Math.floor((i + 0.5) * DAY_MIN / TASKS_PER_HOST)));

  for (let minute = 0; minute < DAY_MIN; minute++) {
    for (const [i, h] of HOSTS.entries()) {
      const d = as(h);
      await sync.pull(); // the tick
      mkdirSync(join(d, "fleet", "hosts"), { recursive: true });
      writeFileSync(join(d, "fleet", "hosts", `${h}.json`), JSON.stringify({ host: h, seen: new Date(clock).toISOString(), busy: 0 }));
      mkdirSync(join(d, "journal"), { recursive: true });
      appendFileSync(join(d, "journal", "2026-11-07.md"), `- ${minute} [${h}] tick\n`);
      if (workAt.has(minute)) { // one task: claimed, then finished a little later in the same minute, as a quick task would
        const id = `T-${i}${String(minute).padStart(4, "0")}`;
        mkdirSync(join(d, "tasks", "active"), { recursive: true }); mkdirSync(join(d, "tasks", "done"), { recursive: true });
        writeFileSync(join(d, "tasks", "active", `${id}.md`), `---\nid: ${id}\nchannels: ${h}-quality\n---\nwork\n`);
        await sync.pull(); expect(await sync.commitPush(`claim ${id}`)).toBe(true);
        appendFileSync(join(d, "journal", "2026-11-07.md"), `- ${minute} [${h}] ✅ ${id}\n`);
        renameSync(join(d, "tasks", "active", `${id}.md`), join(d, "tasks", "done", `${id}.md`));
        await sync.pull(); expect(await sync.commitPush(`done ${id}`)).toBe(true);
      }
      await sync.commitPush("tick");
    }
    clock += 60_000;
  }

  // One owner-requested npm update on each machine: existing progress, drain and ready reports.
  // Downloads go to npm, not the Worker. No new idle timer or forced background heartbeat is added.
  for (const h of HOSTS) {
    const d = as(h);
    for (const state of ["updating", "waiting", "restarting", "done"]) {
      clock += PULL_MIN_MS;
      await sync.pull();
      writeFileSync(join(d, "fleet", "hosts", `${h}.json`), JSON.stringify({ host: h, seen: new Date(clock).toISOString(), busy: 0, update: { state } }));
      await sync.commitPush(`owner update ${state}`, { force: true });
    }
  }

  for (let i = 0; i < 3; i++) {
    const d = as(HOSTS[0]);
    clock += PULL_MIN_MS;
    await sync.pull();
    const id = `content-${i}`;
    mkdirSync(join(d, "agents", id), { recursive: true });
    writeFileSync(join(d, "agents", id, "profile.md"), `# ${id}\nName: ${id}\nContent research\n`);
    writeFileSync(join(d, "agents", id, "member.json"), JSON.stringify({ id, name: id, avatar: "hash" }));
    writeFileSync(join(d, "agents", id, "avatar.image"), new Uint8Array(32_000));
    appendFileSync(join(d, "journal", "2026-11-07.md"), `- member ${id} saved\n`);
    expect(await sync.commitPush(`owner member ${id}`)).toBe(true);
    writeFileSync(join(d, "settings.json"), JSON.stringify({ routines: { [`daily-${i}`]: { agent: id, every: "weekdays 09:00", prompt: "Report topics" } } }));
    appendFileSync(join(d, "journal", "2026-11-07.md"), `- routine daily-${i} saved\n`);
    expect(await sync.commitPush(`owner routine daily-${i}`)).toBe(true);
    for (const h of HOSTS.slice(1)) { as(h); await sync.pull(); }
  }
  // Project records and subsequent memory changes use the same CAS/sync paths as actual owner-created files.
  as(HOSTS[0]);
  for (let i = 0; i < 3; i++) {
    const id = `prj-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const dir = join(dirs[HOSTS[0]], "projects", id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.md"), `---\nid: ${id}\nname: Project ${i}\nhost: h1\nrepo: /work/${i}\ncreated: 2026-11-07T00:00:00Z\n---\n`);
    writeFileSync(join(dir, "memory.md"), "# Project memory\n");
    mkdirSync(join(dirs[HOSTS[0]], "memory"), { recursive: true });
    writeFileSync(join(dirs[HOSTS[0]], "memory/projects.md"), `# ${i + 1} owner-created projects\n`);
    expect(await sync.commitPush("owner created project")).toBe(true);
    for (let n = 0; n < 20; n++) {
      appendFileSync(join(dir, "memory.md"), `- Project lesson ${n}\n`);
      expect(await sync.commitPush("project lesson")).toBe(true);
    }
    for (const h of HOSTS.slice(1)) { as(h); await sync.pull(); }
    as(HOSTS[0]);
  }
  clock += LAZY_PUSH_MS;
  expect(await sync.commitPush("flush batched project lessons")).toBe(true);
  const requests = t.meter!.requests + OTHER_REQUESTS + GUEST_ASKS + ENROLL_REQUESTS + DEV_REQUESTS + TEAM_REQUESTS + SERVICE_REQUESTS + PROJECT_REQUESTS;
  const rowsWritten = t.meter!.rowsWritten * INDEX_FACTOR + OTHER_ROWS + GUEST_ASKS + ENROLL_ROWS + DEV_ROWS + TEAM_ROWS + SERVICE_ROWS + PROJECT_ROWS;
  console.log(`fleet day: ${requests} requests (target ${TARGET.requests}), ~${rowsWritten} rows written (target ${TARGET.rowsWritten})`);
  expect(requests).toBeLessThanOrEqual(TARGET.requests);
  expect(rowsWritten).toBeLessThanOrEqual(TARGET.rowsWritten);
}, 600_000); // filesystem-bound (~4k lock/state writes): ~2 min on a busy Mac with a nearly full disk, so 120 s was too tight
