// The owner's files sent with a chat message (POST /api/uploads, then POST /api/messages {attachments}).
// Shared by the Worker and the local onlyone server (src/server.ts) so both accept the same files: any file the agent
// can read, up to 10 MB, up to ten at a time. What a file is decides how it is served, not whether it may be sent.

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** The image's real type from its first bytes. Phone clients often send no type, "image/jpg" or
 * "application/octet-stream" for photos; trusting the bytes is both more lenient and safer. */
export function sniffImage(head: Uint8Array, declared = ""): string {
  const b = (i: number) => head[i] ?? -1;
  const ascii = (i: number, n: number) => String.fromCharCode(...head.slice(i, i + n));
  if (b(0) === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return brand.startsWith("mif") || brand.startsWith("msf") ? "image/heif" : "image/heic";
    if (/^avi[fs]$/.test(brand)) return "image/avif";
  }
  return declared === "image/jpg" ? "image/jpeg" : declared;
}

/** Whether some bytes are a picture: a member's avatar must be one, whatever a chat message may attach. */
export const isImageBytes = (data: Uint8Array) => /^image\/[\w.+-]+$/i.test(sniffImage(data));

/** What a file's name says it is, for the files whose first bytes say nothing (text, archives, office documents). */
const EXT_TYPE: Record<string, string> = {
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", tgz: "application/gzip",
  json: "application/json", csv: "text/csv", md: "text/markdown", markdown: "text/markdown", txt: "text/plain",
  log: "text/plain", yml: "text/yaml", yaml: "text/yaml", xml: "application/xml",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
};

/** The type to store a file as: an image's own (read from its bytes, whatever the client said), else what the client
 *  declared, else its name's extension. Anything unknown is an opaque download. */
export function uploadType(head: Uint8Array, declared = "", name = ""): string {
  const image = sniffImage(head, declared);
  if (/^image\/[\w.+-]+$/i.test(image)) return image.toLowerCase();
  const told = String(declared || "").split(";")[0].trim().toLowerCase();
  if (/^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(told) && told !== "application/octet-stream") return told;
  return EXT_TYPE[(name.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase()] ?? "application/octet-stream";
}

/** The files an upload request carries (multipart `file`, `getAll`): none when it has none. Written against the one
 *  method it uses, so the Worker's and Bun's FormData both fit. */
export function uploadFiles(form: { getAll(name: string): unknown[] } | null): File[] {
  return (form ? form.getAll("file") : []).filter((f) => !!f && typeof f !== "string") as File[];
}

/** Why the owner's upload is refused (null: it is taken). Any file may be sent; only its size can make it too big. */
export function uploadProblem(size: number): { error: string; status: number } | null {
  if (!size) return { error: "empty file", status: 400 };
  if (size > MAX_UPLOAD) return { error: "file too large (10 MB max)", status: 413 };
  return null;
}

/** A stored upload's id: unique, and safe as a file name and a URL segment. */
export const uploadId = (name: string) =>
  `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${(name || "file").replace(/[^\w.\-]/g, "_").slice(-80)}`;

/** A message's attachments: up to 10 paths of the onlyone's own media ("/media/<id>"); null when malformed. */
export function ownerAttachments(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) return null;
  return v.every((x) => typeof x === "string" && /^\/media\/[\w][\w.\-]*$/.test(x) && !x.includes("..")) ? (v as string[]) : null;
}

/** Media is served from the app's own origin: anything a browser could run as a page (HTML, SVG, XML, JS…) is sent as a
 *  download, never rendered, and every response is sandboxed — an uploaded file must not be able to read the session. */
export function mediaHeaders(type: string, name: string): Record<string, string> {
  const t = String(type || "application/octet-stream").toLowerCase();
  const inline = /^(image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)(;|$)/.test(t);
  return {
    "content-type": inline ? t : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\w.\-]/g, "_")}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    "cache-control": "private, max-age=31536000",
  };
}
