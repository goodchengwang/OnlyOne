import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/** Source-mode executors validate a save before asking the existing graceful shutdown to restart them. */
export async function watchDevelopment(root: string, restart: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false, pending = false, closed = false;
  const watchers: FSWatcher[] = [];
  const close = () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  const build = async () => {
    const result = await Bun.build({ entrypoints: [join(root, "src/cli.ts")], target: "bun" });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    return Promise.all(result.outputs.map(async (file) => Bun.hash(await file.arrayBuffer()).toString()));
  };
  let previous = "";
  const check = async () => {
    if (closed) return;
    if (checking) { pending = true; return; }
    checking = true;
    try {
      const next = JSON.stringify(await build());
      if (!closed && previous && next !== previous) {
        close();
        restart();
      }
      previous = next;
    } catch (error) { console.error("Development reload: keeping the current executor; fix the source and save again.", String(error)); }
    finally {
      checking = false;
      if (pending && !closed) { pending = false; schedule(); }
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void check(), 300);
  };
  try {
    for (const directory of ["src", "cloud/src", "npm"]) {
      if (existsSync(join(root, directory))) watchers.push(watch(join(root, directory), { recursive: true }, schedule));
    }
    watchers.push(watch(root, (_, file) => {
      if (["package.json", "bun.lock", "bunfig.toml"].includes(String(file))) schedule();
    }));
    previous = JSON.stringify(await build());
  } catch (error) { close(); throw error; }
  return close;
}
