import { expect, test } from "bun:test";
import { waitForServed, workerTarget } from "../cloud/deploy";

const base = { ONLYONE_WORKER_NAME: "onlyone", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), ONLYONE_DOMAIN: "onlyone.example.com" };

test("a release deploy needs the Worker name, account and custom domain, and nothing else", () => {
  expect(workerTarget(base)).toEqual({ name: "onlyone", account: "a".repeat(32), domain: "onlyone.example.com" });
  expect(() => workerTarget({ ...base, ONLYONE_WORKER_NAME: "" })).toThrow("ONLYONE_WORKER_NAME");
  expect(() => workerTarget({ ...base, CLOUDFLARE_ACCOUNT_ID: "not-an-account" })).toThrow("Invalid Worker name or Cloudflare account");
  expect(() => workerTarget({ ...base, ONLYONE_DOMAIN: "onlyone.example.com/path" })).toThrow("Invalid ONLYONE_DOMAIN");
});

test("a release deploy waits for the new version and reports what still served instead", async () => {
  const expected = new TextEncoder().encode("<html>live v2</html>");
  const previous = new TextEncoder().encode("<p>v1</p>");
  const answers = [previous, previous, expected];
  let calls = 0;
  await waitForServed(expected, "https://example.test/?release=2.0.0", {
    request: async () => new Response(answers[calls++]!), delayMs: 0,
  });
  expect(calls).toBe(3);

  calls = 0;
  const never = waitForServed(expected, "https://example.test/?release=2.0.0", {
    request: async () => new Response(previous), delayMs: 0, timeoutMs: 20,
  });
  await expect(never).rejects.toThrow("serves 9 bytes, not the 20-byte build just deployed");

  await expect(waitForServed(expected, "https://example.test/", {
    request: async () => new Response("nope", { status: 502 }), delayMs: 0, timeoutMs: 0,
  })).rejects.toThrow("serves HTTP 502");
});
