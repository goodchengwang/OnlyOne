# Installs OnlyOne from local source; ONLYONE_CLIENT_BASE_URL optionally selects a verified release.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # the progress bar slows downloads down a lot

$Base = $env:ONLYONE_CLIENT_BASE_URL
$Asset = "onlyone-windows-x86_64.zip"
$Dir = Join-Path $env:LOCALAPPDATA "Programs\OnlyOne"
$Work = Join-Path ([IO.Path]::GetTempPath()) ("onlyone-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Work | Out-Null

try {
  $Zip = Join-Path $Work $Asset
  if ($Base) {
    Write-Host "Downloading $Asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $Zip
    $Sums = Join-Path $Work "sha256sums"
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/sha256sums" -OutFile $Sums
    $Line = Get-Content $Sums | Where-Object { ($_ -split "\s+")[1] -replace "^\*", "" -eq $Asset } | Select-Object -First 1
    if (-not $Line -or ($Line -split "\s+")[0] -ne (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash) { throw "the checksum of $Asset does not match" }
  } else {
    if (-not $PSScriptRoot -or -not (Test-Path "$PSScriptRoot\app\nsh.json")) { throw "OnlyOne source missing: run install-client.ps1 from a complete local checkout." }
    $Nsh = if ($env:NSH) { $env:NSH } else { "nsh" }
    if (-not (Get-Command $Nsh -ErrorAction SilentlyContinue)) { throw "Install NSH before building the local client." }
    Push-Location "$PSScriptRoot\app"
    try {
      & $Nsh package --target windows -o "$Work\build"
      if ($LASTEXITCODE) { throw "OnlyOne client build failed ($LASTEXITCODE)." }
    } finally { Pop-Location }
    Copy-Item "$Work\build\OnlyOne.zip" $Zip
  }

  $Unpacked = Join-Path $Work "unpacked"
  Expand-Archive -Path $Zip -DestinationPath $Unpacked
  $Exe = Get-ChildItem -Path $Unpacked -Recurse -Filter "OnlyOne.exe" | Select-Object -First 1
  if (-not $Exe) { throw "$Asset holds no OnlyOne.exe" }

  # A running app locks its files.
  Get-Process -Name OnlyOne -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir\*" } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
  Move-Item -Path $Exe.Directory.FullName -Destination $Dir

  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Programs")) "OnlyOne.lnk"))
  $Link.TargetPath = Join-Path $Dir "OnlyOne.exe"
  $Link.WorkingDirectory = $Dir
  $Link.Save()

  Write-Host "Installed $Dir"
  Write-Host ""
  Write-Host "Open OnlyOne from the Start menu."
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}
