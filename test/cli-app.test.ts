import { expect, test } from "bun:test";
import { appRequest, checkAppBinding } from "../src/cli-app";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("desktop protocol validates stdin and refuses a different CLI binding", () => {
  expect(appRequest('{"action":"start","url":"https://EXAMPLE.com:443/","session":"private"}'))
    .toEqual({ action: "start", url: "https://example.com", session: "private" });
  for (const text of ["private broken json", "null", "{}", '{"action":"delete","url":"https://example.com"}',
    '{"action":"start","url":"http://example.com"}', '{"action":"start","url":"https://example.com","session":{}}'])
    expect(() => appRequest(text)).toThrow();
  expect(() => checkAppBinding("https://example.com", { cloud: { url: "https://EXAMPLE.com:443/" } })).not.toThrow();
  expect(() => checkAppBinding("https://other.example.com", { cloud: { url: "https://example.com" } })).toThrow("another server");
});

test("CLI stop waits for a live task and a local file notification drains without killing the process", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone cli stop "));
  const env = { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: "", ONLYONE_CONF: "" };
  mkdirSync(join(home, "cli"));
  writeFileSync(join(home, "cli/current.json"), JSON.stringify({ binary: process.execPath, version: "0.1.3" }));
  writeFileSync(join(home, "hold"), "active task");
  const module = join(import.meta.dir, "../src/npm-service.ts");
  const lock = join(import.meta.dir, "../src/daemon-lock.ts");
  const runner = Bun.spawn([process.execPath, "-e", `
    import { writeFileSync, existsSync } from "node:fs";
    import { watchNpmStop } from ${JSON.stringify(module)};
    import { lockDaemon } from ${JSON.stringify(lock)};
    const home = process.env.ONLYONE_HOME;
    const unlock = lockDaemon(home + "/data"); process.once("exit", unlock);
    watchNpmStop(() => {
      writeFileSync(home + "/draining", "yes");
      const t = setInterval(() => { if (!existsSync(home + "/hold")) { clearInterval(t); process.exit(0); } }, 20);
    });
    writeFileSync(home + "/ready", "yes");
    setInterval(() => {}, 1000);
  `], { env, stdout: "pipe", stderr: "pipe" });
  let stop: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (let n = 0; n < 100 && !existsSync(join(home, "ready")); n++) await Bun.sleep(50);
    expect(existsSync(join(home, "ready"))).toBe(true);
    stop = Bun.spawn([process.execPath, "-e", `import { stopNpmService } from ${JSON.stringify(module)}; await stopNpmService();`], { env, stdout: "pipe", stderr: "pipe" });
    let done = false;
    void stop.exited.then(() => { done = true; });
    for (let n = 0; n < 100 && !existsSync(join(home, "draining")); n++) await Bun.sleep(50);
    expect(existsSync(join(home, "draining"))).toBe(true);
    await Bun.sleep(10_500);
    expect(done).toBe(false);
    expect(readFileSync(join(home, "hold"), "utf8")).toBe("active task");
    rmSync(join(home, "hold"));
    expect(await runner.exited).toBe(0);
    expect(await stop.exited).toBe(0);
    expect(existsSync(join(home, "cli/stopped"))).toBe(true);
  } finally {
    runner.kill(); stop?.kill();
    await runner.exited; if (stop) await stop.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
