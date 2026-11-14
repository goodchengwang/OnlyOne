import { platform } from "nsh";
import processModule from "process";
const process = (processModule as typeof processModule & { default?: typeof processModule }).default ?? processModule;
export const canPickProjectFolder = platform.os === "macos" && !!process.dataDir;

/** Pinned NSH has file/image pickers but no directory picker. Standard Additions supplies the Mac folder dialog. */
export async function pickProjectFolder(): Promise<{ path: string; host: string } | null> {
  if (!canPickProjectFolder) throw new Error("Folder selection is unavailable on this device");
  const child = process.spawn("/bin/sh", ["-c", `
    /usr/bin/osascript -e 'try' -e 'POSIX path of (choose folder with prompt "选择项目源文件夹 / Choose project folder")' -e 'on error number -128' -e 'return ""' -e 'end try'
    result=$?
    [ "$result" -eq 0 ] || exit "$result"
    /bin/hostname -s
  `]);
  let output = "";
  const done = new Promise<void>((resolve, reject) => {
    child.on("stdout", (s) => { output += s; });
    child.on("exit", ({ code }) => code === 0 ? resolve() : reject(new Error("Could not open the folder chooser")));
  });
  try {
    await done;
    const lines = output.split("\n");
    const path = lines[0].trim(), host = lines[1]?.trim() ?? "";
    return path ? { path, host } : null;
  } finally { child.dispose(); }
}
