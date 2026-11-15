import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const platforms = [
  { os: "linux", cpu: "x64", target: "bun-linux-x64-baseline" },
  { os: "linux", cpu: "arm64", target: "bun-linux-arm64" },
  { os: "darwin", cpu: "x64", target: "bun-darwin-x64-baseline" },
  { os: "darwin", cpu: "arm64", target: "bun-darwin-arm64" },
  { os: "win32", cpu: "x64", target: "bun-windows-x64-baseline" },
];
export async function packageNpm(version: string, out: string, platform?: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable x.y.z version");
  const write = (dir: string, manifest: object) => {
    mkdirSync(dir, { recursive: true });
    const repository = process.env.GITHUB_REPOSITORY ? { type: "git", url: `git+${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}.git` } : undefined;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, ...(repository ? { repository } : {}) }, null, 2) + "\n");
    copyFileSync("LICENSE", join(dir, "LICENSE"));
  };
  const dependencies = Object.fromEntries(platforms.map(p => [`onlyone-${p.os === "win32" ? "windows" : p.os}-${p.cpu}`, version]));
  const main = join(out, "onlyonecli");
  write(main, { name: "onlyonecli", version, onlyoneAppProtocol: 1, description: "Your own AI team on your computers", license: "MIT", engines: { node: ">=22" }, bin: { onlyone: "bin/onlyone.cjs" }, files: ["bin/onlyone.cjs", "launcher.cjs"], optionalDependencies: dependencies });
  mkdirSync(join(main, "bin"), { recursive: true });
  copyFileSync("npm/bin/onlyone.cjs", join(main, "bin/onlyone.cjs"));
  copyFileSync("npm/launcher.cjs", join(main, "launcher.cjs"));
  writeFileSync(join(main, "README.md"), "# OnlyOne\n\nInstall: `npm install -g onlyonecli` (Node.js 22+). Run `onlyone` and enter your deployed Worker URL, owner email and email code. The CLI registers this computer and starts its background executor. Claude Code / Codex must be installed and signed in separately.\n\nLinux requires glibc and user systemd; macOS uses launchd. Windows x64 requires the onlyone-windows-x64 platform package to be published before installation from npm. Windows service support uses a current-user logon task. `onlyone update` or the app’s Update all machines action stages and validates a new npm release before draining and restarting.\n");
  const selected = platform ? platforms.filter(p => `${p.os}-${p.cpu}` === platform) : platforms;
  if (!selected.length) throw new Error(`Unsupported platform: ${platform}`);
  for (const p of selected) {
    const dir = join(out, `onlyone-${p.os === "win32" ? "windows" : p.os}-${p.cpu}`), bin = p.os === "win32" ? "onlyone.exe" : "onlyone";
    write(dir, { name: `onlyone-${p.os === "win32" ? "windows" : p.os}-${p.cpu}`, version, description: `OnlyOne executable for ${p.os}/${p.cpu}`, license: "MIT", os: [p.os], cpu: [p.cpu], ...(p.os === "linux" ? { libc: ["glibc"] } : {}), files: [`bin/${bin}`] });
    mkdirSync(join(dir, "bin"), { recursive: true });
    const child = Bun.spawn([process.execPath, "build", "src/cli.ts", "--compile", `--target=${p.target}`, `--define=ONLYONE_BUILD_VERSION=${JSON.stringify(version)}`, "--outfile", join(dir, "bin", bin)], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited) throw new Error(`Could not compile ${p.os}/${p.cpu}`);
  }
}
if (import.meta.main) {
  const [version = "0.1.3", out = "dist/npm", platform] = process.argv.slice(2);
  await packageNpm(version, resolve(out), platform);
}
