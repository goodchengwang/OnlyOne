/** A GFM table's delimiter row ("|---|:--:|", "--- | ---"): dashes with optional colons, cells split by pipes. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** An ATX heading ("## Context"): a line of its own, which a hard break cannot continue. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A setext heading's underline under the line before it ("===", "---"): that line is a heading, not a paragraph. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)$/;
/** A line that is a rule of marks by itself: a hard break would turn it into text ("---\"). */
const RULE_LINE = /^ {0,3}(?:=+|-+|\*[ \t]*(?:\*[ \t]*){2,}|_[ \t]*(?:_[ \t]*){2,})$/;

/**
 * The offsets of the newlines onlyone text must keep plain because of a GFM table: the ones ending its lines (a header
 * row and a delimiter row, both with a pipe, then the rows up to the first blank line) and the one before its header,
 * which a table interrupts the paragraph at.
 */
function tableNewlines(text: string): Set<number> {
  const keep = new Set<number>();
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let at = 0, i = 0; i < lines.length; at += lines[i].length + 1, i++) starts.push(at);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes("|") || !lines[i + 1].includes("|") || !TABLE_DELIMITER.test(lines[i + 1])) continue;
    let end = i + 1;
    while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++; // body rows run to the first blank line
    if (i > 0) keep.add(starts[i] - 1);
    for (let k = i; k <= end; k++) keep.add(starts[k] + lines[k].length);
    i = end;
  }
  return keep;
}

/**
 * A decision or proposal id ("D-0015", "P-0002") is inline code: a run of the text itself, which the text draws with
 * the rest of the line. As a view placed in the text (what it was) the runtime gives it its width but paints nothing
 * when the placement does not land, and the id reads as a blank that wide (D-0015 in a task page). Inside code, a
 * link's target or a path ("tasks/done/D-0015.md") an id stays as written.
 */
export function inlineItems(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`|\]\([^)\n]*\))/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![\w/])([DP]-[A-Z]?\d{4})(?![.\w/])/g, "`$1`")))
    .join("");
}

/** OnlyOne text keeps its line breaks: single newlines become hard breaks, outside code fences, tables and headings. */
export function onlyoneMarkdown(text: string): string {
  return text
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => {
      if (i % 2) return part;
      // A "\\" ending a table row becomes part of its last cell, and on the delimiter row it ends the table.
      const table = tableNewlines(part);
      return part
        // single newlines are hard breaks, except around list items and headings (a "\\" there shows up literally)
        .replace(/([^\n])\n(?!\n|\s*(?:[-*+]|\d+[.)])\s)/g, (m0, c, off, all) => {
          // a "\" cannot continue a heading: after an ATX heading it is text ("## Context\"), and under a line
          // with a setext underline it would stop the line from being a heading at all, so those stay plain
          const start = all.lastIndexOf("\n", off) + 1;
          const nextEnd = all.indexOf("\n", off + 2);
          const next = all.slice(off + 2, nextEnd < 0 ? all.length : nextEnd);
          const line = all.slice(start, off + 1);
          const heading = ATX_HEADING.test(line) || RULE_LINE.test(line) || SETEXT_UNDERLINE.test(next);
          return table.has(off + 1) || heading || /^\s*(?:[-*+]|\d+[.)])\s/.test(line) ? `${c}\n` : `${c}\\\n`;
        })
        // Bare URLs stop at CJK / full-width punctuation and spaces ("pull/1：让" links pull/1 only).
        .replace(/(?<![(<\[`])\bhttps?:\/\/[^\s<>()\[\]`\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]+[^\s<>()\[\]`.,;:!?'"\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]/g, "<$&>");
    })
    .join("");
}
