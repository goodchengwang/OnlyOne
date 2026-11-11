import { b64enc, handleFiles, type FilesSql } from "./files";

/** The config file is the authority: its CAS makes simultaneous first joins choose one primary. */
export async function claimPrimary(sql: FilesSql, host: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = sql.exec("SELECT content, version FROM files WHERE path = 'config.toml' AND deleted = 0").toArray()[0];
    if (!row) return null;
    const config = new TextDecoder().decode(row.content);
    const primary = config.match(/^primary\s*=\s*"([^"\n]*)"/m)?.[1];
    if (primary && primary !== "__PRIMARY__") return primary;
    if (primary === undefined) return null;
    const next = config.replace(/^primary\s*=\s*"[^"\n]*"/m, `primary = "${host}"`);
    const request = new Request("https://onlyone/api/files/commit", { method: "POST", body: JSON.stringify({
      msg: "claim first coordinator", changes: [{ path: "config.toml", base_version: row.version, content: b64enc(new TextEncoder().encode(next)) }],
    }) });
    const response = await handleFiles(sql, request, new URL(request.url), host);
    if (response?.ok) return host;
    if (response?.status !== 409) throw new Error("Could not claim coordinator");
  }
  return null;
}
