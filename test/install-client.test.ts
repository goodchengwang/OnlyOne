import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform === "win32")("desktop installer builds locally by default and verifies explicit release downloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-install-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const source = join(root, "source"), tools = join(root, "tools"), home = join(root, "home");
    for (const dir of [join(source, "app"), tools, home]) mkdirSync(dir, { recursive: true });
    cpSync(resolve(import.meta.dir, "../install-client.sh"), join(source, "install-client.sh"));
    writeFileSync(join(source, "app/nsh.json"), "{}");
    const executable = (name: string, body: string) => {
      const file = join(tools, name);
      writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    executable("uname", 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi');
    for (const tool of ["pacman", "ldd", "update-desktop-database"]) executable(tool, "exit 0");
    executable("curl", 'echo "unexpected download" >&2; exit 1');
    const nsh = executable("nsh", `
      [ "$1" = package ] && [ "$2" = --target ] && [ "$3" = linux ] && [ "$4" = -o ]
      out="$5"
      mkdir -p "$out/OnlyOne"
      printf '#!/bin/sh\\nexit 0\\n' > "$out/OnlyOne/OnlyOne"
      chmod +x "$out/OnlyOne/OnlyOne"
      touch "$out/OnlyOne/dev.onlyone.app.png"
      printf 'Exec=OnlyOne\\n' > "$out/OnlyOne/dev.onlyone.app.desktop"
      tar -czf "$out/OnlyOne.tar.gz" -C "$out" OnlyOne
      cp "$out/OnlyOne.tar.gz" "$FIXTURE_ARCHIVE"
    `);
    const env = {
      ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), NSH: nsh,
      PATH: `${tools}:${process.env.PATH}`, ONLYONE_CLIENT_BASE_URL: "", FIXTURE_ARCHIVE: join(root, "release.tar.gz"),
    };
    const run = async () => {
      const child = Bun.spawn(["bash", join(source, "install-client.sh")], { env, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      return { code: await child.exited, output, error };
    };
    const local = await run();
    expect(local.code).toBe(0);
    expect(local.error).not.toContain("unexpected download");
    const installed = join(home, "data/onlyone-client/OnlyOne");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(join(home, "data/applications/dev.onlyone.app.desktop"), "utf8")).toContain(installed);

    const bytes = new Uint8Array(readFileSync(env.FIXTURE_ARCHIVE));
    let checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const requests: string[] = [];
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      return path === "/sha256sums" ? new Response(`${checksum}  onlyone-linux-x86_64.tar.gz\n`) : new Response(bytes);
    } });
    env.ONLYONE_CLIENT_BASE_URL = `http://127.0.0.1:${server.port}`;
    rmSync(join(tools, "curl"));
    expect((await run()).code).toBe(0);
    expect(requests).toEqual(["/onlyone-linux-x86_64.tar.gz", "/sha256sums"]);
    checksum = "0".repeat(64);
    const invalid = await run();
    expect(invalid.code).not.toBe(0);
    expect(invalid.error).toContain("checksum");
    expect(existsSync(installed)).toBe(true);
  } finally {
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
