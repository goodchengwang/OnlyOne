import { expect, test } from "bun:test";
import { prepareNpmPackage, publishedMatches } from "../scripts/publish-npm";

test("publication resumes only when immutable npm bytes match", () => {
  expect(() => publishedMatches("sha512-same", "sha512-same")).not.toThrow();
  expect(() => publishedMatches("sha512-changed", "sha512-same")).toThrow("different bytes");
  expect(() => publishedMatches("", "")).toThrow("different bytes");
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.skipIf(process.platform === "win32")("publication restores executable permission lost by artifact download", () => {
  const dir = mkdtempSync(join(tmpdir(), "onlyone-publish-mode-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ os: ["darwin"] }));
    const binary = join(dir, "bin", "onlyone");
    writeFileSync(binary, "test binary"); chmodSync(binary, 0o644);
    prepareNpmPackage(dir);
    expect(statSync(binary).mode & 0o777).toBe(0o755);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
