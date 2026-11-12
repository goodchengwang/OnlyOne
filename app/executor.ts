import { platform } from "nsh";
import processModule from "process";
// NSH's development bundler wraps the native default export once more.
const process = (processModule as typeof processModule & { default?: typeof processModule }).default ?? processModule;
import { L } from "./i18n";

import type { DesktopStatus } from "../src/desktop-status";
export type { DesktopStatus } from "../src/desktop-status";
export const hasExecutor = platform.os === "macos" && !!process.dataDir;

let pending: Promise<unknown> = Promise.resolve();
export function executor(action: "start" | "stop" | "status", config: { url: string; token: string }): Promise<DesktopStatus | null> {
  if (action === "status") return invokeExecutor(action, config);
  const next = pending.then(() => invokeExecutor(action, config));
  pending = next.catch(() => {});
  return next;
}

// launchd owns the executor, so closing the window or hot reloading never kills a task.
async function invokeExecutor(action: "start" | "stop" | "status", config: { url: string; token: string }): Promise<DesktopStatus | null> {
  if (!hasExecutor) return null;
  const directory = decodeURIComponent(new URL(".", import.meta.url).pathname);
  const child = process.spawn("/bin/sh", ["-c", `
    if [ -x "$1/../../MacOS/onlyone-executor" ]; then
      exec "$1/../../MacOS/onlyone-executor" desktop
    fi
    export PATH="$HOME/.bun/bin:$HOME/.local/share/vite-plus/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    exec bun "$1/../src/cli.ts" desktop
  `, "onlyone-executor", directory], { stdin: "pipe" });
  let output = "";
  child.on("stdout", (text) => { output = (output + text).slice(-4096); });
  let diagnostic = "";
  child.on("stderr", (text) => { diagnostic = (diagnostic + text).slice(-4096); });
  const done = new Promise<void>((resolve, reject) => {
    child.on("exit", (result) => {
      if (result.code === 0) resolve();
      else {
        console.error("OnlyOne executor:", diagnostic);
        reject(new Error(L("The local executor could not start. Please try again.", "本机执行服务未能启动，请重试")));
      }
    });
  });
  // A login session must never appear in a command line, plist or process listing.
  try {
    child.write(JSON.stringify({ action, url: config.url, session: config.token }));
    child.end();
    await done;
    return JSON.parse(output.trim().split("\n").at(-1)!) as DesktopStatus;
  } finally { child.dispose(); }
}
