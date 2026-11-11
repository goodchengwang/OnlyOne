import { platform } from "nsh";
import process from "process";
import { L } from "./i18n";

let pending: Promise<void> = Promise.resolve();
export function executor(action: "start" | "stop", config: { url: string; token: string }): Promise<void> {
  const next = pending.then(() => invokeExecutor(action, config));
  pending = next.catch(() => {});
  return next;
}

// launchd owns the executor, so closing the window or hot reloading never kills a task.
async function invokeExecutor(action: "start" | "stop", config: { url: string; token: string }): Promise<void> {
  if (platform.os !== "macos" || !process.dataDir) return;
  const directory = decodeURIComponent(new URL(".", import.meta.url).pathname);
  const child = process.spawn("/bin/sh", ["-c", `
    if [ -x "$1/../../MacOS/onlyone-executor" ]; then
      exec "$1/../../MacOS/onlyone-executor" desktop
    fi
    export PATH="$HOME/.bun/bin:$HOME/.local/share/vite-plus/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    exec bun "$1/../src/cli.ts" desktop
  `, "onlyone-executor", directory], { stdin: "pipe" });
  let diagnostic = "";
  child.on("stderr", (text) => { diagnostic = (diagnostic + text).slice(-4096); });
  const done = new Promise<void>((resolve, reject) => {
    child.on("exit", (result) => {
      if (result.code === 0) resolve();
      else {
        console.error("OnlyOne executor:", diagnostic);
        reject(new Error(L("The local executor could not start. Check its log in ~/.onlyone/app.", "本机执行服务未能启动，请查看 ~/.onlyone/app 下的日志")));
      }
    });
  });
  // A login session must never appear in a command line, plist or process listing.
  try {
    child.write(JSON.stringify({ action, url: config.url, session: config.token }));
    child.end();
    await done;
  } finally { child.dispose(); }
}
