import { platform } from "nsh";
import processModule from "process";
// NSH's development bundler wraps the native default export once more.
const process = (processModule as typeof processModule & { default?: typeof processModule }).default ?? processModule;
import { L } from "./i18n";
import * as updater from "nsh/updater";
import { executorCommand } from "./executor-command";
import { executorSetupCommand, MissingExecutorTools, needsExecutorTools, parseExecutorTools } from "./executor-setup";

import type { DesktopStatus } from "../src/desktop-status";
import type { ExecutorAction } from "../src/desktop-status";
export type { ExecutorAction, DesktopStatus } from "../src/desktop-status";
export const hasExecutor = ["macos", "windows", "linux"].includes(platform.os) && !!process.dataDir;

let pending: Promise<unknown> = Promise.resolve();
export async function executorTools(install = false) {
  const launch = executorSetupCommand(platform.os, install);
  const result = await process.run(launch.command, launch.args, { timeoutMs: install ? 15 * 60_000 : 30_000 });
  if (result.code !== 0) throw new Error(L("Component installation or detection failed. Retry from Settings → Version.", "组件安装或检测未完成，请在设置 → 版本中重试。") + (result.stderr.trim() ? `\n${result.stderr.trim().slice(-600)}` : ""));
  const tools = parseExecutorTools(platform.os, result.stdout);
  if (install && needsExecutorTools(tools)) throw new Error(L("Components are still unavailable after installation. Retry from Settings → Version.", "安装后仍未检测到所需组件，请在设置 → 版本中重试。"));
  return tools;
}

export function executor(action: ExecutorAction | "status", config: { url: string; token: string }): Promise<DesktopStatus | null> {
  if (action === "status") return invokeExecutor(action, config);
  const next = pending.then(() => invokeExecutor(action, config));
  pending = next.catch(() => {});
  return next;
}

// Release services survive window close; the development executor belongs to bun dev.
async function invokeExecutor(action: ExecutorAction | "status", config: { url: string; token: string }): Promise<DesktopStatus | null> {
  if (!hasExecutor) return null;
  const directory = decodeURIComponent(new URL(".", import.meta.url).pathname);
  const info = (updater as { shellInfo?: () => { version?: string | null } }).shellInfo?.();
  const development = platform.os === "macos" && info?.version == null;
  const launch = executorCommand(platform.os, directory, development && !["check-update", "update"].includes(action));
  const child = process.spawn(launch.command, launch.args, { stdin: "pipe" });
  let output = "";
  child.on("stdout", (text) => { output = (output + text).slice(-4096); });
  let diagnostic = "";
  child.on("stderr", (text) => { diagnostic = (diagnostic + text).slice(-4096); });
  const done = new Promise<void>((resolve, reject) => {
    child.on("exit", (result) => {
      if (result.code === 0) resolve();
      else if ((result.code === 127 || result.code === 9009)) reject(new MissingExecutorTools(L("Required components are missing. Open Settings → Version and click Install missing components.", "未检测到所需组件，请在设置 → 版本中点击「安装缺少的组件」。")));
      else if (/connected to another server/.test(diagnostic)) reject(new Error(L("onlyonecli is connected to another server. Switch its server before retrying.", "本机 onlyonecli 已连接其他服务器，请先切换 CLI 的服务器再重试。")));
      else if (/Install or update onlyonecli/.test(diagnostic)) reject(new Error(L("Update onlyonecli with npm and run onlyone update, then retry.", "请通过 npm 更新 onlyonecli，并运行 onlyone update 后重试。")));
      else if (action === "update" || action === "check-update") reject(new Error(L("CLI update did not complete. Your existing version is retained or restored; retry checking the update.", "CLI 更新未完成，现有版本会保留或恢复，请重新检查更新。")));
      else {
        console.error("OnlyOne executor:", diagnostic);
        reject(new Error(L("The local executor could not start. Please try again.", "本机执行服务未能启动，请重试")));
      }
    });
  });
  // A login session must never appear in a command line, plist or process listing.
  try {
    let inputError: unknown;
    try { child.write(JSON.stringify({ action, url: config.url, session: config.token })); child.end(); }
    catch (error) { inputError = error; try { child.end(); } catch {} }
    await done;
    if (inputError) throw inputError;
    let state: any;
    try { state = JSON.parse(output.trim().split("\n").at(-1)!); } catch {}
    if (!state || (!development && state.protocol !== 1) || typeof state.running !== "boolean" || typeof state.stopping !== "boolean" || ![null, "release", "development"].includes(state.mode))
      throw new Error(L("Update onlyonecli (npm install -g onlyonecli, then onlyone update) and retry.", "请更新 onlyonecli（npm install -g onlyonecli，然后运行 onlyone update），再重试。"));
    return { running: state.running, stopping: state.stopping, mode: state.mode, ...(state.cli ? { cli: state.cli } : {}) };
  } finally { child.dispose(); }
}
