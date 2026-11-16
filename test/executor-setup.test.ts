import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executorSetupCommand, needsExecutorTools, parseExecutorTools } from "../app/executor-setup";
import { executorCommand } from "../app/executor-command";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onlyone setup "));
  const bin = join(home, ".volta/bin"); mkdirSync(bin, { recursive: true });
  const script = (name: string, body: string, directory = bin) => {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name); writeFileSync(path, "#!/bin/sh\n" + body); chmodSync(path, 0o700);
  };
  script("node", 'if [ "$1" = --version ]; then echo v22.1.0; fi\n');
  script("onlyone", "exit 127\n");
  script("npm", `if [ "$1" = --version ]; then echo 10.0.0; exit; fi
    printf '%s\\n' "$*" > "$HOME/install-args"
    mkdir -p "$HOME/.onlyone/tools/bin"
    printf '#!/bin/sh\\nif [ "$1" = --version ]; then echo 0.1.3; else cat; fi\\n' > "$HOME/.onlyone/tools/bin/onlyone"
    chmod 700 "$HOME/.onlyone/tools/bin/onlyone"
  `);
  const run = async (install = false) => {
    const command = executorSetupCommand(process.platform === "darwin" ? "macos" : "linux", install);
    const child = Bun.spawn([command.command, ...command.args], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { output, error, code };
  };
  return { home, script, run, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

test("component parsing preserves missing values, rejects malformed output and requires Node 22+", () => {
  for (const tools of [
    { node: null, npm: null, cli: null }, { node: "v22.1.0", npm: "10.0.0", cli: null },
    { node: "v20.0.0", npm: "10.0.0", cli: "0.1.3" }, { node: "v22.1.0", npm: null, cli: "0.1.3" },
  ]) {
    expect(parseExecutorTools("macos", `npm log\nONLYONE_TOOLS\t${tools.node ?? ""}\t${tools.npm ?? ""}\t${tools.cli ?? ""}\n`)).toEqual(tools);
    expect(parseExecutorTools("windows", `npm log\n${JSON.stringify(tools)}\r\n`)).toEqual(tools);
    expect(needsExecutorTools(tools)).toBe(true);
  }
  expect(needsExecutorTools({ node: "v26.0.0", npm: "11.0.0", cli: "0.1.3" })).toBe(false);
  expect(() => parseExecutorTools("macos", "bad output")).toThrow();
  expect(() => parseExecutorTools("windows", '{"node":42,"npm":null,"cli":null}')).toThrow();
});

test.skipIf(process.platform === "win32")("detects locally, installs only the missing CLI without sudo, then the release launcher finds it", async () => {
  const f = fixture();
  try {
    const before = await f.run();
    expect(before.code).toBe(0);
    expect(parseExecutorTools("macos", before.output)).toEqual({ node: "v22.1.0", npm: "10.0.0", cli: null });
    expect(existsSync(join(f.home, "install-args"))).toBe(false);
    const installed = await f.run(true);
    expect(installed).toMatchObject({ code: 0, error: "" });
    expect(needsExecutorTools(parseExecutorTools("macos", installed.output))).toBe(false);
    const args = readFileSync(join(f.home, "install-args"), "utf8");
    expect(args).toContain(`--prefix ${f.home}/.onlyone/tools`);
    expect(args).toContain("--ignore-scripts --include=optional");
    expect(args).toContain("--registry=https://registry.npmjs.org onlyonecli");
    writeFileSync(join(f.home, "install-args"), "unchanged");
    expect((await f.run(true)).code).toBe(0);
    expect(readFileSync(join(f.home, "install-args"), "utf8")).toBe("unchanged");
    const command = executorCommand("macos", "/not-a-checkout", false);
    const child = Bun.spawn([command.command, ...command.args], { env: { ...process.env, HOME: f.home }, stdin: "pipe", stdout: "pipe" });
    child.stdin.write('{"session":"test-secret"}'); child.stdin.end();
    expect(await new Response(child.stdout).text()).toBe('{"session":"test-secret"}');
    expect(await child.exited).toBe(0);
  } finally { f.dispose(); }
});

test.skipIf(process.platform === "win32")("failed npm installation reports failure and can retry", async () => {
  const f = fixture();
  try {
    f.script("npm", 'if [ "$1" = --version ]; then echo 10.0.0; else echo "network unavailable" >&2; exit 1; fi\n');
    const result = await f.run(true);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain("network unavailable");
    expect(existsSync(join(f.home, ".onlyone/tools/bin/onlyone"))).toBe(false);
  } finally { f.dispose(); }
});

test.skipIf(process.platform === "win32").each(["node", "npm"])("missing %s: Node bootstrap verifies the archive before activation and shares its runtime with subsequent launches", async (missing) => {
  const f = fixture();
  try {
    const archiveBin = join(f.home, "archive/bin");
    f.script("node", 'if [ "$1" = --version ]; then echo v22.1.0; fi\n', archiveBin);
    f.script("npm", readFileSync(join(f.home, ".volta/bin/npm"), "utf8").replace("#!/bin/sh\n", ""), archiveBin);
    f.script(missing, "exit 127\n");
    const archive = join(f.home, "node.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", f.home, "archive"]).exitCode).toBe(0);
    const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
    const filename = `node-v22.1.0-${process.platform}-${process.arch}.tar.gz`;
    writeFileSync(join(f.home, "sums"), `${"0".repeat(64)}  ${filename}\n`);
    f.script("curl", 'case "$*" in *SHASUMS*) cp "$HOME/sums" "$8" ;; *) cp "$HOME/node.tar.gz" "$8" ;; esac\n');
    const bad = await f.run(true);
    expect(bad.code).not.toBe(0);
    expect(bad.error).toContain("checksum mismatch");
    expect(existsSync(join(f.home, ".onlyone/tools/node"))).toBe(false);
    writeFileSync(join(f.home, "sums"), `${hash}  ${filename}\n`);
    const good = await f.run(true);
    expect(good).toMatchObject({ code: 0, error: "" });
    expect(needsExecutorTools(parseExecutorTools("macos", good.output))).toBe(false);
    expect(parseExecutorTools("macos", (await f.run()).output)).toEqual({ node: "v22.1.0", npm: "10.0.0", cli: "0.1.3" });
  } finally { f.dispose(); }
});
