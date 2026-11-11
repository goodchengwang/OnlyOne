// Native service smoke test. All credentials, files and task names belong to this throwaway installation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve(process.argv[2] || 'dist/npm');
const home = mkdtempSync(join(tmpdir(), 'onlyone native service '));
const label = 'onlyone-' + createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
const cli = join(root, 'onlyonecli/bin/onlyone.cjs');
const platform = `onlyone-${process.platform}-${process.arch}`;
// Resolve native packages without contacting a registry or adding dev tools to the service's PATH.
const modules = join(root, 'onlyonecli/node_modules'); mkdirSync(modules, { recursive: true });
const { symlinkSync } = await import('node:fs');
const link = join(modules, platform);
const createdLink = !existsSync(link);
if (createdLink) symlinkSync(join(root, platform), link, process.platform === 'win32' ? 'junction' : 'dir');
const npm = process.env.npm_execpath || [join(process.execPath, '../node_modules/npm/bin/npm-cli.js'), resolve(process.execPath, '../../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
assert(npm, 'npm-cli.js missing');
const env = { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: '', ONLYONE_CONF: '', ONLYONE_SYNC: '', ONLYONE_SYNC_FAKE: '', ONLYONE_NO_MEDIC: '1', npm_execpath: npm };
const files = new Map(); let rev = 1, foreground;
const content = Buffer.from('[fleet]\nprimary = "another-machine"\n[host]\nname = "npm-smoke"\n[server]\nenabled = false\n[resources]\ndisk_min_gb = 0\ndisk_min_pct = 0\n[medic]\nenabled = false\n');
files.set('config.toml', { path: 'config.toml', rev, version: 1, deleted: false, content: content.toString('base64'), hash: createHash('sha256').update(content).digest('hex') });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== 'Bearer test-machine') return reply({}, 401);
  if (url.pathname === '/api/host/security') return reply({ primary: 'another-machine' });
  if (url.pathname === '/api/files/changes') return reply({ rev, more: false, files: [...files.values()].filter(f => f.rev > Number(url.searchParams.get('since') || 0)) });
  if (url.pathname === '/api/files/commit') {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), changed = [];
    for (const c of body.changes) {
      const f = { ...c, rev: ++rev, version: (files.get(c.path)?.version || 0) + 1, deleted: !!c.deleted, hash: c.deleted ? null : createHash('sha256').update(Buffer.from(c.content, 'base64')).digest('hex') };
      files.set(c.path, f); changed.push(f);
    }
    return reply({ files: changed });
  }
  return reply({}, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const ready = join(home, 'service-ready');
const invoke = args => exec(process.execPath, [cli, ...args], { env, timeout: 45_000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const pid = Number(readFileSync(ready, 'utf8')); process.kill(pid, 0); return pid; } catch {}
    await delay(100);
  }
  throw new Error('Executor did not become ready');
}
try {
  await invoke(['init', url, '--token', 'test-machine']);
  let serviceAvailable = true;
  if (process.platform === 'linux') serviceAvailable = await exec('systemctl', ['--user', 'show-environment']).then(() => true, () => false);
  if (process.platform === 'darwin') serviceAvailable = await exec('launchctl', ['print', `gui/${process.getuid()}`]).then(() => true, () => false);
  if (serviceAvailable) {
    const first = await invoke([]);
    assert.match(first.stdout, /service is running/);
    const pid = await waitReady();
    await invoke([]);
    assert.equal(await waitReady(), pid, 'Reopening must reuse the existing daemon');
    console.log(`Native service passed: ${platform}, custom home with spaces, repeated start, background readiness`);
  } else {
    const failure = await invoke([]).then(() => null, error => error);
    assert(failure, 'Unavailable service manager must not report success');
    assert(!failure.stdout?.includes('service is running'));
    const binary = join(root, platform, 'bin', process.platform === 'win32' ? 'onlyone.exe' : 'onlyone');
    foreground = spawn(binary, ['daemon'], { env, stdio: 'ignore' });
    await waitReady();
    console.log(`Native daemon passed: ${platform}; unavailable user service manager reported accurately`);
  }
} finally {
  if (foreground) { foreground.kill('SIGTERM'); await new Promise(resolve => foreground.once('exit', resolve)); }
  if (process.platform === 'darwin') {
    const file = join(homedir(), `Library/LaunchAgents/dev.${label}.daemon.plist`);
    await exec('launchctl', ['bootout', `gui/${process.getuid()}`, file]).catch(() => {});
    rmSync(file, { force: true });
  } else if (process.platform === 'linux') {
    await exec('systemctl', ['--user', 'disable', '--now', `${label}.service`]).catch(() => {});
    rmSync(join(homedir(), `.config/systemd/user/${label}.service`), { force: true });
    await exec('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  } else {
    try { process.kill(Number(readFileSync(ready, 'utf8'))); } catch {}
    await exec('schtasks', ['/End', '/TN', label]).catch(() => {});
    await exec('schtasks', ['/Delete', '/F', '/TN', label]).catch(() => {});
  }
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
  if (createdLink) unlinkSync(link);
}
