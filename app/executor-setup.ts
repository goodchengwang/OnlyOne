import { executorEnvironment } from "./executor-command";

export type ExecutorTools = { node: string | null; npm: string | null; cli: string | null };
export class MissingExecutorTools extends Error {}
export const needsExecutorTools = (tools: ExecutorTools) => !tools.node || !(Number(tools.node.replace(/^v/, "").split(".")[0]) >= 22) || !tools.npm || !tools.cli;

/** Only explicit installation downloads anything; status is entirely local. */
export function executorSetupCommand(os: string, install = false) {
  if (os === "windows") return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      ${executorEnvironment(os)}
      function Version($name) {
        if (Get-Command $name -ErrorAction SilentlyContinue) {
          try {
            $value = & $name --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $value) { return ($value | Select-Object -Last 1).Trim() }
          } catch {}
        }
        return $null
      }
      ${install ? `
      if (!(Version node) -or [int]((Version node).TrimStart('v').Split('.')[0]) -lt 22 -or !(Version npm.cmd)) {
        if (![Environment]::Is64BitOperatingSystem) { throw 'OnlyOne requires 64-bit Windows' }
        New-Item -ItemType Directory -Force -Path $tools | Out-Null
        $work = Join-Path $tools ([Guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $work | Out-Null
        try {
          $base = 'https://nodejs.org/dist/latest-v22.x'
          $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 60).Content
          $match = [regex]::Match($sums, '(?m)^([a-f0-9]{64})\\s+(node-v22\\.\\d+\\.\\d+-win-x64\\.zip)\\s*$')
          if (!$match.Success) { throw 'Node.js download checksum is missing' }
          $file = $match.Groups[2].Value
          $archive = Join-Path $work $file
          Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $archive -TimeoutSec 600
          if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $match.Groups[1].Value) { throw 'Node.js checksum mismatch' }
          Expand-Archive -Path $archive -DestinationPath $work
          $node = Join-Path $work ($file -replace '\\.zip$', '')
          & (Join-Path $node 'node.exe') --version | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'Node.js startup failed' }
          $target = Join-Path $tools 'node'
          if (Test-Path $target) { Move-Item $target (Join-Path $work 'previous-node') }
          try { Move-Item $node $target } catch {
            if (Test-Path (Join-Path $work 'previous-node')) { Move-Item (Join-Path $work 'previous-node') $target }
            throw
          }
          $env:PATH = $target + ';' + $env:PATH
        } finally { Remove-Item -Recurse -Force $work }
      }
      if (!(Version onlyone.cmd)) {
        & npm.cmd install --global --prefix $tools --ignore-scripts --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org onlyonecli
        if ($LASTEXITCODE -ne 0) { throw 'onlyonecli installation failed' }
      }
      ` : ""}
      @{ node = (Version node); npm = (Version npm.cmd); cli = (Version onlyone.cmd) } | ConvertTo-Json -Compress
    `],
  };
  return {
    command: "/bin/sh",
    args: ["-c", `
      ${executorEnvironment(os)}
      ${install ? `
      set -e
      umask 077
      if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 || ! npm --version >/dev/null 2>&1; then
        case "$(uname -s)-$(uname -m)" in
          Darwin-arm64) suffix=darwin-arm64.tar.gz ;;
          Darwin-x86_64) suffix=darwin-x64.tar.gz ;;
          Linux-aarch64) suffix=linux-arm64.tar.gz ;;
          Linux-x86_64) suffix=linux-x64.tar.gz ;;
          *) echo 'Unsupported Node.js platform' >&2; exit 1 ;;
        esac
        mkdir -p "$tools"
        work=$(mktemp -d "$tools/install.XXXXXX")
        trap 'rm -rf "$work"' EXIT
        base=https://nodejs.org/dist/latest-v22.x
        curl -fsSL --connect-timeout 15 --max-time 60 "$base/SHASUMS256.txt" -o "$work/sums"
        entry=$(awk -v suffix="$suffix" '$2 ~ ("^node-v22[.][0-9]+[.][0-9]+-" suffix "$") && length($1) == 64 && $1 !~ /[^a-f0-9]/ { print; exit }' "$work/sums")
        [ -n "$entry" ] || { echo 'Node.js download checksum is missing' >&2; exit 1; }
        checksum=$(printf '%s' "$entry" | awk '{print $1}')
        file=$(printf '%s' "$entry" | awk '{print $2}')
        curl -fsSL --connect-timeout 15 --max-time 600 "$base/$file" -o "$work/node.tar.gz"
        if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$work/node.tar.gz"); else actual=$(sha256sum "$work/node.tar.gz"); fi
        [ "$(printf '%s' "$actual" | awk '{print $1}')" = "$checksum" ] || { echo 'Node.js checksum mismatch' >&2; exit 1; }
        mkdir "$work/node"
        tar -xzf "$work/node.tar.gz" --strip-components=1 -C "$work/node"
        "$work/node/bin/node" --version >/dev/null
        if [ -e "$tools/node" ]; then mv "$tools/node" "$work/previous-node"; fi
        mv "$work/node" "$tools/node" || { if [ -e "$work/previous-node" ]; then mv "$work/previous-node" "$tools/node"; fi; exit 1; }
        export PATH="$tools/node/bin:$PATH"
      fi
      if ! onlyone --version >/dev/null 2>&1; then
        npm install --global --prefix "$tools" --ignore-scripts --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org onlyonecli
        hash -r
      fi
      ` : ""}
      node_version=$(node --version 2>/dev/null) || node_version=
      npm_version=$(npm --version 2>/dev/null) || npm_version=
      cli_version=$(onlyone --version 2>/dev/null) || cli_version=
      printf 'ONLYONE_TOOLS\\t%s\\t%s\\t%s\\n' "$node_version" "$npm_version" "$cli_version"
    `],
  };
}

export function parseExecutorTools(os: string, output: string): ExecutorTools {
  if (os === "windows") {
    const value = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    if (![value.node, value.npm, value.cli].every((v) => v === null || typeof v === "string")) throw new Error("Invalid component status");
    return { node: value.node, npm: value.npm, cli: value.cli };
  }
  const line = output.replace(/[\r\n]+$/, "").split(/\r?\n/).at(-1)!;
  const [marker, node, npm, cli] = line.split("\t");
  if (marker !== "ONLYONE_TOOLS" || cli === undefined) throw new Error("Invalid component status");
  return { node: node || null, npm: npm || null, cli: cli || null };
}
