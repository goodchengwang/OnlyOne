import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const node = Bun.which("node")!;
const runtime = join(import.meta.dir, "../src/npm-runtime.ts");
const launcher = join(import.meta.dir, "../npm/launcher.cjs");
test("Windows launcher resolves the windows package name while Node reports win32", () => {
  const root = mkdtempSync(join(tmpdir(), "onlyone-windows-package-"));
  const directory = join(root, "node_modules/onlyone-windows-x64");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"name":"onlyone-windows-x64"}');
  const module = { exports: {} as { platformBinary: (root: string) => string } };
  try {
    runInNewContext(readFileSync(launcher, "utf8"), { module, require: createRequire(import.meta.url), process: { platform: "win32", arch: "x64" } });
    expect(module.exports.platformBinary(realpathSync(root))).toBe(join(realpathSync(directory), "bin/onlyone.exe"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const script = (file: string, body: string) => { writeFileSync(file, `#!${node}\n${body}\n`); chmodSync(file, 0o700); };
async function runStage(home: string, npm: string, action = "stage") {
  const code = `import { stageNpmUpdate, activateNpmUpdate } from ${JSON.stringify(runtime)}; console.log(${action === "stage" ? "await stageNpmUpdate()" : "activateNpmUpdate()"});`;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: "", ONLYONE_NODE: node, ONLYONE_NPM_CLI: npm }, stdout: "pipe", stderr: "pipe" });
  const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, out, err };
}

// Compiled binaries are exercised by the native npm CI matrix; these fixtures isolate updater failure modes.
test.skipIf(process.platform === "win32" || node.includes(" "))("npm updates stage exact versions, do not replace the live binary, and activate only on drain", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone npm update "));
  const root = join(home, "cli"), current = join(root, "current.json"), npm = join(home, "npm-cli.js");
  mkdirSync(root, { recursive: true });
  const old = join(home, "old"); script(old, 'console.log("0.1.0")');
  writeFileSync(current, JSON.stringify({ version: "0.1.0", binary: old }));
  writeFileSync(npm, `const fs=require('fs'),p=require('path'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(join(home, "npm.log"))},JSON.stringify(a)+'\\n');
if(a[0]==='view'){console.log(JSON.stringify(fs.readFileSync(${JSON.stringify(join(home, "latest"))},'utf8')));}
else {if(!a.includes('--ignore-scripts')||!a.includes('--include=optional')||!a.includes('onlyonecli@0.2.0'))process.exit(4);
const prefix=a[a.indexOf('--prefix')+1], main=p.join(prefix,'node_modules/onlyonecli'),dir=p.join(prefix,'node_modules/onlyone-'+process.platform+'-'+process.arch,'bin'); fs.mkdirSync(main,{recursive:true}); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(p.join(main,'package.json'),JSON.stringify({version:'0.2.0'})); fs.writeFileSync(p.join(dir,'onlyone'), ${JSON.stringify(`#!${node}\nif(process.argv[2]==='--version')console.log('0.2.0');else if(process.argv[2]==='--self-check')process.exit(${0});\n`)});fs.chmodSync(p.join(dir,'onlyone'),0o700);}`);
  try {
    writeFileSync(join(home, "latest"), "0.1.0");
    expect((await runStage(home, npm)).out.trim()).toBe("false");
    writeFileSync(join(home, "latest"), "0.0.9");
    expect((await runStage(home, npm)).out.trim()).toBe("false");
    writeFileSync(join(home, "latest"), "0.2.0");
    const staged = await runStage(home, npm);
    expect(staged.status).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "npm.log"), "utf8").split("\n")[0])).toEqual(["view", "onlyonecli@latest", "version", "--json"]);
    let state = JSON.parse(readFileSync(current, "utf8"));
    expect(state.binary).toBe(old);
    expect(state.version).toBe("0.1.0");
    expect(state.next.version).toBe("0.2.0");
    expect(existsSync(state.next.binary)).toBe(true);
    expect((await runStage(home, npm)).err).toContain("already waiting");
    expect((await runStage(home, npm, "activate")).status).toBe(0);
    state = JSON.parse(readFileSync(current, "utf8"));
    expect(state.version).toBe("0.2.0");
    expect(state.pending).toBe(true);
    expect(state.previous.binary).toBe(old);
    expect(readFileSync(old, "utf8")).toContain("0.1.0");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("npm failures and malformed version metadata preserve the active release", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-npm-failure-"));
  mkdirSync(join(home, "cli"));
  const current = join(home, "cli/current.json"), original = JSON.stringify({ version: "0.1.0", binary: "untouched" }), npm = join(home, "npm-cli.js");
  writeFileSync(current, original);
  try {
    writeFileSync(npm, "process.stderr.write('registry unavailable'); process.exit(1);");
    expect((await runStage(home, npm)).err).toContain("npm failed");
    expect(readFileSync(current, "utf8")).toBe(original);
    writeFileSync(npm, "console.log(JSON.stringify('../../bad')); ");
    expect((await runStage(home, npm)).err).toContain("stable OnlyOne version");
    expect(readFileSync(current, "utf8")).toBe(original);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32" || node.includes(" "))("service launcher rolls a failed candidate back once and starts the previous version", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone npm rollback ")), dir = join(home, "cli"), data = join(home, "data");
  mkdirSync(dir); mkdirSync(data);
  const old = join(home, "old"), bad = join(home, "bad"), current = join(dir, "current.json");
  script(bad, "process.exit(1)");
  script(old, `require('fs').writeFileSync(${JSON.stringify(join(home, "service-ready"))},String(process.pid)); setInterval(()=>{},1000);`);
  writeFileSync(current, JSON.stringify({ version: "0.2.0", binary: bad, pending: true, previous: { version: "0.1.0", binary: old } }));
  writeFileSync(join(dir, "service.json"), JSON.stringify({ ONLYONE_DATA_DIR: data }));
  const child = Bun.spawn([node, launcher, "--service"], { env: { ...process.env, ONLYONE_HOME: home }, stdout: "ignore", stderr: "pipe" });
  try {
    for (let i = 0; i < 80 && !existsSync(join(home, "service-ready")); i++) await Bun.sleep(50);
    expect(existsSync(join(home, "service-ready"))).toBe(true);
    expect(JSON.parse(readFileSync(current, "utf8")).version).toBe("0.1.0");
    expect(readFileSync(join(home, "update-rejected"), "utf8")).toBe("0.2.0");
    expect(JSON.parse(readFileSync(join(home, "update-state.json"), "utf8")).state).toBe("failed");
  } finally { child.kill("SIGTERM"); await child.exited; rmSync(home, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32" || node.includes(" "))("service confirms a healthy candidate and rolls back a candidate that never becomes ready", async () => {
  for (const healthy of [true, false]) {
    const home = mkdtempSync(join(tmpdir(), "onlyone-npm-readiness-")), dir = join(home, "cli"), data = join(home, "data");
    mkdirSync(dir); mkdirSync(data);
    const candidate = join(home, "candidate"), old = join(home, "old"), current = join(dir, "current.json"), ready = join(home, "service-ready");
    script(candidate, `${healthy ? `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));` : "process.on('SIGTERM',()=>{});"} setInterval(()=>{},1000);`);
    script(old, `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`);
    writeFileSync(current, JSON.stringify({ version: "0.2.0", binary: candidate, pending: true, previous: { version: "0.1.0", binary: old } }));
    writeFileSync(join(dir, "service.json"), JSON.stringify({ ONLYONE_DATA_DIR: data }));
    // Accelerate only the startup watchdog's clock; child processes still use real time and real readiness files.
    const code = `const now=Date.now; Date.now=()=>now()*100; require(${JSON.stringify(launcher)}).run(['--service']);`;
    const child = Bun.spawn([node, "-e", code], { env: { ...process.env, ONLYONE_HOME: home }, stdout: "ignore", stderr: "ignore" });
    try {
      for (let i = 0; i < 100; i++) {
        const state = JSON.parse(readFileSync(current, "utf8"));
        if (healthy ? state.pending === false : state.version === "0.1.0" && existsSync(join(home, "update-rejected"))) break;
        await Bun.sleep(50);
      }
      const state = JSON.parse(readFileSync(current, "utf8"));
      expect(state.version).toBe(healthy ? "0.2.0" : "0.1.0");
      expect(state.pending).toBeFalsy();
      expect(existsSync(join(home, "update-rejected"))).toBe(!healthy);
    } finally { child.kill("SIGTERM"); await child.exited; rmSync(home, { recursive: true, force: true }); }
  }
});

test.skipIf(process.platform === "win32" || node.includes(" "))("a downloaded executable that fails self-check never changes the active release", async () => {
  const home = mkdtempSync(join(tmpdir(), "onlyone-npm-selfcheck-")), dir = join(home, "cli"), current = join(dir, "current.json"), npm = join(home, "npm-cli.js");
  mkdirSync(dir);
  const original = JSON.stringify({ version: "0.1.0", binary: "old-binary" });
  writeFileSync(current, original);
  writeFileSync(npm, `const fs=require('fs'),p=require('path'),a=process.argv.slice(2);
if(a[0]==='view')console.log(JSON.stringify('0.2.0'));
else {const prefix=a[a.indexOf('--prefix')+1],main=p.join(prefix,'node_modules/onlyonecli'),bin=p.join(prefix,'node_modules/onlyone-'+process.platform+'-'+process.arch,'bin');fs.mkdirSync(main,{recursive:true});fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(p.join(main,'package.json'),JSON.stringify({version:'0.2.0'}));fs.writeFileSync(p.join(bin,'onlyone'),${JSON.stringify(`#!${node}\nif(process.argv[2]==='--version')console.log('0.2.0');else process.exit(1);\n`)});fs.chmodSync(p.join(bin,'onlyone'),0o700);}`);
  try {
    const result = await runStage(home, npm);
    expect(result.status).toBe(1);
    expect(result.err).toContain("failed startup self-check");
    expect(readFileSync(current, "utf8")).toBe(original);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

 test("CLI latest comparison refuses downgrades", async () => {
  const { newerCliVersion } = await import("../src/npm-runtime");
  expect(newerCliVersion("0.1.4", "0.1.3")).toBe(true);
  expect(newerCliVersion("0.1.2", "0.1.3")).toBe(false);
  expect(newerCliVersion("0.1.3", "0.1.3")).toBe(false);
  expect(() => newerCliVersion("bad", "0.1.3")).toThrow();
});
