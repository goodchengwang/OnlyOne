import { expect, spyOn, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchDevelopment } from "../src/dev-reload";
import { fakeTransport } from "../src/sync";

test("source reload ignores unchanged and invalid builds, then picks up an imported dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-reload-"));
  mkdirSync(join(root, "src/nested"), { recursive: true });
  mkdirSync(join(root, "cloud/src"), { recursive: true });
  writeFileSync(join(root, "src/cli.ts"), 'import value from "./nested/value"; import shared from "../cloud/src/shared"; console.log(value, shared);');
  const dependency = join(root, "src/nested/value.ts");
  writeFileSync(dependency, 'export default "before";');
  writeFileSync(join(root, "cloud/src/shared.ts"), 'export default "shared";');
  const errors = spyOn(console, "error").mockImplementation(() => {});
  let restarts = 0;
  const close = await watchDevelopment(root, () => { restarts++; });
  try {
    writeFileSync(join(root, "cloud/src/unused.ts"), 'export default "unused";');
    await Bun.sleep(650);
    expect(restarts).toBe(0);
    writeFileSync(dependency, 'export default "broken');
    await Bun.sleep(650);
    expect(errors).toHaveBeenCalled();
    expect(restarts).toBe(0);
    writeFileSync(dependency, 'export default "after";');
    for (let n = 0; n < 60 && !restarts; n++) await Bun.sleep(50);
    expect(restarts).toBe(1);
    writeFileSync(dependency, 'export default "later";');
    await Bun.sleep(650);
    expect(restarts).toBe(1); // a draining executor requests only one restart
  } finally { close(); errors.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("a real source daemon reload retains lazy changes without cloud lifecycle writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-daemon-reload-"));
  const repo = join(import.meta.dir, "..");
  cpSync(join(repo, "src"), join(root, "src"), { recursive: true });
  cpSync(join(repo, "npm"), join(root, "npm"), { recursive: true });
  cpSync(join(repo, "cloud/src"), join(root, "cloud/src"), { recursive: true });
  cpSync(join(repo, "cloud/deploy.ts"), join(root, "cloud/deploy.ts"));
  const home = join(root, "home"), data = join(home, "data");
  mkdirSync(data, { recursive: true });
  const config = '[fleet]\nprimary = "other-machine"\n[host]\nname = "reload-test"\n[server]\nenabled = false\n[resources]\ndisk_min_gb = 0\ndisk_min_pct = 0\n[medic]\nenabled = false\n';
  writeFileSync(join(data, "config.toml"), config);
  writeFileSync(join(home, "dev-source"), join(root, "src/cli.ts"));
  const transport = await fakeTransport(":memory:", "reload-test");
  await transport("/api/files/commit", { method: "POST", body: {
    msg: "seed", changes: [{ path: "config.toml", base_version: 0, content: Buffer.from(config).toString("base64") }],
  } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const response = await transport(url.pathname + url.search, {
      method: request.method, ...(request.method === "GET" ? {} : { body: await request.json() }),
    });
    return Response.json(response?.json ?? {}, { status: response?.status ?? 500 });
  } });
  writeFileSync(join(home, "onlyone.toml"), `[cloud]\nurl = ${JSON.stringify(server.url.origin)}\n[server]\ntoken = "test-machine"\n`);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const until = async (done: () => boolean) => {
    for (let n = 0; n < 200; n++) { if (done()) return; await Bun.sleep(50); }
    throw new Error("Source daemon did not finish reloading");
  };
  const start = async () => {
    const child = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "daemon"], {
      cwd: root, env: { ...process.env, PATH: "/usr/bin:/bin", ONLYONE_HOME: home, ONLYONE_DATA_DIR: data,
        ONLYONE_CONF: join(home, "onlyone.toml"), ONLYONE_SYNC: "", ONLYONE_SYNC_FAKE: "", ONLYONE_NO_MEDIC: "1" },
      stdout: "ignore", stderr: "pipe",
    });
    children.push(child);
    await until(() => child.exitCode !== null || (existsSync(join(home, "service-ready")) && readFileSync(join(home, "service-ready"), "utf8") === String(child.pid)));
    if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
    return child;
  };
  try {
    const first = await start();
    await until(() => existsSync(join(data, "fleet/hosts/reload-test.json")));
    await Bun.sleep(100);
    const before = transport.meter!.rowsWritten;
    // A pending journal belongs to the mirror; development reload must neither discard it nor force-upload it.
    const journal = join(data, "journal/pending.md");
    writeFileSync(journal, "a locally buffered journal entry\n");
    appendFileSync(join(root, "src/cli.ts"), '\nconsole.log("development reload fixture");\n');
    await until(() => first.exitCode !== null);
    expect(await first.exited).toBe(0);
    expect(readFileSync(journal, "utf8")).toContain("locally buffered");
    await start();
    await Bun.sleep(100);
    expect(readFileSync(journal, "utf8")).toContain("locally buffered");
    expect(transport.meter!.rowsWritten - before).toBe(0);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
    }
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("shared cloud code changes are debounced and disposing cancels a pending reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-reload-close-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "cloud/src"), { recursive: true });
  writeFileSync(join(root, "src/cli.ts"), 'import value from "../cloud/src/shared"; console.log(value);');
  const dependency = join(root, "cloud/src/shared.ts");
  writeFileSync(dependency, 'export default "before";');
  let restarts = 0;
  let close = await watchDevelopment(root, () => { restarts++; });
  try {
    writeFileSync(dependency, 'export default "first save";');
    await Bun.sleep(50);
    writeFileSync(dependency, 'export default "second save";');
    for (let n = 0; n < 60 && !restarts; n++) await Bun.sleep(50);
    expect(restarts).toBe(1);
    close = await watchDevelopment(root, () => { restarts++; });
    writeFileSync(dependency, 'export default "cancelled";');
    close();
    await Bun.sleep(650);
    expect(restarts).toBe(1);
  } finally { close(); rmSync(root, { recursive: true, force: true }); }
});
