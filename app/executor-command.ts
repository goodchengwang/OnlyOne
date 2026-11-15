// These commands contain no credentials: the request goes over stdin.
export function executorCommand(os: string, directory: string, development: boolean) {
  if (os === "windows") return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", `
      $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $env:PATH = $env:APPDATA + '\\npm;' + $env:ProgramFiles + '\\nodejs;' + $env:PATH
      $command = Get-Command onlyone.cmd -ErrorAction SilentlyContinue
      if ($null -eq $command) { exit 127 }
      $input | & $command.Source app
      exit $LASTEXITCODE
    `],
  };
  return {
    command: "/bin/sh",
    args: ["-c", `
      export PATH="$HOME/.volta/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
      if [ "$2" = development ] && [ -f "$1/../src/cli.ts" ]; then
        exec bun "$1/../src/cli.ts" desktop
      fi
      if ! command -v onlyone >/dev/null 2>&1; then
        for bin in "$HOME"/.nvm/versions/node/*/bin; do
          if [ -x "$bin/onlyone" ]; then export PATH="$bin:$PATH"; break; fi
        done
      fi
      command -v onlyone >/dev/null 2>&1 || exit 127
      exec onlyone app
    `, "onlyone-app", directory, development ? "development" : "release"],
  };
}
