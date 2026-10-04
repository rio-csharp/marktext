<##
.SYNOPSIS
    Build and deploy the Windows portable zip to D:\Apps\MarkText.

.PARAMETER RebuildNative
    Rebuild native modules before packaging.

.PARAMETER Backup
    Rename the existing installation before extraction.

.PARAMETER NoLaunch
    Do not launch MarkText after deployment.
#>
param(
  [switch]$RebuildNative,
  [switch]$Backup,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installDir = 'D:\Apps\MarkText'

function Invoke-Step([string]$Name, [scriptblock]$Action) {
  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit=$LASTEXITCODE)" }
}

Push-Location $root
try {
  Invoke-Step 'minify-locales' { pnpm run minify-locales }
  if ($RebuildNative) {
    Invoke-Step 'electron-rebuild' { pnpm -C packages/desktop run rebuild-native }
  }
  Invoke-Step 'electron-vite build' { pnpm -C packages/desktop exec electron-vite build }
  Invoke-Step 'electron-builder zip' { pnpm -C packages/desktop exec electron-builder --win zip --x64 --publish never }
} finally {
  Pop-Location
}

$zip = Get-ChildItem (Join-Path $root 'dist') -Filter '*.zip' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw 'No zip artifact found under dist/' }

if (Get-Process -Name marktext -ErrorAction SilentlyContinue) {
  Write-Host '==> Stopping MarkText (unsaved documents may be lost)'
  Get-Process -Name marktext -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

if ($Backup -and (Test-Path $installDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Rename-Item $installDir "MarkText.bak-$stamp"
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Invoke-Step 'extract zip' { & "$env:SystemRoot\System32\tar.exe" -xf $zip.FullName -C $installDir }

if (-not $NoLaunch) {
  Start-Process (Join-Path $installDir 'marktext.exe')
}
Write-Host "Deployed $($zip.Name) to $installDir"
