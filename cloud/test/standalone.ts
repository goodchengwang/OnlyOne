// Run against standalone.toml on a fresh --persist-to directory; mail and SQL controls exist only in its test entrypoint.
import assert from "node:assert/strict";
import { templateFiles } from "../deploy";
import { pkceChallenge } from "../src/mcp";

const base = process.argv[2] ?? "http://127.0.0.1:8798";
const owner = "owner@example.com", machine = "test-machine";
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; console.log(`✓ ${message}`); };
async function api(path: string, body?: unknown, token?: string, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const control = (body: unknown) => api("/api/test", body, machine);
const reset = async () => {
  await control({ sql: "DELETE FROM auth_sends" });
  await control({ sql: "DELETE FROM auth_codes" });
  await control({ sql: "DELETE FROM kv WHERE k = 'auth_fails'" });
};
const code = async () => {
  const { data } = await api("/api/test", undefined, machine);
  const email = data.mail.toReversed().find((mail: any) => /验证码：|login code:/.test(mail.subject));
  return email.subject.match(/[A-HJKMNP-Z2-9]{8}$/)[0] as string;
};
const start = () => api("/api/auth/start", { email: owner });
const verify = (value: string) => api("/api/auth/verify", { email: owner, code: value });

check((await fetch(base)).status === 200, "static app is accessible without an executor");
check((await api("/api/status")).status === 401, "status requires authentication");
check((await api("/api/host/security", undefined, machine)).data.login === "email", "email login needs no authenticator binding");
check((await api("/api/files/commit", { msg: "seed", changes: templateFiles(base, owner) }, machine)).status === 200, "initialize templates without a local executor");
check((await api("/api/status", undefined, machine)).data.onlyone.primary === "", "new cloud waits for its first computer");
check(Array.isArray((await api("/api/status", undefined, machine)).data.active), "zero-executor status includes the complete dashboard shape");
check((await api("/api/settings", undefined, machine)).data.effective.autonomy === "onboarding", "default settings are available before an executor connects");
await control({ env: { ONLYONE_OWNER_EMAIL: "" } });
check((await start()).status === 403, "missing owner configuration fails closed");
await control({ env: { ONLYONE_OWNER_EMAIL: owner, ONLYONE_RESEND_API_KEY: "" } });
check((await start()).status === 503, "missing mail configuration never falls back to a host code");
await control({ env: { ONLYONE_RESEND_API_KEY: "test-resend" } });
check((await api("/api/auth/start", { email: "stranger@example.com" })).status === 403, "non-owner is denied");
check((await api("/api/test", undefined, machine)).data.mail.length === 0, "non-owner causes no email");
check((await start()).status === 200, "Resend receives the first login email");
const firstCode = await code();
check((await start()).status === 429, "resend is limited to once per minute");
check((await verify(firstCode === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA")).status === 401, "wrong email code is rejected");
const replay = await Promise.all([verify(firstCode.toLowerCase()), verify(firstCode)]);
check(replay.filter((result) => result.status === 200).length === 1, "a concurrent code replay creates exactly one session");
const session = replay.find((result) => result.status === 200)!.data.session;
check((await api("/api/status", undefined, session)).status === 200, "email-only session opens the dashboard");
const pending = await api("/api/messages", { text: "queued before any computer", client_id: "standalone-before-join" }, session);
check(pending.status === 200, "owner can enqueue work before connecting a computer");
const duplicate = await api("/api/messages", { text: "queued before any computer", client_id: "standalone-before-join" }, session);
check(duplicate.data.id === pending.data.id, "retrying a message reuses the receipt");
check((await api("/api/feed", undefined, session)).data.events.some((event: any) => /尚未接入执行电脑/.test(event.text)), "feed explains that execution is waiting");
const joins = await Promise.all([api("/api/host/join", { host: "mac" }, session), api("/api/host/join", { host: "linux" }, session)]);
check(joins.every((result) => result.status === 200 && result.data.token === machine) && joins[0].data.primary === joins[1].data.primary, "parallel computer joins choose one fixed coordinator");
check((await api("/api/host/join", { host: "third" }, session)).data.primary === joins[0].data.primary, "later joins do not replace the coordinator");
check((await api("/api/host/join", { host: "bad\nhost" }, session)).status === 400, "invalid host names are rejected");
const filesBefore = await api("/api/files/changes?since=0", undefined, machine);
check((await api("/api/files/commit", { msg: "seed again", changes: templateFiles(base, owner) }, machine)).status === 409, "reinitialization cannot overwrite an existing installation");
check((await api("/api/files/changes?since=0", undefined, machine)).data.rev === filesBefore.data.rev, "failed reinitialization changes no data");

const avatarPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
check((await api("/api/files/commit", { msg: "member avatar", changes: [
  { path: "agents/content-editor/avatar.image", base_version: 0, content: avatarPng },
] }, machine)).status === 200, "member avatar uses the durable fleet file store");
const avatarUrl = base + "/api/files/avatar?agent=content-editor&v=1";
const avatar = await fetch(avatarUrl, { headers: { Authorization: `Bearer ${session}` } });
check(avatar.status === 200 && avatar.headers.get("content-type") === "image/png", "an owner session can render a member avatar");
check(Buffer.from(await avatar.arrayBuffer()).toString("base64") === avatarPng, "avatar bytes survive Worker SQLite storage");
check((await fetch(avatarUrl)).status === 401, "member avatars require authentication");
check((await fetch(base + "/api/files/avatar?agent=../content-editor", { headers: { Authorization: `Bearer ${session}` } })).status === 400, "avatar traversal is rejected");

const ownerSocket = new WebSocket(base.replace("http", "ws") + `/api/stream?v=2&token=${session}`);
const hostSocket = new WebSocket(base.replace("http", "ws") + "/api/host/stream", { headers: { Authorization: `Bearer ${machine}` } });
const frames: any[] = [];
ownerSocket.onmessage = (event) => { try { frames.push(JSON.parse(String(event.data))); } catch {} };
const opened = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("WebSocket timed out")), 5000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed")); }, { once: true });
});
try {
  await Promise.all([opened(ownerSocket), opened(hostSocket)]);
  check((await api("/api/status", undefined, session)).data.onlyone.online, "host socket makes the coordinator online");
  const inbox = (await api("/api/host/inbox?after=0", undefined, machine)).data.items;
  check(inbox.filter((item: any) => item.event?.id === pending.data.id).length === 1, "reconnecting host receives queued work exactly once in its inbox");
  const last = inbox.at(-1).seq;
  check((await api(`/api/host/inbox?after=${last}`, undefined, machine)).data.items.length === 0, "acknowledged work is removed from the inbox");
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(frames.some((frame) => frame.$status?.onlyone?.online), "owner receives pushed status without polling");
} finally { ownerSocket.close(); hostSocket.close(); }

await reset();
await start();
await control({ sql: "UPDATE auth_codes SET expires = 0" });
check((await verify(await code())).status === 401, "expired code is rejected");
await reset();
await start();
const locked = await code();
for (let index = 0; index < 5; index++) await verify(locked === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA");
check((await verify(locked)).status === 401, "five wrong guesses lock even the correct code");
await reset();
for (let index = 0; index < 10; index++) await control({ sql: "INSERT INTO auth_sends (email, ts, sent) VALUES (?, ?, 1)", bindings: [owner, Date.now() - 120_000] });
check((await start()).status === 429, "hourly email limit is enforced across sends");
await reset();
await start();
const dailyCode = await code();
await control({ sql: "INSERT OR REPLACE INTO kv (k, v) VALUES ('auth_fails', ?)", bindings: [JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 20 })] });
check((await verify(dailyCode)).status === 429, "daily failed-verification lock is enforced");
for (const mode of ["fail", "timeout"]) {
  await reset();
  await control({ mode });
  check((await start()).status === 502, `Resend ${mode} returns a delivery failure`);
  await control({ mode: "ok" });
  check((await verify(await code())).status === 401, `Resend ${mode} leaves no usable code`);
}

await reset();
const redirect = "http://localhost:6274/oauth/callback";
const client = (await api("/oauth/register", { redirect_uris: [redirect], client_name: "standalone test" })).data;
const verifier = crypto.randomUUID() + crypto.randomUUID();
const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "test" });
const form = (step: string, fields: Record<string, string> = {}) => fetch(base + "/oauth/authorize", {
  method: "POST", body: new URLSearchParams({ ...Object.fromEntries(params), email: owner, step, ...fields }), redirect: "manual",
});
const codePage = await (await form("send")).text();
check(codePage.includes('name="code"') && !codePage.includes('name="totp"'), "OAuth requests only the emailed code");
const authorized = await form("verify", { code: await code() });
check(authorized.status === 302, "email code authorizes OAuth");
const authCode = new URL(authorized.headers.get("location")!).searchParams.get("code");
const access = (await api("/oauth/token", { grant_type: "authorization_code", code: authCode, client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier })).data.access_token;
check(!!access, "PKCE token exchange succeeds");
check((await api("/api/status", undefined, access)).status === 403, "MCP token cannot access owner APIs");
check((await api("/api/host/join", { host: "intruder" }, access)).status === 403, "MCP token cannot obtain a machine credential");
check((await api("/api/auth/logout", {}, session)).status === 200, "owner can log out");
check((await api("/api/status", undefined, session)).status === 401, "logged-out session is invalid");
// Real workerd accounting, in addition to the whole-day fleet simulation.
let enrollRequests = 0, enrollWrites = 0;
for (let index = 0; index < 3; index++) {
  await reset();
  const before = (await api("/api/usage", undefined, machine)).data;
  await start();
  const login = (await verify(await code())).data.session;
  await api("/api/host/join", { host: `budget-${index}` }, login);
  await api("/api/auth/logout", {}, login);
  await api("/api/status", undefined, machine);
  await api("/api/files/changes?since=0", undefined, machine);
  const after = (await api("/api/usage", undefined, machine)).data;
  // Subtract measurement and captured-mail retrieval requests; they are harness-only.
  enrollRequests += after.requests - before.requests - 2;
  enrollWrites += after.rowsWritten - before.rowsWritten;
}
check(enrollRequests <= 18 && enrollWrites <= 300, `three enrollments fit the reserved budget (${enrollRequests} requests, ${enrollWrites} written rows)`);
console.log(`${checks} standalone Worker checks passed`);
