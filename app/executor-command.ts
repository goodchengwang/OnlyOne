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

// These commands contain no credentials: the request goes over stdin.
export function executorCommand(os: string, directory: string, development: boolean) {
  if (os === "windows") return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", `
      ${executorEnvironment(os)}
      $command = Get-Command onlyone.cmd -ErrorAction SilentlyContinue
      if ($null -eq $command) { exit 127 }
      $input | & $command.Source app
      exit $LASTEXITCODE
    `],
  };
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
