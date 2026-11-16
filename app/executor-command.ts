// Shared by detection, installation and execution so GUI launches find the same tools.
export function executorEnvironment(os: string) {
  if (os === "windows") return `
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $tools = Join-Path $env:USERPROFILE '.onlyone\\tools'
    $env:PATH = $tools + ';' + $env:APPDATA + '\\npm;' + $env:ProgramFiles + '\\nodejs;' + $env:PATH
    $ready = $false
    try {
      if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        $ready = !!(& node -p 'Number(process.versions.node.split(".")[0]) >= 22' 2>$null | Select-String '^true$')
        if ($ready) { & npm.cmd --version 2>$null | Out-Null; $ready = $LASTEXITCODE -eq 0 }
      }
    } catch { $ready = $false }
    if (!$ready) {
      $env:PATH = (Join-Path $tools 'node') + ';' + $env:PATH
    }
  `;
  return `
    tools="$HOME/.onlyone/tools"
    export PATH="$tools/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
    if ! command -v onlyone >/dev/null 2>&1; then
      for bin in "$HOME"/.nvm/versions/node/*/bin; do
        if [ -x "$bin/onlyone" ]; then export PATH="$bin:$PATH"; break; fi
      done
    fi
    if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
      for bin in "$HOME"/.nvm/versions/node/*/bin; do
        if "$bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 && [ -x "$bin/npm" ]; then export PATH="$bin:$PATH"; break; fi
      done
      if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
        export PATH="$tools/node/bin:$PATH"
      fi
    fi
  `;
}

// The launcher runs under cmd.exe, not powershell.exe: PowerShell line-buffers a
// native child's stdout and appends a trailing newline, while the desktop client
// reads the executor's JSON off that stream byte for byte.
//
// The whole script is one argv element that the spawner re-quotes for Windows
// with backslashes; neither cmd.exe nor powershell.exe reads a backslash as an
// escape, so it stays free of double quotes and of parenthesised blocks.
function windowsLaunchEnvironment() {
  const tools = "%USERPROFILE%\\.onlyone\\tools";
  const searchPath = (node: boolean) =>
    [node ? `${tools}\\node` : "", tools, "%APPDATA%\\npm", "%ProgramFiles%\\nodejs"].filter(Boolean).join(";");
  return [
    `set PATH=${searchPath(false)};%PATH%`,
    // A Node.js below 22 cannot run the CLI, so fall back to the copy installed
    // into the tools root. Same policy as executorEnvironment below, in cmd
    // syntax; node -e carries the exit code and prints nothing.
    `node -e process.exit(Math.max(0,22-process.versions.node.split('.')[0])) 2>nul && call npm.cmd --version>nul 2>nul || set PATH=${searchPath(true)};%PATH%`,
  ].join(" & ");
}

// These commands contain no credentials: the request goes over stdin.
export function executorCommand(os: string, directory: string, development: boolean) {
  if (os === "windows") {
    const script = [
      windowsLaunchEnvironment(),
      "where onlyone.cmd >nul 2>nul || exit /b 127",
      "call onlyone.cmd app",
    ].join(" & ");
    return { command: "cmd.exe", args: ["/d", "/s", "/c", script] };
  }
  return {
    command: "/bin/sh",
    args: ["-c", `
      ${executorEnvironment(os)}
      if [ "$2" = development ] && [ -f "$1/../src/cli.ts" ]; then
        exec bun "$1/../src/cli.ts" desktop
      fi
      command -v onlyone >/dev/null 2>&1 || exit 127
      exec onlyone app
    `, "onlyone-app", directory, development ? "development" : "release"],
  };
}
