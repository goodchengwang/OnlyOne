import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One executor per data mirror, including foreground CLI and launchd starts. */
export function lockDaemon(data: string) {
  const lock = join(data, ".daemon-lock"), owner = join(lock, "pid");
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid = 0;
      try { pid = Number(readFileSync(owner, "utf8")); } catch {}
      if (pid > 0) {
        try { process.kill(pid, 0); throw new Error("An OnlyOne executor is already using this data directory"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      } else if (Date.now() - statSync(lock).mtimeMs < 30_000) {
        throw new Error("Another OnlyOne executor is starting");
      }
      rmSync(lock, { recursive: true });
      continue;
    }
    writeFileSync(owner, String(process.pid), { mode: 0o600 });
    return () => {
      if (existsSync(owner) && readFileSync(owner, "utf8") === String(process.pid)) rmSync(lock, { recursive: true });
    };
  }
  throw new Error("Could not lock the OnlyOne data directory");
}
