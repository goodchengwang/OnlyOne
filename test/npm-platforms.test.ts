import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platforms } from "../scripts/package-npm";

// The publish job refuses to publish anything unless every package it built already exists on npm,
// so a platform in the build matrix without a published package blocks the whole release (win32-x64
// did exactly that). The matrix and the platform list must therefore never drift apart.
test("the npm workflow packages exactly the platforms that package-npm builds", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/npm.yml"), "utf8");
  const matrix = [...workflow.matchAll(/- \{ platform: ([a-z0-9]+-[a-z0-9]+), runner: /g)].map(m => m[1]);
  expect(matrix).toEqual(platforms.map(p => `${p.os}-${p.cpu}`));
});

test("every packaged platform yields a platform package plus the main package", () => {
  expect(platforms.map(p => `onlyone-${p.os}-${p.cpu}`)).toEqual([
    "onlyone-linux-x64",
    "onlyone-linux-arm64",
    "onlyone-darwin-x64",
    "onlyone-darwin-arm64",
  ]);
});
