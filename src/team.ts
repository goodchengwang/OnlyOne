import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Acts } from "./brain";
import { HOME_DIR, L, P, _commitPush, _pull, journal, loadConfig, locked } from "./core";
import { runAgent } from "./runner";
import { MAX_AVATAR, MEMBER_ID, type MemberView } from "../cloud/src/team";
import { sniffImage, uploadProblem } from "../cloud/src/uploads";
import { writeOp } from "../cloud/src/tools";
import { localStore } from "./brain";

/** Only custom profiles override the client's built-in localized names and pictures. */
export function members(): MemberView[] {
  if (!existsSync(P("agents"))) return [];
  return readdirSync(P("agents")).filter((id) => MEMBER_ID.test(id)).flatMap((id) => {
    try {
      const meta = JSON.parse(readFileSync(P("agents", id, "member.json"), "utf8"));
      return [{ id, ...(meta.name ? { name: String(meta.name) } : {}), ...(meta.avatar ? { avatar: String(meta.avatar) } : {}), ...(meta.revision ? { revision: String(meta.revision) } : {}) }];
    } catch { return []; }
  });
}

export async function generateAvatar(name: string, role: string, description: string): Promise<Uint8Array> {
  const cfg = loadConfig();
  if (!Bun.which(cfg.clis?.codex?.command?.[0] ?? "codex")) throw new Error("Codex is not installed; attach an image or install and sign in to Codex");
  mkdirSync(HOME_DIR, { recursive: true });
  const dir = mkdtempSync(join(HOME_DIR, "avatar-"));
  const out = join(dir, "avatar.png");
  const log = P("logs", "runs", `avatar-${Date.now()}.log`);
  try {
    const result = await runAgent("codex", `Generate ONE actual raster avatar with your built-in image_gen tool.
Use the imagegen skill. Do not use an API key, Python drawing, SVG, placeholders or a stock image.
Member: ${JSON.stringify({ name, role, description })}
Unless the description asks otherwise, make a friendly distinct illustrated character, centered head and shoulders,
simple background, square crop, no lettering, readable as a small team avatar.
Copy the generated image to this exact absolute path: ${out}
If image_gen is unavailable or fails, report the error; do not substitute another method.
Do not modify any other project or configuration. End with the saved path.`, dir,
      { ...cfg, clis: { ...cfg.clis, timeout_minutes: 5, stall_minutes: 3 } }, log);
    if (!existsSync(out)) throw new Error(`Codex did not produce an avatar: ${result.slice(-1200)}`);
    return await prepareAvatar(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function prepareAvatar(path: string): Promise<Uint8Array> {
  let data = new Uint8Array(readFileSync(path));
  const bad = uploadProblem(sniffImage(data), data.length);
  if (bad) throw new Error(bad.error);
  // shortcut: macOS has a built-in image resizer; other hosts accept images within the sync limit.
  if (Bun.which("sips")) {
    mkdirSync(HOME_DIR, { recursive: true });
    const dir = mkdtempSync(join(HOME_DIR, "avatar-resize-"));
    try {
      const out = join(dir, "avatar.png");
      const proc = Bun.spawn(["sips", "-s", "format", "png", "-Z", "256", path, "--out", out], { stdout: "ignore", stderr: "pipe" });
      const err = await new Response(proc.stderr).text();
      if (await proc.exited !== 0) throw new Error(`Avatar resize failed: ${err.slice(-500)}`);
      data = new Uint8Array(readFileSync(out));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (data.length > MAX_AVATAR) throw new Error("Avatar exceeds 1.5 MB; use a smaller image on this host");
  return data;
}

export function teamActs(host: string, io: {
  pull?: () => Promise<unknown>; push?: (msg: string) => Promise<boolean>;
  generate?: typeof generateAvatar; report?: (text: string) => void; changed?: () => void;
} = {}): Acts {
  const pull = io.pull ?? _pull, push = io.push ?? _commitPush;
  const store = () => localStore({ acts: {}, status: () => ({}), feed: () => [] });
  const persist = async (message: string) => {
    if (!await push(message)) throw new Error("Saved locally, but cloud synchronization failed; retry to confirm synchronization");
    io.changed?.();
  };
  return {
    upsert_member: async (op) => {
      // Generation runs outside the data lock so normal task claims and heartbeats can continue.
      const invalid = writeOp(op.tool, op, store());
      if (typeof invalid === "string") throw new Error(invalid);
      const isNew = !existsSync(P("agents", op.id, "profile.md"));
      let avatar: Uint8Array | undefined;
      if (op.avatar_path) {
        const root = realpathSync(P("..", "attachments")) + sep;
        const path = realpathSync(op.avatar_path);
        if (!path.startsWith(root)) throw new Error("Use an image attached by the owner");
        avatar = await prepareAvatar(path);
      } else if (op.generate_avatar === true || op.avatar_prompt || (isNew && op.generate_avatar !== false)) {
        io.report?.(L(`Generating ${op.name ?? op.id}'s avatar with Codex…`, `正在通过 Codex 为${op.name ?? op.id}生成头像…`));
        avatar = await (io.generate ?? generateAvatar)(op.name ?? op.id, op.role ?? "", op.avatar_prompt ?? "");
        const bad = uploadProblem(sniffImage(avatar), avatar.length);
        if (bad || avatar.length > MAX_AVATAR) throw new Error(bad?.error ?? "Avatar exceeds 1.5 MB");
      }
      return locked(async () => {
        await pull();
        const checked = writeOp(op.tool, op, store());
        if (typeof checked === "string") throw new Error(checked);
        const dir = P("agents", op.id);
        mkdirSync(dir, { recursive: true });
        const profile = join(dir, "profile.md");
        const previous = existsSync(profile) ? readFileSync(profile, "utf8") : "";
        const name = op.name ?? previous.match(/^Name:\s*(.+)$/m)?.[1] ?? op.id;
        const renamed = op.name ? previous.replace(/^# .+$/m, (heading) => heading.replace(/^# .*?(?=\s+[—–]\s|$)/, () => `# ${name}`)) : previous;
        let text = /^Name:.*$/m.test(renamed) ? renamed.replace(/^Name:.*$/m, () => `Name: ${name}`) : `${renamed}\nName: ${name}\n`;
        if (op.role) {
          const heading = `# ${name} — ${op.role.split("\n")[0]}`;
          text = previous ? text.replace(/^# .+$/m, () => heading) : `${heading}\n\nName: ${name}\n`;
          const section = `<!-- onlyone:role -->\n## Current owner-assigned responsibilities (override older role descriptions)\n${op.role}\n<!-- /onlyone:role -->`;
          const owned = /<!-- onlyone:role -->[\s\S]*?<!-- \/onlyone:role -->/;
          text = owned.test(text) ? text.replace(owned, () => section) : `${text.trimEnd()}\n\n${section}\n`;
        }
        let meta: MemberView = { id: op.id, ...(op.name ? { name: op.name } : {}) };
        try { meta = { ...JSON.parse(readFileSync(join(dir, "member.json"), "utf8")), ...meta }; } catch {}
        meta.revision = new Bun.CryptoHasher("sha256").update(text).digest("hex");
        if (avatar) {
          writeFileSync(join(dir, "avatar.image"), avatar);
          meta.avatar = new Bun.CryptoHasher("sha256").update(avatar).digest("hex");
        }
        writeFileSync(profile, text);
        writeFileSync(join(dir, "member.json"), JSON.stringify(meta) + "\n");
        journal(host, `👤 member ${op.id} saved${avatar ? " with avatar" : ""}`);
        await persist(`[${host}] member ${op.id}`);
        return { ok: true, member: meta, avatar: avatar ? "saved" : meta.avatar ? "kept" : "none" };
      });
    },
    upsert_routine: (op) => locked(async () => {
      await pull();
      const checked = writeOp(op.tool, op, store());
      if (typeof checked === "string") throw new Error(checked);
      const path = P("settings.json");
      const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      const { tool: _, name, ...patch } = op;
      settings.routines ??= {};
      settings.routines[name] = { ...settings.routines[name], ...patch };
      writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
      journal(host, `⏰ routine ${name} saved (owner chat)`);
      await persist(`[${host}] routine ${name}`);
      return { ok: true, routine: loadConfig().routine.find((r: any) => r.name === name) };
    }),
  };
}
