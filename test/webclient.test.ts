import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureWebClient } from "../src/webclient";

// Every tar call is a process spawn (~3s for Git's tar.exe on Windows under PowerShell, more under load), and most
// tests make two (release() packs, ensureWebClient unpacks) — that overruns bun's 5s default.
const TAR = 30_000;

describe("ensureWebClient", () => {
  let root: string, dir: string, assets: Record<string, Uint8Array | string>, requests: string[];
  let server: ReturnType<typeof Bun.serve>;
  const base = () => `http://127.0.0.1:${server.port}`;
  const index = () => readFileSync(join(dir, "onlyone", "index.html"), "utf8");

  /** Publishes a release whose client's index.html says `text`. */
  async function release(text: string, sum?: string) {
    const src = join(root, `src-${text}`);
    mkdirSync(src);
    writeFileSync(join(src, "index.html"), text);
    const name = `${text}.tar.gz`;
    const tarball = join(root, name);
    // Run from root with relative names: tar on Windows reads an absolute "C:\..." path as a remote host.
    await $`tar -czf ${name} -C ${`src-${text}`} .`.cwd(root).quiet();
    const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    assets["onlyone-web.tar.gz"] = bytes;
    assets.sha256sums = `${sum ?? new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  onlyone-web.tar.gz\n`;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "onlyone-web-"));
    dir = join(root, "web");
    mkdirSync(dir);
    assets = {};
    requests = [];
    server = Bun.serve({
      // Bind the address the client fetches: a wildcard port-0 bind can be handed a port another local app
      // already listens on at 127.0.0.1, and the test's downloads then reach that app instead of this server.
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.slice(1);
        requests.push(name);
        return name in assets ? new Response(assets[name]) : new Response("", { status: 404 });
      },
    });
  });
  afterEach(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("no configured source makes no network requests and reports a missing local build", async () => {
    const saved = process.env.ONLYONE_CLIENT_BASE_URL;
    delete process.env.ONLYONE_CLIENT_BASE_URL;
    const network = spyOn(globalThis, "fetch");
    try {
      expect(await ensureWebClient(dir)).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      if (saved === undefined) delete process.env.ONLYONE_CLIENT_BASE_URL;
      else process.env.ONLYONE_CLIENT_BASE_URL = saved;
    }
  });

  test("a downloaded client remains available offline without a configured source", async () => {
    await release("one");
    await ensureWebClient(dir, base());
    const saved = process.env.ONLYONE_CLIENT_BASE_URL;
    delete process.env.ONLYONE_CLIENT_BASE_URL;
    const network = spyOn(globalThis, "fetch");
    try {
      expect(await ensureWebClient(dir)).toBe(true);
      expect(index()).toBe("one");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      if (saved === undefined) delete process.env.ONLYONE_CLIENT_BASE_URL;
      else process.env.ONLYONE_CLIENT_BASE_URL = saved;
    }
  }, TAR);

  test("downloads the release's client and leaves no download behind", async () => {
    await release("one");
    expect(await ensureWebClient(dir, base())).toBe(true);
    expect(index()).toBe("one");
    expect(readdirSync(dir).sort()).toEqual([".release", "onlyone"]);
  }, TAR);

  test("does not download what it already has", async () => {
    await release("one");
    await ensureWebClient(dir, base());
    requests.length = 0;
    expect(await ensureWebClient(dir, base())).toBe(true);
    expect(requests).toEqual(["sha256sums"]);
  }, TAR);

  test("replaces the client with a newer release's", async () => {
    await release("one");
    await ensureWebClient(dir, base());
    await release("two");
    await ensureWebClient(dir, base());
    expect(index()).toBe("two");
  }, TAR);

  test("refuses a download that fails its checksum, keeping the client", async () => {
    await release("one");
    await ensureWebClient(dir, base());
    await release("two", "0".repeat(64));
    expect(await ensureWebClient(dir, base())).toBe(true);
    expect(index()).toBe("one");
  }, TAR);

  test("keeps the client when the release can't be reached", async () => {
    await release("one");
    await ensureWebClient(dir, base());
    assets = {};
    expect(await ensureWebClient(dir, base())).toBe(true);
    expect(index()).toBe("one");
  }, TAR);

  test("reports no client when there is none and no release has one", async () => {
    expect(await ensureWebClient(dir, base())).toBe(false);
    expect(existsSync(join(dir, "onlyone"))).toBe(false);
  });

  test("an archive without a client replaces nothing", async () => {
    await release("one");
    await ensureWebClient(dir, base());
    const empty = join(root, "empty");
    mkdirSync(empty);
    writeFileSync(join(empty, "other.txt"), "x");
    const tarball = join(root, "empty.tar.gz");
    await $`tar -czf empty.tar.gz -C empty .`.cwd(root).quiet();
    const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    assets["onlyone-web.tar.gz"] = bytes;
    assets.sha256sums = `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  onlyone-web.tar.gz\n`;
    expect(await ensureWebClient(dir, base())).toBe(true);
    expect(index()).toBe("one");
  }, TAR);

  test("leaves a locally built client alone", async () => {
    mkdirSync(join(dir, "onlyone"));
    writeFileSync(join(dir, "onlyone", "index.html"), "local");
    await release("one");
    expect(await ensureWebClient(dir, base())).toBe(true);
    expect(index()).toBe("local");
    expect(requests).toEqual([]);
  }, TAR);
});
