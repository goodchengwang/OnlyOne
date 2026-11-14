import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test.skipIf(process.platform !== "darwin")("development runtime preserves arguments, signature and installed host", () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone dev runtime "));
  try {
    const bin = join(root, "bin");
    const installed = join(root, "installed");
    mkdirSync(bin);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(installed, "bin"), { recursive: true });
    mkdirSync(join(installed, "runtime/macos"), { recursive: true });
    writeFileSync(join(installed, "bin/nsh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(join(installed, "bin/nsh"), join(bin, "nsh"));
    const source = join(installed, "runtime/macos/nsh-macos-host");
    copyFileSync("/usr/bin/printf", source);
    const original = readFileSync(source);
    const script = join(root, "scripts/prepare-dev-runtime.sh");
    copyFileSync(join(import.meta.dir, "../scripts/prepare-dev-runtime.sh"), script);
    const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };
    const prepare = () => {
      const result = Bun.spawnSync(["bash", script], { env });
      expect(result.stderr.toString()).not.toContain("error:");
      expect(result.exitCode).toBe(0);
    };
    prepare();
    const runtime = join(root, ".nsh/dev-runtime/macos");
    const app = join(runtime, "OnlyOne Development.app");
    const executable = join(app, "Contents/MacOS/nsh-macos-host");
    expect(Bun.spawnSync(["codesign", "--verify", "--strict", app]).exitCode).toBe(0);
    const args = Bun.spawnSync([join(runtime, "nsh-macos-host"), "<%s>\n", "one two", "--three"]);
    expect(args.exitCode).toBe(0);
    expect(args.stdout.toString()).toBe("<one two>\n<--three>\n");
    const before = statSync(executable);
    prepare();
    expect(statSync(executable).ino).toBe(before.ino);
    expect(statSync(executable).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(source)).toEqual(original);
    // A damaged generated signature is rebuilt from the untouched installation.
    expect(Bun.spawnSync(["codesign", "--remove-signature", executable]).exitCode).toBe(0);
    prepare();
    expect(Bun.spawnSync(["codesign", "--verify", "--strict", app]).exitCode).toBe(0);
    rmSync(source);
    expect(Bun.spawnSync(["bash", script], { env }).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["codesign", "--verify", "--strict", app]).exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
