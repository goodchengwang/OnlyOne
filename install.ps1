# OnlyOne installer (Windows), run .\install.ps1 from a local source checkout.
$ErrorActionPreference = "Stop"
$HomeDir = if ($env:ONLYONE_HOME) { $env:ONLYONE_HOME } else { "$HOME\.onlyone" }
$App = $PSScriptRoot
if (-not $App -or -not (Test-Path "$App\src\cli.ts") -or -not (Test-Path "$App\package.json")) { throw "OnlyOne source missing: run install.ps1 from a complete local checkout." }
$Log = "$HomeDir\install.log"
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
Set-Content -Path $Log -Value ""

function Step($name) { Write-Host ("  {0,-30}" -f $name) -NoNewline -ForegroundColor DarkGray }
function Ok($msg = "") { Write-Host "$([char]0x2713) $msg" -ForegroundColor Green }
# Windows PowerShell 5.1 turns each stderr line of a redirected native command into an error record, and under
# "Stop" the first one aborts the install, even when it is only curl, git or bun printing progress. Run logs
# everything and judges native commands by their exit code instead.
function Run {
  param([scriptblock]$b)
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = 0
  & $b *>> $Log
  if ($LASTEXITCODE) { throw "exit code $LASTEXITCODE (see $Log)" }
}

trap {
  Write-Host ([char]0x2717) -ForegroundColor Red
  Write-Host "`n  Something went wrong. Asking the AI medic to fix it (details: $Log)`n"
  if ((Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path "$App\src\cli.ts")) { bun "$App\src\cli.ts" fix "install.ps1 failed: $_ . Log: $Log" }
  elseif (Get-Command claude -ErrorAction SilentlyContinue) { claude -p "OnlyOne install.ps1 failed on Windows: $_ . Read $Log, fix the cause, then rerun the installer." }
  break
}

Write-Host "`nOnlyOne - your own AI team`n"
Step "bun"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  # bun's installer sets "Stop" itself, so it gets a PowerShell of its own where nothing redirects its curl.exe.
  Run { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" }
  $env:Path += ";$HOME\.bun\bin"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun did not install (see $Log)" }
} else { Run { bun upgrade } }  # an old bun cannot read a newer bun.lock
Ok (bun --version)
Step "OnlyOne"
Push-Location $App; Run { bun install --frozen-lockfile }; Pop-Location
# the onlyone command: bin\onlyone.cmd, on the user's PATH from the next terminal on and in this one now
$Bin = "$App\bin"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ";") -contains $Bin)) { [Environment]::SetEnvironmentVariable("Path", (@($UserPath, $Bin) | Where-Object { $_ }) -join ";", "User") }
if (-not (($env:Path -split ";") -contains $Bin)) { $env:Path += ";$Bin" }
Ok $App

if ($env:ONLYONE_GUEST) {
  # A guest gets its own revocable token and nothing else: no init, no owner login, no fleet data, no service.
  $Guest = $env:ONLYONE_GUEST -split "\s+" | Where-Object { $_ }
  Remove-Item Env:ONLYONE_GUEST
  if ($Guest.Count -ne 2) { throw "ONLYONE_GUEST must be `"<onlyone-url> <code>`", as printed by onlyone guest invite" }
  Step "AI tools"
  $have = @("claude", "codex") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
  if ($have) { Ok ($have -join ", ") } else { Write-Host "! install claude (or codex) and log in; the guest runs tasks with this account's own login" -ForegroundColor Yellow }
  Step "guest"
  Run { bun "$App\src\cli.ts" guest join $Guest[0] $Guest[1] }
  Ok
  Step "background service"; Run { bun "$App\src\cli.ts" guest install }; Ok
  Write-Host "`n  The guest now runs in the background and at every login of this account (log: ~\.onlyone-guest\guest.log).`n  Stop it with: onlyone guest uninstall`n"
  return
}

Step "AI tools"
$missing = @("claude", "codex", "gh") | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) { Write-Host "! missing: $($missing -join ', ') (install and log in for full capability)" -ForegroundColor Yellow } else { Ok "claude, codex, gh" }
Write-Host ""

$env:ONLYONE_HOME = $HomeDir
bun "$App\src\cli.ts" init @args   # joins your OnlyOne; the first machine passes --primary
Step "background service"; Run { bun "$App\src\cli.ts" install }; Run { powercfg /change standby-timeout-ac 0 }; Ok
Write-Host ""
bun "$App\src\cli.ts" status --brief
Write-Host ""
