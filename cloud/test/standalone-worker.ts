// Test-only entrypoint. Never use this configuration for deployment.
import worker, { OnlyOne } from "../src/index";

let mode = "ok";
const mail: any[] = [];
const networkFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  if (String(input) !== "https://api.resend.com/emails") {
    if (new URL(String(input)).origin === "http://127.0.0.1:2626") return networkFetch(input, init);
    throw new Error("Unexpected outbound test request");
  }
  if (mode === "timeout") throw new DOMException("Timed out", "TimeoutError");
  if (mode === "fail") return new Response("provider failure", { status: 503 });
  mail.push(JSON.parse(init.body));
  return Response.json({ id: crypto.randomUUID() });
}) as typeof fetch;

export class TestOnlyOne extends OnlyOne {
  async handle(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/api/test") {
      if (req.headers.get("authorization") !== "Bearer test-machine") return new Response(null, { status: 403 });
      if (req.method === "GET") return Response.json({ mail });
      const body = await req.json() as any;
      if (body.mode) mode = body.mode;
      if (body.env) Object.assign(this.env, body.env);
      if (body.sql) { this.sql.exec(body.sql, ...(body.bindings ?? [])); this.mem.clear(); }
      return Response.json({ ok: true });
    }
    return super.handle(req);
  }
}

export default worker;
