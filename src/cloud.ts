// Cloud bridge: connects the fleet to the owner's own Cloudflare Worker (cloud/). Outbound HTTPS only.
//   primary: mirrors every feed event up, pulls the owner's messages/settings down, pushes status + settings snapshots.
//   workers: forward events/media straight to the Worker (cfg.server.url points there).
// `onlyone cloud deploy` deploys the Worker into the owner's Cloudflare account (wrangler login once) and records the URL.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Cfg, L, P, _commitPush, hostName, journal, locked, HOME_DIR } from "./core";
import { updateChannel } from "./channels";
import { queueSideTurn } from "./side";
import { type Event, MEDIA, appendEvent, applyOp, handleOwnerMessage, saveSettings, setMirror, settingsView, status, cancelTask, updateFleet } from "./server";

const base = (cfg: Cfg) => String(cfg.cloud?.url ?? "").replace(/\/$/, "");
const headers = (cfg: Cfg) => ({ Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" });

async function call(cfg: Cfg, path: string, init: RequestInit = {}, timeoutMs = 15_000) {
  const r = await fetch(base(cfg) + path, { ...init, headers: headers(cfg), signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!r?.ok) return null;
  return r.json() as Promise<any>;
}

/** One of the Worker's media files ("/media/<id>": the owner's uploaded images), as bytes. */
export async function cloudMedia(cfg: Cfg, path: string): Promise<Uint8Array | null> {
  if (!/^\/media\/[\w.\-]+$/.test(path)) return null;
  const r = await fetch(base(cfg) + path, { headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

/** Primary: run the bridge loop. */
export function startCloudBridge(cfg: Cfg) {
  if (!base(cfg) || !cfg.server?.token) return;
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const pending: Event[] = [];
  // an event's images live in this machine's media folder ("/media/<name>"): upload them first, then point the event at the copies
  const upload = async (url: string): Promise<string | null> => {
    const f = join(MEDIA, basename(url));
    if (!url.startsWith("/media/") || !existsSync(f)) return url;
    const fd = new FormData();
    fd.append("file", Bun.file(f), basename(f));
    const r = await fetch(base(cfg) + "/api/media", { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    return r?.ok ? ((await r.json()) as { url: string }).url : null;
  };
  const flush = async () => {
    while (pending.length) {
      const e = pending[0];
      if (e.attachments?.length) {
        const urls = await Promise.all(e.attachments.map(upload));
        if (urls.some((u) => !u)) return; // retry on the next poll
        pending[0] = { ...e, attachments: urls as string[] };
      }
      if (!(await call(cfg, "/api/events", { method: "POST", body: JSON.stringify(pending[0]) }))) return;
      pending.shift();
    }
  };
  setMirror((e) => { pending.push(e); void flush(); });

  // the inbox cursor and the ids already handled survive restarts: the Worker only drops a message once a later poll
  // acks it, so a daemon restarting mid-batch got the same owner messages again and made duplicate tasks (T-0641)
  const cursorFile = join(HOME_DIR, "cloud-inbox.json");
  const saved = (() => { try { return JSON.parse(readFileSync(cursorFile, "utf8")); } catch { return {}; } })();
  const sameOnlyOne = saved.url === base(cfg);
  const seen: string[] = Array.isArray(saved.seen) ? saved.seen : [];
  const saveCursor = () => { try { writeFileSync(cursorFile, JSON.stringify({ url: base(cfg), after, seen: seen.slice(-500) })); } catch {} };
  let after = sameOnlyOne ? Number(saved.after) || 0 : 0, n = 0, busy = false, lastStatus = "", lastShape = "", lastPush = 0;
  let watchers = 1; // owner clients connected (the Worker reports it); until it says otherwise, assume someone looks
  // push the dashboard at once when its shape changes (an answered decision must leave "待你决定" at once); live agent
  // activity alone is pushed at most once a minute and only while an owner client is open; an unchanged dashboard
  // every ~15 min (Cloudflare free plan: cloud/src/budget.ts)
  const pushStatus = async (force = false) => {
    // A new avatar must finish syncing before a status frame makes clients request its image.
    const view = await locked(() => ({ status: status(), settings: settingsView() }));
    const s = view.status;
    const st = JSON.stringify(s);
    const shape = JSON.stringify({ ...s, active: s.active.map(({ activity: _, ...t }) => t) });
    const due = shape !== lastShape || (watchers > 0 && st !== lastStatus && Date.now() - lastPush > 60_000) || force;
    if (!due) return;
    const r = await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify(view) });
    if (r) { lastStatus = st; lastShape = shape; lastPush = Date.now(); if (typeof r.watchers === "number") watchers = r.watchers; }
  };
  // housekeeping every few seconds: mirror events up, push the dashboard (both cost nothing when nothing changed)
  const loop = async () => {
    if (busy || stopped) return; busy = true;
    try {
      await flush();
      await pushStatus(n++ % 300 === 0); // a forced re-push every ~15 min; the Worker skips unchanged writes
      if (!live && Date.now() - lastDrain > 60_000) void drain(); // no socket: poll the inbox once a minute
    } catch (err) { console.error(`cloud bridge: ${err}`); }
    busy = false;
  };
  // the owner→fleet inbox. A hibernating WebSocket carries a nudge per item (the Durable Object sleeps in between, and
  // pings are answered without waking it), then the items come over plain GETs, so the chat brain here gets an owner
  // message within milliseconds (the owner's model login never leaves this machine; only the message and the reply travel)
  let live = false, lastDrain = 0, draining = false, again = false;
  const handle = async (it: any) => {
    if (it.type === "message") {
      const e = it.event as Event;
      const fresh = claimInboxMessage(seen, e.id); // redelivered (restart, Worker switch): already handled
      after = it.seq; saveCursor(); // before handling, so a restart mid-message doesn't replay it
      if (!fresh) return;
      appendEvent(e, { mirror: false }); // keep the local record (learning reads it); the cloud already has it
      await handleOwnerMessage(e.text, e.ref, false, { paths: e.attachments, key: e.id, fetch: (p) => cloudMedia(cfg, p), sentAt: e.ts, thread: e.thread, channel: e.channel });
    } else if (it.type === "op" && it.op) {
      await applyOp(it.op);
    } else if (it.type === "cancel" && typeof it.id === "string") {
      await cancelTask(it.id, it.done === true);
    } else if (it.type === "channel" && typeof it.slug === "string") {
      await locked(async () => { if (typeof updateChannel(it.slug, it) !== "string") await _commitPush(`channel ${it.slug}`); });
    } else if (it.type === "side" && typeof it.conv === "string" && typeof it.id === "string" && typeof it.text === "string") {
      // a side-chat turn runs beside the drain, one at a time, so a slow answer never delays the owner's messages
      queueSideTurn({ conv: it.conv, id: it.id, text: it.text, at: typeof it.at === "string" ? it.at : new Date().toISOString() });
    } else if (it.type === "update") {
      await updateFleet();
    } else if (it.type === "settings") {
      await saveSettings(it.patch);
      await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ settings: settingsView() }) });
    }
    after = it.seq; saveCursor();
  };
  /** Fetch and handle inbox items until none are left (each call also acks what came before `after`). */
  const drain = async () => {
    if (stopped) return;
    if (draining) { again = true; return; }
    draining = true; lastDrain = Date.now();
    try {
      do {
        again = false;
        for (let page = 0; page < 20; page++) {
          if (stopped) break;
          const r = await call(cfg, `/api/host/inbox?after=${after}`);
          const items = r?.items ?? [];
          for (const it of items) { if (stopped) break; await handle(it); }
          if (!items.length) break;
          await pushStatus();
        }
      } while (again && !stopped);
    } catch (err) { console.error(`cloud bridge inbox: ${err}`); }
    draining = false;
  };
  let backoff = 5_000;
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(base(cfg).replace(/^http/i, "ws") + "/api/host/stream", { headers: { Authorization: `Bearer ${cfg.server?.token}` } } as any);
    socket = ws;
    let ping: ReturnType<typeof setInterval> | undefined, pong = Date.now();
    ws.onopen = () => {
      live = true; backoff = 5_000; pong = Date.now();
      // keep NAT paths open and notice a dead link; the Worker answers "ping" without waking up
      ping = setInterval(() => { if (Date.now() - pong > 150_000) ws.close(); else try { ws.send("ping"); } catch {} }, 60_000);
      void drain(); // whatever arrived while disconnected
    };
    ws.onmessage = (m) => {
      pong = Date.now();
      let d: any; try { d = JSON.parse(String(m.data)); } catch { return; } // "pong"
      if (d?.type === "inbox") void drain();
      else if (d?.type === "watchers" && typeof d.n === "number") { const was = watchers; watchers = d.n; if (d.n > was) void pushStatus(true); }
    };
    ws.onclose = () => {
      live = false; clearInterval(ping);
      if (!stopped) reconnect = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    };
    ws.onerror = () => {};
  };
  void loop();
  connect();
  const timer = setInterval(loop, (cfg.cloud?.poll_seconds ?? 3) * 1000);
  console.log(`cloud bridge → ${base(cfg)}`);
  return async () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(reconnect);
    socket?.close();
    // Finish the current message, leave later inbox items queued, then upload its replies.
    while (draining || busy) await Bun.sleep(50);
    await flush();
  };
}

/** [cloud] allow_ips (a string or a list of IPs / CIDRs) → the ONLYONE_ALLOW_IPS secret ("" = no IP restriction).
 *  undefined when config.toml has no allow_ips at all: a deploy then leaves the Worker's list as it is, so a machine
 *  whose config is behind (not synced yet) cannot switch the allow-list off by redeploying. */
export function allowIps(cfg: Cfg): string | undefined {
  if (!cfg.cloud || !("allow_ips" in cfg.cloud)) return undefined;
  const v = cfg.cloud?.allow_ips;
  return (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean).join(",");
}

/** Why the last cloudDeploy returned false (for the journal: a daemon's console is out of the owner's sight). */
export let lastDeployError = "";

/** Explicit deployment shares the standalone path and never changes this executor's identity. */
export async function cloudDeploy(_cfg: Cfg) {
  lastDeployError = "";
  try { return await (await import("../cloud/deploy")).deployCloud(); }
  catch (error) { lastDeployError = error instanceof Error ? error.message : "Cloud deployment failed"; console.error(lastDeployError); return false as const; }
}

/** Record an owner message id as handled; false when it was already handled (a replay after a restart or Worker switch). */
export function claimInboxMessage(seen: string[], id?: string): boolean {
  if (!id) return true;
  if (seen.includes(id)) return false;
  seen.push(id);
  return true;
}
