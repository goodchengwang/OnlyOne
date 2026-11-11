// Run against packed artifacts, with neither Bun nor the source checkout on PATH.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] || 'dist/npm');
const npm = process.env.npm_execpath || [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
assert(npm, 'npm-cli.js must be available');
const home = mkdtempSync(join(tmpdir(), 'onlyone npm install '));
const platform = `onlyone-${process.platform}-${process.arch}`;
const packs = join(home, 'packs'); mkdirSync(packs);
function execute(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...opts });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}
try {
  const tarballs = [];
  for (const name of [platform, 'onlyonecli']) {
    const files = JSON.parse(execute(process.execPath, [npm, 'pack', join(root, name), '--pack-destination', packs, '--json']));
    for (const file of files[0].files) assert(!/(^|\/)(\.env|\.cloud-deploy|onlyone\.toml|node_modules|src)(\/|$)/.test(file.path), `Unexpected package file: ${file.path}`);
    tarballs.push(join(packs, files[0].filename));
  }
  const prefix = join(home, 'install');
  execute(process.execPath, [npm, 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  const cli = join(prefix, 'node_modules/onlyonecli/bin/onlyone.cjs');
  const tools = join(home, 'tools'); mkdirSync(tools);
  const node = join(tools, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') copyFileSync(process.execPath, node); else symlinkSync(process.execPath, node);
  const env = { ...process.env, PATH: tools, ONLYONE_HOME: join(home, 'private home'), ONLYONE_DATA_DIR: '', ONLYONE_CONF: '', ONLYONE_SYNC: '', ONLYONE_SYNC_FAKE: '', ONLYONE_NO_MEDIC: '1', npm_execpath: npm };
  const version = JSON.parse(readFileSync(join(root, 'onlyonecli/package.json'), 'utf8')).version;
  assert.equal(execute(node, [cli, '--version'], { env }).trim(), version);
  const shim = join(prefix, 'node_modules/.bin', process.platform === 'win32' ? 'onlyone.cmd' : 'onlyone');
  assert(existsSync(shim), 'npm must install the onlyone command');
  if (process.platform === 'win32') assert.match(readFileSync(shim, 'utf8'), /onlyone\.cjs/);
  else assert.equal(execute(shim, ['--version'], { env }).trim(), version);
  assert.match(execute(node, [cli, '--help'], { env }), /OnlyOne/);
  assert.equal(execute(node, [cli, '--self-check'], { env }).trim(), 'ok');
  const setup = spawnSync(node, [cli], { env, encoding: 'utf8', timeout: 15_000, input: '' });
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /interactive terminal/);
  assert(!existsSync(join(env.ONLYONE_HOME, 'onlyone.toml')));
  console.log(`Packed npm install passed: ${platform} ${version}; Bun and the source checkout were unavailable`);
} finally { rmSync(home, { recursive: true, force: true }); }
