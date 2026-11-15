import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DATA, HOME_DIR, P } from "./core";
import { currentPath, ensureNpmRuntime, runtimeDir } from "./npm-runtime";
import { readOnlyOneToml } from "./sync";
import { plistEscape } from "./desktop";
import { lockDaemon } from "./daemon-lock";

export const systemdQuote = (value: string, command = true) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, () => command ? "$$" : "$").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
const xml = (s: string) => plistEscape(s);
export function serviceName(home = HOME_DIR) {
  return resolve(home) === join(homedir(), ".onlyone") ? "onlyone" : `onlyone-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12)}`;
}
export function serviceDefinition(platform: string, command: string[], home: string) {
  if (platform === "linux") return `[Unit]
Description=OnlyOne fleet daemon
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=${command.map(s => systemdQuote(s)).join(" ")}
Environment=${systemdQuote(`ONLYONE_HOME=${home}`, false)}
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=90min
[Install]
WantedBy=default.target
`;
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.${serviceName(home)}.daemon</string>
<key>ProgramArguments</key><array>${command.map(s => `<string>${xml(s)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>ONLYONE_HOME</key><string>${xml(home)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>5400</integer>
<key>StandardOutPath</key><string>${xml(join(home, "cli", "daemon.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, "cli", "daemon.log"))}</string>
</dict></plist>\n`;
  if (platform === "win32") return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userInfo().username)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Owner"><UserId>${xml(userInfo().username)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Owner"><Exec><Command>${xml(command[0])}</Command><Arguments>${xml(command.slice(1).map(s => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`).join(" "))}</Arguments></Exec></Actions>
</Task>`;
  throw new Error(`Background services are not supported on ${platform}`);
}

export function systemdEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const runtime = env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : undefined);
  if (!runtime || !existsSync(join(runtime, "bus"))) return env;
  return { ...env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus` };
}

export async function serviceRun(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.platform === "linux" ? systemdEnvironment() : process.env });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  } finally { clearTimeout(timer); }
}
async function checked(args: string[]) {
  const repair = args[0] === "systemctl" ? `
The device remains bound; the background service is unavailable.
Enable the user service manager: sudo loginctl enable-linger ${userInfo().username}
Reconnect over SSH, then retry: onlyone install
On a system without user systemd, run in the foreground: onlyone daemon` : "";
  let result;
  try { result = await serviceRun(args); }
  catch (error) { throw new Error(`Device is bound, but service command could not start: ${args[0]}\n${String(error)}${repair}`); }
  if (result.code) throw new Error(`Device is bound, but service command failed: ${args[0]} ${args.slice(1).join(" ")}\n${result.err || result.out}${repair}`);
  return result;
}
export function serviceReady() {
  try {
    const pid = Number(readFileSync(join(dirname(DATA), "service-ready"), "utf8"));
    if (!(pid > 0) || readFileSync(join(DATA, ".daemon-lock/pid"), "utf8").trim() !== String(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function withServiceLock<T>(action: () => Promise<T>): Promise<T> {
  let unlock: () => void;
  for (;;) {
    try { unlock = lockDaemon(join(runtimeDir(), "service-control")); break; }
    catch (e) {
      if (!(e instanceof Error) || !/already using|executor is starting/.test(e.message)) throw e;
      await Bun.sleep(100);
    }
  }
  try { return await action(); } finally { unlock(); }
}

export const installNpmService = () => withServiceLock(installService);
async function installService() {
  if (!readOnlyOneToml().server?.token || !existsSync(P("config.toml"))) throw new Error("Finish device setup first: onlyone init <worker-url>");
  const name = serviceName();
  if (npmServiceStatus().running && npmServiceStatus().mode === "development")
    throw new Error("Stop the development executor before starting onlyonecli");
  while (npmServiceStatus().running && existsSync(join(runtimeDir(), "stopped"))) await Bun.sleep(100);
  if (serviceReady()) return;
  rmSync(join(HOME_DIR, "dev-source"), { force: true });
  const command = ensureNpmRuntime();
  rmSync(join(runtimeDir(), "stopped"), { force: true });
  const definition = serviceDefinition(process.platform, command, HOME_DIR);
  if (process.platform === "linux") {
    const file = join(homedir(), `.config/systemd/user/${name}.service`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, definition, { mode: 0o600 });
    await checked(["systemctl", "--user", "daemon-reload"]);
    await checked(["systemctl", "--user", "enable", "--now", `${name}.service`]);
    const linger = await serviceRun(["loginctl", "enable-linger", userInfo().username]).catch(error => ({ code: 1, out: "", err: String(error) }));
    if (linger.code) console.error(`Service started, but could not enable running after logout. Run: loginctl enable-linger ${userInfo().username}\n${linger.err}`);
  } else if (process.platform === "darwin") {
    const file = join(homedir(), `Library/LaunchAgents/dev.${name}.daemon.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, definition, { mode: 0o600 });
    const domain = `gui/${process.getuid!()}`, job = `${domain}/dev.${name}.daemon`;
    await checked(["launchctl", "enable", job]);
    const state = await serviceRun(["launchctl", "print", job]);
    if (state.code) await checked(["launchctl", "bootstrap", domain, file]);
    else if (!/\bpid = \d+/.test(state.out)) await checked(["launchctl", "kickstart", job]);
  } else if (process.platform === "win32") {
    // The task does not inherit an interactive shell's environment. Pass only the home via a private entry script.
    const entry = join(runtimeDir(), "service.cjs");
    writeFileSync(entry, `process.env.ONLYONE_HOME=${JSON.stringify(HOME_DIR)};require('./launcher.cjs').run(['--service']).catch(e=>{console.error(e.message);process.exitCode=1});\n`, { mode: 0o600 });
    const task = join(runtimeDir(), "service.xml");
    writeFileSync(task, '\ufeff' + serviceDefinition("win32", [command[0], entry], HOME_DIR), "utf16le");
    await checked(["schtasks", "/Create", "/F", "/TN", name, "/XML", task]);
    await checked(["schtasks", "/Run", "/TN", name]);
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    if (serviceReady()) {
      console.log(`✔ device bound; OnlyOne service is running\n  data: ${DATA}\n  logs: ${process.platform === "linux" ? `journalctl --user -u ${name} -f` : join(runtimeDir(), "daemon.log")}`);
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Device is bound, but the service did not become ready. Check service logs; retry: onlyone install`);
}

export function npmServiceStatus() {
  let pid = 0;
  try {
    pid = Number(readFileSync(P(".daemon-lock/pid"), "utf8"));
    if (!(pid > 0)) return { running: false, stopping: false, mode: null } as const;
    process.kill(pid, 0);
  } catch { return { running: false, stopping: false, mode: null } as const; }
  const development = existsSync(join(HOME_DIR, "dev-source"));
  return { running: true, stopping: development ? !existsSync(join(HOME_DIR, "enabled")) : existsSync(join(runtimeDir(), "stopped")), mode: development ? "development" : "release" } as const;
}

/** File notifications also drain Windows tasks; terminating its process would discard running work. */
export function watchNpmStop(stop: () => void) {
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  const check = () => { if (existsSync(join(runtimeDir(), "stopped"))) stop(); };
  const watcher = watch(runtimeDir(), check);
  check();
  return () => watcher.close();
}

export const stopNpmService = () => withServiceLock(stopService);
async function stopService() {
  if (npmServiceStatus().running && (!existsSync(currentPath()) || npmServiceStatus().mode === "development")) throw new Error("A source executor is using the CLI home; stop it before connecting onlyonecli");
  if (!existsSync(runtimeDir())) return;
  writeFileSync(join(runtimeDir(), "stopped"), "", { mode: 0o600 });
  while (npmServiceStatus().running) await Bun.sleep(100);
  const name = serviceName();
  if (process.platform === "darwin") {
    const job = `gui/${process.getuid!()}/dev.${name}.daemon`;
    if (!(await serviceRun(["launchctl", "print", job])).code) {
      await checked(["launchctl", "disable", job]);
      await checked(["launchctl", "bootout", job]);
    }
  } else if (process.platform === "linux") {
    if (existsSync(join(homedir(), `.config/systemd/user/${name}.service`)))
      await checked(["systemctl", "--user", "disable", "--now", `${name}.service`]);
  } else if (process.platform === "win32") {
    if (!(await serviceRun(["schtasks", "/Query", "/TN", name])).code) {
      await checked(["schtasks", "/Change", "/TN", name, "/Disable"]);
      await serviceRun(["schtasks", "/End", "/TN", name]);
    }
  }
}
