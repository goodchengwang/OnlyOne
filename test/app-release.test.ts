import { test, expect } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppRelease } from "../scripts/check-app-release";

test("a full-app release verifies final archive bytes and refuses tampering or OTA precedence", () => {
  const directory = mkdtempSync(join(tmpdir(), "onlyone-release-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const app = { id: "dev.onlyone.app", version: "0.1.0", updater: {
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  } };
  const manifest: any = { id: app.id, version: app.version, platforms: {
    android: { url: "https://github.com/goodchengwang/OnlyOne/releases/download/v0.1.0/onlyone-android.apk" },
  } };
  function save() {
    const bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(directory, "latest.json"), bytes);
    writeFileSync(join(directory, "latest.json.sig"), sign(null, Buffer.concat([Buffer.from("nsh-updater-manifest\0"), bytes]), privateKey).toString("base64"));
  }
  try {
    for (const platform of ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"]) {
      const url = `onlyone-${app.version}-${platform}.${platform === "windows-x86_64" ? "zip" : "tar.gz"}`;
      const bytes = Buffer.from(platform);
      writeFileSync(join(directory, url), bytes);
      manifest.platforms[platform] = { url, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    save();
    expect(() => checkAppRelease(directory, app)).not.toThrow();
    const archive = join(directory, manifest.platforms["linux-x86_64"].url);
    const original = readFileSync(archive);
    writeFileSync(archive, Buffer.alloc(original.length));
    expect(() => checkAppRelease(directory, app)).toThrow("SHA-256 mismatch");
    writeFileSync(archive, original);
    manifest.package = { url: "onlyone.nshpkg" };
    save();
    expect(() => checkAppRelease(directory, app)).toThrow("must not offer an OTA");
    delete manifest.package;
    save();
    writeFileSync(join(directory, "latest.json"), "{}");
    expect(() => checkAppRelease(directory, app)).toThrow("signature");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
