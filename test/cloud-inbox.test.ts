import { expect, test } from "bun:test";
import { claimInboxMessage, startCloudBridge } from "../src/cloud";
import { handleOwnerMessage, setApplyOp, startServer } from "../src/server";
import { locked, P } from "../src/core";
import { mkdirSync } from "node:fs";

test("a replayed owner message id is handled once, also after the seen list is reloaded", () => {
  const seen: string[] = [];
  expect(claimInboxMessage(seen, "m1")).toBe(true);
  expect(claimInboxMessage(seen, "m1")).toBe(false);
  const reloaded = JSON.parse(JSON.stringify({ seen })).seen as string[]; // cloud-inbox.json round trip, any onlyone url
  expect(claimInboxMessage(reloaded, "m1")).toBe(false);
  expect(claimInboxMessage(reloaded, "m2")).toBe(true);
  expect(claimInboxMessage(reloaded, undefined)).toBe(true);
});

test("an outbound-only executor still handles owner messages", async () => {
  const messages: string[] = [];
  startServer({ server: { enabled: false } }, async (text) => { messages.push(text); });
  await handleOwnerMessage("a message delivered by the cloud");
  expect(messages).toEqual(["a message delivered by the cloud"]);
});

test("bridge shutdown finishes the current item and leaves later inbox items queued", async () => {
  const handled: number[] = [];
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  setApplyOp(async (op) => { handled.push(op.id); entered(); await waiting; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/api/host/stream" && server.upgrade(request)) return;
    if (path === "/api/host/inbox") return Response.json({ items: [1, 2].map((id) => ({ type: "op", seq: id, op: { id } })) });
    return Response.json({ watchers: 0 });
  }, websocket: { message() {} } });
  const stop = startCloudBridge({ cloud: { url: server.url.origin }, server: { token: "test" } })!;
  try {
    await started;
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(handled).toEqual([1]);
  } finally { finish(); await stop(); server.stop(true); }
});

test("status frames wait for file commits so an advertised avatar is already available", async () => {
  mkdirSync(P("agents"), { recursive: true });
  let release!: () => void, entered!: () => void, stateSeen!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  const seen = new Promise<void>((r) => { stateSeen = r; });
  let committed = false, writes = 0;
  const commit = locked(async () => { entered(); await hold; committed = true; });
  await started;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/api/host/stream" && server.upgrade(request)) return;
    if (path === "/api/host/state") { writes++; expect(committed).toBe(true); stateSeen(); }
    return Response.json({ items: [], watchers: 0 });
  }, websocket: { message() {} } });
  const stop = startCloudBridge({ cloud: { url: server.url.origin }, server: { token: "test" } })!;
  try {
    await Bun.sleep(20);
    expect(writes).toBe(0);
    release();
    await Promise.race([seen, Bun.sleep(2000).then(() => { throw new Error("No status frame after commit"); })]);
    expect(writes).toBeGreaterThan(0);
  } finally { release(); await commit; await stop(); server.stop(true); }
});
