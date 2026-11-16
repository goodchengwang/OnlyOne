/** A Markdown document (an agent's report) rather than an image: shown as a file card, opened in a reader. */
export const isDoc = (url: string) => /\.(md|markdown)(\?|$)/i.test(url);
/** A picture the chat shows as one (a format the app can draw); anything else — a .zip, a .log, a .ts, a .heic — is a
 *  file card that opens it in whatever the system uses. */
export const isImageFile = (url: string) => /\.(png|jpe?g|gif|webp|avif|bmp)(\?|$)/i.test(url);
/** An attachment's file name for display, without the storage timestamps ("1731-1732-report.md" → "report.md"). */
export const attachmentName = (url: string) => {
  const last = decodeURIComponent(url.replace(/[?#].*$/, "").split("/").pop() || "");
  return last.replace(/^(\d{10,}-)+/, "") || last;
};
/** A file whose bytes are text (a log, a script, a CSV): the chat shows it in its reader, where it needs no browser —
 *  and no session token in a browser's address bar — to be read. */
const TEXT_EXT = /\.(md|markdown|txt|log|json|jsonl|csv|tsv|ya?ml|toml|xml|html?|css|m?js|tsx?|jsx|py|rb|go|rs|java|c|h|cpp|cc|sh|zsh|sql|ini|conf|env|patch|diff)(\?|$)/i;
export const isTextFile = (url: string) => TEXT_EXT.test(url);

/** An attachment's extension in capitals, for its card ("report.zip" → "ZIP"). */
export const fileExt = (name: string) => (name.match(/\.(\w+)$/)?.[1] ?? "").toUpperCase().slice(0, 4);

const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
};
/** What a name's extension says a file is, for the files whose bytes say nothing (documents, code, archives). */
const FILE_EXT: Record<string, string> = {
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", tgz: "application/gzip",
  json: "application/json", csv: "text/csv", md: "text/markdown", markdown: "text/markdown", txt: "text/plain",
  log: "text/plain", yml: "text/yaml", yaml: "text/yaml", xml: "application/xml",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
};

/** The image type of a file, from its media type or else its name's extension; null when it is not an image (SVG is not taken). */
export function imageType(type: string | undefined, name: string): string | null {
  if (type && /^image\/[\w.+-]+$/i.test(type) && !/svg/i.test(type)) return type.toLowerCase();
  return IMAGE_EXT[(name.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase()] ?? null;
}

/** The type to send a file with: an image's own (its name decides when the device gave none), else what the device says,
 *  else its name's extension; "" when nothing knows, and the server reads the bytes. */
export function fileType(type: string | undefined, name: string): string {
  const image = imageType(type, name);
  if (image) return image;
  const told = (type ?? "").toLowerCase();
  if (/^[\w.+-]+\/[\w.+-]+$/.test(told)) return told;
  return FILE_EXT[(name.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase()] ?? "";
}

/** Whether a file shows as a picture in the app: a format it can draw (HEIC, HEIF and SVG do not, and go as file cards). */
export const showsAsImage = (type: string) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(type);

/** A file's size in words: "812 B", "24 KB", "2.4 MB". */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the composer takes: a file of at most 10 MB, up to ten at a time. */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_COUNT = 10;
/** Why a file cannot be attached: "big" or "many"; "" when it can (onlyone.ts words it for the owner). */
export const attachIssue = (size: number, count: number): "" | "big" | "many" =>
  size > ATTACH_MAX_BYTES ? "big" : count >= ATTACH_MAX_COUNT ? "many" : "";
