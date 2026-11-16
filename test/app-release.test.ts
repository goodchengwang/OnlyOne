import { test, expect } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppRelease } from "../scripts/check-app-release";

test("a release requires OTA and verifies final package and archive bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "onlyone-release-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const app = { id: "dev.onlyone.app", version: "0.1.0", updater: {
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  } };
  const pkgBytes = Buffer.from("signed OTA package fixture");
  const pkg = { version: app.version, build: 15, url: `onlyone-${app.version}.nshpkg`,
    size: pkgBytes.length, sha256: createHash("sha256").update(pkgBytes).digest("hex") };
  writeFileSync(join(directory, pkg.url), pkgBytes);
  const manifest: any = { id: app.id, version: app.version, package: pkg, platforms: {
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
    writeFileSync(join(directory, pkg.url), Buffer.alloc(pkgBytes.length));
    expect(() => checkAppRelease(directory, app)).toThrow("OTA: SHA-256 mismatch");
    writeFileSync(join(directory, pkg.url), pkgBytes);
    manifest.package = { ...pkg, build: 0 };
    save();
    expect(() => checkAppRelease(directory, app)).toThrow("OTA build");
    delete manifest.package;
    save();
    expect(() => checkAppRelease(directory, app)).toThrow("must offer a signed OTA package");
    manifest.package = pkg;
    save();
    writeFileSync(join(directory, "latest.json"), "{}");
    expect(() => checkAppRelease(directory, app)).toThrow("signature");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
