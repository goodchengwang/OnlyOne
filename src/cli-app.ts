// Release desktop apps share the npm CLI's home, runtime pointer and OS service.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA, HOME_DIR } from "./core";
import { desktopBinding, enrollDesktop, stopDevelopmentDesktop } from "./desktop";
import { lockDaemon } from "./daemon-lock";
import { installNpmService, npmServiceStatus, stopNpmService } from "./npm-service";
import { CLI_VERSION } from "./release";
import { activateNpmUpdate, checkNpmUpdate, currentRelease, stageNpmUpdate, currentPath } from "./npm-runtime";
import { npmBuild } from "./release";
import { onlyoneTomlPath, readOnlyOneToml } from "./sync";

export function appRequest(text: string) {
  let input: any;
  try { input = JSON.parse(text); } catch { throw new Error("Invalid desktop request"); }
  if (!input || typeof input.url !== "string" || input.url.length > 2048 ||
      !["start", "stop", "status", "check-update", "update"].includes(input.action) ||
      (input.session !== undefined && (typeof input.session !== "string" || input.session.length > 4096)))
    throw new Error("Invalid desktop request");
  return { action: input.action as "start" | "stop" | "status" | "check-update" | "update", url: desktopBinding(input.url).url, session: input.session ?? "" };
}

export function checkAppBinding(url: string, cfg: { cloud?: { url?: string } }) {
  if (cfg.cloud?.url && desktopBinding(cfg.cloud.url).url !== url)
    throw new Error("onlyonecli is connected to another server; local data was kept");
}

export async function cliApp() {
  const input = appRequest(await Bun.stdin.text());
  if (!npmBuild || !process.env.ONLYONE_NPM_ROOT || !process.env.ONLYONE_NODE)
    throw new Error("Install or update onlyonecli with npm, then run onlyone app through the onlyone command");
  const binding = { ...desktopBinding(input.url, HOME_DIR), data: DATA, conf: onlyoneTomlPath() };
  const reply = (latest?: Awaited<ReturnType<typeof checkNpmUpdate>>) => {
    const current = existsSync(currentPath()) ? currentRelease() : { version: CLI_VERSION };
    console.log(JSON.stringify({ protocol: 1, ...npmServiceStatus(), cli: { version: current.version,
      ...("pending" in current && current.pending ? { pending: true } : {}),
      ...(latest ? { latest: latest.version, available: latest.available } : {}) } }));
  };
  checkAppBinding(input.url, readOnlyOneToml());
  if (input.action === "status") return reply();
  mkdirSync(join(HOME_DIR, "cli"), { recursive: true, mode: 0o700 });
  let unlock: () => void;
  for (;;) {
    try { unlock = lockDaemon(join(HOME_DIR, "cli", "app-control")); break; }
    catch (e) {
      if (!(e instanceof Error) || !/already using|executor is starting/.test(e.message)) throw e;
      await Bun.sleep(100);
    }
  }
  try {
    checkAppBinding(input.url, readOnlyOneToml());
    if (input.action === "check-update") { reply(await checkNpmUpdate()); return; }
    if (input.action === "update") {
      if (npmServiceStatus().mode === "development") throw new Error("Stop the development executor before updating onlyonecli");
      const running = npmServiceStatus().running;
      if (!await stageNpmUpdate()) { reply({ version: currentRelease().version, available: false }); return; }
      const target = currentRelease().next!.version;
      await stopNpmService();
      activateNpmUpdate();
      if (running) {
        await installNpmService();
        const deadline = Date.now() + 150_000;
        while (currentRelease().pending && Date.now() < deadline) await Bun.sleep(250);
        const current = currentRelease();
        if (current.version !== target) throw new Error("CLI update failed startup and was rolled back");
        if (current.pending) throw new Error("CLI update is still awaiting startup confirmation; check status again");
      }
      reply({ version: target, available: false }); return;
    }
    await stopDevelopmentDesktop(binding);
    if (input.action === "stop") { await stopNpmService(); return reply(); }
    if (npmServiceStatus().running && (npmServiceStatus().mode === "development" || !existsSync(currentPath())))
      throw new Error("A source executor is using the CLI home; stop it before connecting onlyonecli");
    rmSync(join(HOME_DIR, "dev-source"), { force: true });
    await enrollDesktop(binding, input.session, [process.execPath]);
    await installNpmService();
    return reply();
  } finally { unlock(); }
}
