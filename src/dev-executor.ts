import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, DATA } from "./core";
import { lockDaemon } from "./daemon-lock";
import { appRequest, checkAppBinding } from "./cli-app";
import { desktopBinding, enrollDesktop, stopDevelopmentJobs } from "./desktop";
import { npmServiceStatus, stopNpmService } from "./npm-service";
import { onlyoneTomlPath } from "./sync";

/** Development children get their own process group so agents cannot outlive bun dev. */
export function killDevelopmentGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export function serveDevelopment(options: { root?: string; cli?: string[] } = {}) {
  const home = options.root ?? HOME_DIR, data = options.root ? join(home, "data") : DATA;
  const cli = options.cli ?? [process.execPath, join(import.meta.dir, "cli.ts")];
  const unlock = lockDaemon(join(home, "cli/dev-control"));
  const socket = join(home, "dev-control.sock"), ready = join(data, "..", "service-ready");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let wanted = false, closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  const status = () => child?.exitCode === null
    ? { running: true, stopping: false, mode: "development" as const }
    : options.root ? { running: false, stopping: false, mode: null } : npmServiceStatus();
  const stop = async () => {
    wanted = false;
    if (child) { killDevelopmentGroup(child.pid); await child.exited; child = undefined; }
    rmSync(join(home, "enabled"), { force: true });
  };
  const spawn = () => {
    const next = Bun.spawn([...cli, "daemon"], {
      env: { ...process.env, ONLYONE_HOME: home, ONLYONE_DATA_DIR: data,
        ONLYONE_CONF: options.root ? join(home, "onlyone.toml") : onlyoneTomlPath(), ONLYONE_DEV_PID: String(process.pid) },
      stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
    });
    child = next;
    void next.exited.then(code => {
      // Also clean up agents when a daemon crashes or finishes a source reload.
      killDevelopmentGroup(next.pid);
      if (child !== next) return;
      child = undefined;
      if (wanted && !closed && code === 0) spawn();
      else if (wanted && code !== 0) console.error(`Development executor exited (${code}); retry Start in the app.`);
    });
  };
  const control = async (text: string) => {
    const input = appRequest(text);
    const binding = { ...desktopBinding(input.url, home), data,
      conf: options.root ? join(home, "onlyone.toml") : onlyoneTomlPath() };
    const saved = existsSync(binding.conf) ? Bun.TOML.parse(readFileSync(binding.conf, "utf8")) as any : {};
    checkAppBinding(binding.url, saved);
    if (input.action === "status") return status();
    if (!["start", "stop"].includes(input.action)) throw new Error("Use onlyonecli for release updates");
    await stopDevelopmentJobs(binding);
    if (input.action === "stop") { await stop(); return status(); }
    if (!options.root && npmServiceStatus().mode === "release") await stopNpmService();
    await enrollDesktop(binding, input.session, cli);
    if (closed) throw new Error("Development session ended");
    const local = join(data, "config.local.toml");
    const overrides = existsSync(local) ? readFileSync(local, "utf8") : "";
    if (!saved.server?.token && !/^\[server\]/m.test(overrides))
      appendFileSync(local, '\n[server]\nenabled = false\n[tunnel]\nmode = "off"\n', { mode: 0o600 });
    if (!saved.server?.token && !/^\[cloud\]/m.test(overrides))
      appendFileSync(local, `\n[cloud]\nurl = ${JSON.stringify(binding.url)}\n`, { mode: 0o600 });
    writeFileSync(join(home, "dev-source"), cli[1], { mode: 0o600 });
    writeFileSync(join(home, "enabled"), "", { mode: 0o600 });
    wanted = true;
    if (!child) spawn();
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!child) throw new Error("Development executor exited before becoming ready; see the bun dev terminal");
      if (existsSync(ready) && readFileSync(ready, "utf8").trim() === String(child.pid)) return status();
      await Bun.sleep(250);
    }
    throw new Error("Development executor did not become ready; see the bun dev terminal");
  };
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    rmSync(socket, { force: true });
    const server = Bun.serve({ unix: socket, maxRequestBodySize: 16_384, async fetch(request) {
      const text = await request.text();
      const result = pending.then(() => control(text));
      pending = result.catch(() => {});
      try { return Response.json(await result); }
      catch (error) { return new Response(error instanceof Error ? error.message : "Development executor failed", { status: 400 }); }
    } });
    chmodSync(socket, 0o600);
    return {
      close() {
        if (closed) return;
        closed = true; wanted = false;
        if (child) killDevelopmentGroup(child.pid);
        server.stop(true);
        rmSync(socket, { force: true });
        rmSync(join(home, "enabled"), { force: true });
        unlock();
      },
    };
  } catch (error) { unlock(); throw error; }
}
