// These commands contain no credentials: the request goes over stdin.
export function executorCommand(os: string, directory: string, development: boolean) {
  if (os === "windows") return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", 'set "PATH=%APPDATA%\\npm;%ProgramFiles%\\nodejs;%PATH%" & where onlyone.cmd >nul 2>nul & if errorlevel 1 (exit /b 127) else (onlyone.cmd app)'],
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
