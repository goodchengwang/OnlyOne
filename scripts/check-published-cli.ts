import { newerCliVersion } from "../src/npm-runtime";
const desktopTargets: Array<[string, string]> = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["win32", "x64"]];

/** App and CLI versions are independent; the public CLI must implement the App's control protocol. */
export async function checkPublishedCli(request: (url: string) => Promise<Response> = url => fetch(url, { signal: AbortSignal.timeout(10_000) })) {
  const get = async (name: string, version: string) => {
    const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (!response.ok) throw new Error(`${name}@${version} is not published (${response.status}); publish onlyonecli before the desktop Apps`);
    return await response.json() as any;
  };
  const cli = await get("onlyonecli", "latest");
  if (cli.onlyoneAppProtocol !== 1 || typeof cli.version !== "string" || !/^\d+\.\d+\.\d+$/.test(cli.version))
    throw new Error("Publish a stable onlyonecli with app protocol 1 before releasing desktop Apps");
  if (newerCliVersion("0.1.5", cli.version)) throw new Error("Desktop releases require onlyonecli 0.1.5 or newer with executable npm runtimes");
  const platforms: Array<{ os: string[]; cpu: string[] }> = [];
  for (const [name, version] of Object.entries(cli.optionalDependencies ?? {})) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`onlyonecli has no exact dependency: ${name}`);
    const platform = await get(name, version);
    if (platform.name !== name || platform.version !== version || !Array.isArray(platform.os) || !Array.isArray(platform.cpu))
      throw new Error(`Registry metadata mismatch: ${name}@${version}`);
    platforms.push(platform);
  }
  for (const [os, cpu] of desktopTargets)
    if (!platforms.some(p => p.os.includes(os) && p.cpu.includes(cpu))) throw new Error(`onlyonecli has no published desktop runtime for ${os}/${cpu}`);
  return cli.version as string;
}

if (import.meta.main) {
  try { console.log(`Published onlyonecli ${await checkPublishedCli()} supports all desktop Apps`); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
