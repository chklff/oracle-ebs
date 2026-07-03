<#
  Download Oracle Instant Client (Basic Lite) into vendor\instantclient so the
  wrapper can run in Thick mode on Windows (needed only for databases that
  enforce Native Network Encryption). No admin rights required: the libraries
  live inside the app directory and are pointed at via EBS_CLIENT_LIB_DIR.

  Instant Client is free and, since 2021, redistributable under the Oracle Free
  Use Terms and Conditions. Files are downloaded from Oracle at deploy time and
  are intentionally NOT committed to this repository.

  Usage:
    npm run fetch-client:win
    powershell -ExecutionPolicy Bypass -File scripts\fetch-instantclient.ps1 [dest]
#>
param(
  [string]$Dest
)

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $PSScriptRoot
if (-not $Dest -or $Dest -eq "") { $Dest = Join-Path $AppDir "vendor\instantclient" }

$Url = "https://download.oracle.com/otn_software/nt/instantclient/instantclient-basiclite-nt.zip"

$tmp = Join-Path $env:TEMP ("ic-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading Instant Client Basic Lite for Windows x64 ..."
  Invoke-WebRequest -Uri $Url -OutFile (Join-Path $tmp "ic.zip")

  Write-Host "Unpacking ..."
  Expand-Archive -Path (Join-Path $tmp "ic.zip") -DestinationPath $tmp -Force

  $inner = Get-ChildItem -Path $tmp -Directory -Filter "instantclient_*" | Select-Object -First 1
  if (-not $inner) { throw "Could not find the unpacked instantclient_* directory." }

  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $Dest -Recurse -Force

  Write-Host ""
  Write-Host "Instant Client installed at: $Dest"
  Write-Host "Add this to your .env:"
  Write-Host "  EBS_DB_THICK=true"
  Write-Host "  EBS_CLIENT_LIB_DIR=$Dest"
  Write-Host ""
  Write-Host "Note: Thick mode on Windows also needs the Microsoft Visual C++ Redistributable."
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
