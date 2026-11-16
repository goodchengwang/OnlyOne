import { expect, test } from "nsh/test";
import { onlyoneMarkdown } from "./markdown";

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

test("single newlines become hard breaks", () => {
  expect(onlyoneMarkdown("one\ntwo\n\nthree")).toBe("one\\\ntwo\n\nthree");
});

test("table rows keep plain newlines, so the table still parses", () => {
  // a "\" ending the delimiter row would make it an invalid one and the whole table plain text
  expect(onlyoneMarkdown(`Summary\n\n${TABLE}\n\nafter`)).toBe(`Summary\n\n${TABLE}\n\nafter`);
  expect(onlyoneMarkdown("a | b\n:-- | --:\n1 | 2")).toBe("a | b\n:-- | --:\n1 | 2");
});

test("a table right under a line leaves that line without a hard break", () => {
  // the table interrupts the paragraph, and a "\" ending a paragraph shows up literally
  expect(onlyoneMarkdown(`Summary:\n${TABLE}`)).toBe(`Summary:\n${TABLE}`);
});

test("lines around a table still break", () => {
  expect(onlyoneMarkdown(`one\ntwo\n\n${TABLE}\n\nthree\nfour`)).toBe(`one\\\ntwo\n\n${TABLE}\n\nthree\\\nfour`);
});

test("a rule under a line is not a table: it is a setext heading, which keeps the plain newline", () => {
  // a "\" would end both the heading and the rule ("title | x\" over a "-" line is no heading at all)
  expect(onlyoneMarkdown("title | x\n---\ntext")).toBe("title | x\n---\ntext");
});

test("a heading keeps plain newlines: a hard break cannot continue one", () => {
  // a card's "## Context" line followed by its text showed the "\" of a hard break as part of the heading
  for (const h of ["# one", "## two", "### three", "###### six", "  ## indented"]) {
    expect(onlyoneMarkdown(`${h}\nbody`)).toBe(`${h}\nbody`);
  }
  // not a heading: "#tag" has no space after the hashes, so its line still breaks
  expect(onlyoneMarkdown("#tag\nbody")).toBe("#tag\\\nbody");
});

test("a setext heading keeps plain newlines too", () => {
  expect(onlyoneMarkdown("title\n===\nbody")).toBe("title\n===\nbody");
  expect(onlyoneMarkdown("title\n---\nbody")).toBe("title\n---\nbody");
});

test("a table in a code fence is left alone", () => {
  expect(onlyoneMarkdown(`\`\`\`\n${TABLE}\n\`\`\``)).toBe(`\`\`\`\n${TABLE}\n\`\`\``);
});
