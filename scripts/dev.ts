import { join } from "node:path";
import { killDevelopmentGroup, serveDevelopment } from "../src/dev-executor";

const root = join(import.meta.dir, "..");
const prepared = Bun.spawnSync(["bash", join(root, "scripts/prepare-dev-runtime.sh")], { stdout: "inherit", stderr: "inherit" });
if (prepared.exitCode) process.exit(prepared.exitCode);
const executor = serveDevelopment();
const app = Bun.spawn(["nsh", "run", "app"], {
  cwd: root, env: { ...process.env, NSH_RUNTIME: join(root, ".nsh/dev-runtime") },
  stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true,
});
const close = () => { executor.close(); killDevelopmentGroup(app.pid); };
process.once("exit", close);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
// bun run can itself be killed without forwarding a signal to this child.
const parent = process.ppid;
const timer = setInterval(() => {
  try { process.kill(parent, 0); }
  catch { process.exit(0); }
}, 250);
try { process.exitCode = await app.exited; }
finally { clearInterval(timer); close(); }
