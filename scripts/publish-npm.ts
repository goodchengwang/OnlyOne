import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Artifact downloads reset Unix modes to 0644; restore runtime permissions before npm packs the files. */
export function prepareNpmPackage(directory: string) {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (Array.isArray(pkg.os)) chmodSync(join(directory, "bin", pkg.os.includes("win32") ? "onlyone.exe" : "onlyone"), 0o755);
  return pkg;
}

export function publishedMatches(local: string, remote: string) {
  if (!local || local !== remote) throw new Error("Existing npm version has different bytes; refusing to skip or overwrite it");
}

async function npm(args: string[], cwd: string, capture = false) {
  const child = Bun.spawn(["npm", ...args], { cwd, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  const out = capture ? await new Response(child.stdout).text() : "";
  if (await child.exited) throw new Error(`npm ${args[0]} failed`);
  return out;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? "dist/npm");
  const packages = readdirSync(root).filter(n => n.startsWith("onlyone-")).sort().concat("onlyonecli");
  // Check all existing bytes before making any further irreversible publications.
  const missing: string[] = [];
  for (const name of packages) {
    const dir = join(root, name), pkg = prepareNpmPackage(dir);
    const expected = process.env.EXPECTED_NPM_VERSION || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME?.slice(1) : undefined);
    if (!expected || pkg.name !== name || pkg.version !== expected) throw new Error(`Artifact identity/version mismatch: ${name}`);
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) { missing.push(dir); continue; }
    if (!response.ok) throw new Error(`Cannot inspect ${pkg.name}@${pkg.version}: ${response.status}`);
    const remote = await response.json() as { dist: { integrity: string } };
    const [pack] = JSON.parse(await npm(["pack", "--dry-run", "--json"], dir, true));
    publishedMatches(pack.integrity, remote.dist.integrity);
    console.log(`Already published, exact bytes verified: ${pkg.name}@${pkg.version}`);
  }
  for (const dir of missing) await npm(["publish", "--access", "public", "--provenance"], dir);
}
