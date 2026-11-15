// Shared by the npm command and the private, stable service entry point.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) {
  fs.writeFileSync(file + '.next', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.next', file);
}
function platformBinary(root) {
  const name = `onlyone-${process.platform}-${process.arch}`;
  if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'].includes(`${process.platform}-${process.arch}`))
    throw new Error(`OnlyOne does not support ${process.platform}/${process.arch}`);
  if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime)
    throw new Error('OnlyOne requires glibc Linux; Alpine/musl is not supported yet');
  try {
    return path.join(path.dirname(require.resolve(name + '/package.json', { paths: [root] })), 'bin', process.platform === 'win32' ? 'onlyone.exe' : 'onlyone');
  } catch { throw new Error(`Missing ${name}. Reinstall onlyonecli with npm optional dependencies enabled.`); }
}
function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const shim = path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (fs.existsSync(shim)) {
      const real = fs.realpathSync(shim);
      candidates.push(real.endsWith('.js') ? real : path.join(path.dirname(real), 'node_modules/npm/bin/npm-cli.js'));
    }
  }
  return candidates.find(file => file && fs.existsSync(file) && file.endsWith('.js'));
}
async function run(args, root) {
  const home = path.resolve((process.env.ONLYONE_HOME || path.join(os.homedir(), '.onlyone')).replace(/^~/, os.homedir()));
  const currentFile = path.join(home, 'cli/current.json');
  const service = args[0] === '--service';
  let env = { ...process.env };
  if (service) env = { ...env, ...read(path.join(home, 'cli/service.json')) };
  else {
    env.ONLYONE_NPM_ROOT = root;
    env.ONLYONE_NODE = process.execPath;
    const npm = npmCli();
    if (npm) env.ONLYONE_NPM_CLI = npm;
    const profile = path.join(home, 'cli/service.json');
    if (args[0] === 'app' && fs.existsSync(profile)) {
      const saved = read(profile);
      if (path.resolve(saved.ONLYONE_HOME || home) !== home) throw new Error('CLI service profile belongs to another home');
      env = { ...env, ...saved };
    }
  }
  const stoppedFile = path.join(home, 'cli/stopped');
  if (service && fs.existsSync(stoppedFile)) return;
  let stopping = false, child;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
  });
  do {
    const state = fs.existsSync(currentFile) ? read(currentFile) : null;
    const binary = state ? state.binary : platformBinary(root);
    const started = Date.now();
    const log = service && process.platform === 'win32' ? fs.openSync(path.join(home, 'cli/daemon.log'), 'a', 0o600) : null;
    child = spawn(binary, service ? ['daemon'] : args, { env, stdio: log === null ? 'inherit' : ['ignore', log, log], windowsHide: service });
    if (log !== null) fs.closeSync(log);
    let ready = false, timer;
    const stopUnready = () => {
      const elapsed = Date.now() - started;
      if (elapsed > 135_000) child.kill('SIGKILL');
      else if (elapsed > 120_000) child.kill('SIGTERM');
    };
    if (service && state.pending) timer = setInterval(() => {
      try {
        const readyFile = path.join(path.dirname(env.ONLYONE_DATA_DIR), 'service-ready');
        ready = fs.readFileSync(readyFile, 'utf8').trim() === String(child.pid);
        if (ready && Date.now() - started > 10_000) {
          const latest = read(currentFile);
          if (latest.version === state.version) write(currentFile, { ...latest, pending: false });
          clearInterval(timer);
        } else stopUnready();
      } catch { stopUnready(); }
    }, 250);
    const code = await new Promise(resolve => {
      child.once('error', error => { console.error(`Could not start OnlyOne: ${error.message}`); resolve(1); });
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    clearInterval(timer);
    if (!service) { process.exitCode = code; return; }
    if (fs.existsSync(stoppedFile)) return;
    // Only an unconfirmed candidate rolls back. Ordinary daemon failures use the service retry delay.
    const latest = read(currentFile);
    let rolledBack = false;
    if (!stopping && latest.version === state.version && latest.pending && latest.previous) {
      console.error(`OnlyOne ${state.version} failed startup; restoring ${latest.previous.version}`);
      write(currentFile, latest.previous);
      rolledBack = true;
      fs.writeFileSync(path.join(home, 'update-rejected'), state.version, { mode: 0o600 });
      let update = {};
      try { update = read(path.join(home, 'update-state.json')); } catch {}
      write(path.join(home, 'update-state.json'), { ...update, state: 'failed', detail: `Startup failed; restored ${latest.previous.version}`, ts: new Date().toISOString() });
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, rolledBack ? 0 : 10_000));
  } while (!stopping);
}
module.exports = { run, platformBinary, npmCli };
if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
