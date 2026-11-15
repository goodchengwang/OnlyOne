import { expect, test } from "bun:test";
import { publishedMatches } from "../scripts/publish-npm";

test("publication resumes only when immutable npm bytes match", () => {
  expect(() => publishedMatches("sha512-same", "sha512-same")).not.toThrow();
  expect(() => publishedMatches("sha512-changed", "sha512-same")).toThrow("different bytes");
  expect(() => publishedMatches("", "")).toThrow("different bytes");
});
