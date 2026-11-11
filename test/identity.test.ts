import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { homeDir } from "../src/core";
import { onlyoneTomlPath } from "../src/sync";

const source = resolve(import.meta.dir, "..");

test("OnlyOne has an independent app identity, CLI and bootstrap filename", () => {
  const app = JSON.parse(readFileSync(join(source, "app/nsh.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  expect(app.name).toBe("OnlyOne");
  expect(app.id).toBe("dev.onlyone.app");
  expect(app.updater).toBeUndefined();
  expect(pkg.bin).toEqual({ onlyone: "src/cli.ts" });
  expect(basename(onlyoneTomlPath())).toBe("onlyone.toml");
  expect(existsSync(join(source, "app/onlyone.ts"))).toBe(true);
  const worker = readFileSync(join(source, "cloud/src/index.ts"), "utf8");
  expect(worker).toContain("export class OnlyOne");
  expect(worker).toContain("ONLYONE_TOKEN");
  expect(worker).toContain("onlyone: { online:");
  expect(readFileSync(join(source, "app/App.tsx"), "utf8")).toContain('token: "onlyone.token"');
});

test("homeDir defaults to OnlyOne and honors only its explicit override", () => {
  const saved = process.env.ONLYONE_HOME;
  try {
    delete process.env.ONLYONE_HOME;
    expect(homeDir()).toBe(join(homedir(), ".onlyone"));
    process.env.ONLYONE_HOME = "~/onlyone-test-home";
    expect(homeDir()).toBe(join(homedir(), "onlyone-test-home"));
  } finally {
    if (saved === undefined) delete process.env.ONLYONE_HOME;
    else process.env.ONLYONE_HOME = saved;
  }
});

test("a local checkout without an update source safely skips self-update", async () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-source-"));
  try {
    for (const dir of ["src", "cloud", "npm"]) cpSync(join(source, dir), join(root, dir), { recursive: true });
    mkdirSync(join(root, "home"));
    const init = Bun.spawnSync(["git", "init", "-q", root]);
    expect(init.exitCode).toBe(0);
    const child = Bun.spawn([process.execPath, "-e", 'import { selfUpdate } from "./src/setup.ts"; console.log(await selfUpdate({ force: true }));'], {
      cwd: root,
      env: { ...process.env, ONLYONE_HOME: join(root, "home"), ONLYONE_DATA_DIR: join(root, "home/data"), ONLYONE_SYNC: "local" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe("false");
    expect(errors).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
