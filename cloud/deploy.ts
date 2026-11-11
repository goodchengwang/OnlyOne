// Standalone deployment: deliberately does not import src/core or read the executor's private home.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newVapidKeys } from "./src/push";

const root = join(import.meta.dir, "..");
export function deploymentConfig(env = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid ${key}`);
    return value;
  };
  const name = required("ONLYONE_WORKER_NAME"), account = required("CLOUDFLARE_ACCOUNT_ID");
  const domain = required("ONLYONE_DOMAIN"), owner = required("ONLYONE_OWNER_EMAIL").toLowerCase();
  const from = required("ONLYONE_MAIL_FROM"), key = required("ONLYONE_RESEND_API_KEY");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid Worker name or Cloudflare account");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) throw new Error("Invalid ONLYONE_DOMAIN");
  if (![owner, from].every((value) => value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value))) throw new Error("Invalid owner or sender email");
  return { name, account, domain, owner, from, key };
}

export function templateFiles(url: string, owner: string) {
  const files: { path: string; base_version: number; content: string }[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path + "/");
      else {
        let content = readFileSync(join(dir, entry.name));
        if (path === "config.toml") {
          content = Buffer.from(content.toString().replace('primary = "__PRIMARY__"', 'primary = ""')
            .replace('# url = "__URL__"', `url = ${JSON.stringify(url)}`)
            .replace('mode = "quick"', 'mode = "off"')
            .replace(/^# to = .*$/m, `to = ${JSON.stringify(owner)}`)
            + `\n[cloud]\nurl = ${JSON.stringify(url)}\n`);
        }
        files.push({ path, base_version: 0, content: content.toString("base64") });
      }
    }
  };
  walk(join(root, "templates"));
  return files;
}

export async function deployCloud() {
  const config = deploymentConfig();
  const url = `https://${config.domain}`;
  const dir = join(root, ".cloud-deploy", config.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const statePath = join(dir, "state.json");
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account };
  const wr = async (args: string[]) => {
    const process = Bun.spawn(["bunx", "wrangler", ...args], { cwd: join(root, "cloud"), env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) throw new Error(`Wrangler ${args[0]} failed: ${(stderr || stdout).slice(-2000)}`);
    return { stdout, stderr, code };
  };
  await wr(["whoami"]);
  const build = Bun.spawn(["bash", "app/build-web.sh"], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("Web client build failed; Worker was not deployed");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {
    account: config.account, domain: config.domain, instance: `cloud-${crypto.randomUUID()}`,
    token: crypto.randomUUID().replaceAll("-", ""), vapid: await newVapidKeys(),
  };
  if (state.account !== config.account || state.domain !== config.domain) throw new Error("Deployment state belongs to a different account/domain");
  if (!existsSync(statePath)) writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
  chmodSync(statePath, 0o600);
  const secretsPath = join(dir, "secrets.json");
  writeFileSync(secretsPath, JSON.stringify({
    ONLYONE_TOKEN: state.token, ONLYONE_INSTANCE: state.instance, ONLYONE_OWNER_EMAIL: config.owner,
    ONLYONE_RESEND_API_KEY: config.key, ONLYONE_MAIL_FROM: config.from,
    ONLYONE_VAPID_PUBLIC: state.vapid.publicKey, ONLYONE_VAPID_PRIVATE: JSON.stringify(state.vapid.privateJwk),
    ONLYONE_ALLOW_IPS: "",
  }), { mode: 0o600 });
  try {
    const deployed = await wr(["deploy", "--name", config.name, "--domain", config.domain, "--secrets-file", secretsPath]);
    // Wrangler lists binding names, never values, when secrets are uploaded with the version.
    console.log(deployed.stdout);
  } finally { rmSync(secretsPath, { force: true }); }
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Cloud initialization failed: ${path} HTTP ${response.status}`);
    return response.json() as Promise<any>;
  };
  const existing = await api("/api/files/changes?since=0&limit=1000");
  if (!existing.files.some((file: { path: string; deleted: boolean }) => file.path === "config.toml" && !file.deleted)) {
    if (existing.files.length || existing.more) throw new Error("Cloud has files but no config; refusing to overwrite data");
    await api("/api/files/commit", { msg: "initialize standalone cloud", changes: templateFiles(url, config.owner) });
  }
  const status = await api("/api/status");
  console.log(`✓ Cloud ready: ${url}\nLogin: ${config.owner}\nCoordinator: ${status.onlyone.primary || "waiting for the first computer"}\nConnect: onlyone init ${url}`);
  return url;
}

if (import.meta.main) await deployCloud().catch((error) => { console.error(error.message); process.exitCode = 1; });
