import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";

/** Check the final bytes, after executors and signatures have been added to the apps. */
export function checkAppRelease(directory: string, app: { id: string; version: string; updater: { publicKey: string } }) {
  const bytes = readFileSync(join(directory, "latest.json"));
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(app.updater.publicKey, "base64")]),
    format: "der", type: "spki",
  });
  const signature = Buffer.from(readFileSync(join(directory, "latest.json.sig"), "utf8").trim(), "base64");
  // NSH signs a domain prefix followed by the exact manifest bytes.
  assert(verify(null, Buffer.concat([Buffer.from("nsh-updater-manifest\0"), bytes]), key, signature), "Update manifest signature does not match the app's trusted key");
  const manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.id, app.id);
  assert.equal(manifest.version, app.version);
  assert.equal(manifest.package, undefined, "Full-app releases must not offer an OTA package ahead of the executor");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["android", "linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"]);
  for (const platform of ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"]) {
    const asset = manifest.platforms[platform];
    const extension = platform === "windows-x86_64" ? "zip" : "tar.gz";
    assert.equal(asset.url, `onlyone-${app.version}-${platform}.${extension}`);
    const archive = readFileSync(join(directory, asset.url));
    assert.equal(asset.size, archive.length, `${platform}: size mismatch`);
    assert.equal(asset.sha256, createHash("sha256").update(archive).digest("hex"), `${platform}: SHA-256 mismatch`);
  }
  assert.equal(manifest.platforms.android.url, `https://github.com/goodchengwang/OnlyOne/releases/download/v${app.version}/onlyone-android.apk`);
}

if (import.meta.main) {
  checkAppRelease(process.argv[2] ?? "assets", JSON.parse(readFileSync("app/nsh.json", "utf8")));
  console.log("Verified signed full-app update manifest and all desktop archives");
}
