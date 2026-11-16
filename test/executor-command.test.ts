import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executorCommand } from "../app/executor-command";

test.skipIf(process.platform === "win32")("release desktop invokes installed onlyonecli, never a source fallback, and sends the session only on stdin", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone app command "));
  try {
    const bin = join(home, ".local/bin"); mkdirSync(bin, { recursive: true });
    const stub = join(bin, "onlyone");
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$*"\ncat\n'); chmodSync(stub, 0o700);
    for (const os of ["macos", "linux"]) {
      const command = executorCommand(os, join(import.meta.dir, "../app"), false);
      const child = Bun.spawn([command.command, ...command.args], { env: { ...process.env, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write('{"session":"test-secret"}'); child.stdin.end();
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toBe('app\n{"session":"test-secret"}');
      expect(command.args.join(" ")).not.toContain("test-secret");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("windows launcher is cmd.exe and resolves a too-old Node.js through the tools copy", () => {
  const command = executorCommand("windows", "C:\\not-a-source-checkout", false);
  const script = command.args.join(" ");
  // A PowerShell launcher line-buffers a native child's stdout and appends a
  // trailing newline; the byte-exact test above only catches that on Windows CI.
  expect(command.command).toBe("cmd.exe");
  expect(script).toContain("call onlyone.cmd app");
  expect(script).toContain("exit /b 127");
  // The whole script is one argv element that the spawner re-quotes for Windows
  // with backslashes, which neither cmd.exe nor powershell.exe reads as an
  // escape: a double quote anywhere would change what the shell receives.
  expect(script).not.toContain('"');
  // Node.js below 22 cannot run the CLI, so the launcher falls back to the copy
  // the installer puts into the tools root.
  expect(script).toContain("tools\\node");
  expect(script).toContain("22-process.versions.node");
});

test.skipIf(process.platform !== "win32")("Windows desktop invokes the npm cmd shim with a piped request", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone windows command "));
  try {
    const bin = join(home, "npm"); mkdirSync(bin);
    const script = join(home, "stub.ts");
    writeFileSync(script, 'console.log(process.argv.slice(2).join(" ")); process.stdout.write(await Bun.stdin.text());');
    writeFileSync(join(bin, "onlyone.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const command = executorCommand("windows", "C:\\not-a-source-checkout", false);
    const child = Bun.spawn([command.command, ...command.args], { env: { ...process.env, USERPROFILE: home, APPDATA: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write('{"session":"test-secret"}'); child.stdin.end();
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
    expect(output.replace(/\r\n/g, "\n")).toBe('app\n{"session":"test-secret"}');
  } finally { rmSync(home, { recursive: true, force: true }); }
  // cmd.exe starts in milliseconds, so the budget is only headroom for windows-latest;
  // the byte assertion above stays exact, unlike the trimEnd this test used to carry.
}, 30_000);
