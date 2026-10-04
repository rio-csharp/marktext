<#
.SYNOPSIS
    一键构建 MarkText 便携版 zip 并部署到 D:\Apps\MarkText。
    步骤: 构建 zip -> 关闭 MarkText -> 解压覆盖 -> 重新启动。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/deploy-portable.ps1
    常规部署（跳过原生模块重建、不备份旧目录）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/deploy-portable.ps1 -RebuildNative -Backup
    强制 electron-rebuild（依赖是预编译二进制时不需要）并在覆盖前备份旧目录。
#>
param(
  # 强制 electron-rebuild；依赖为预编译二进制时可跳过（构建更快）
  [switch]$RebuildNative,
  # 覆盖前把旧目录改名备份为 D:\Apps\MarkText.bak-<时间戳>
  [switch]$Backup,
  # 部署后不自动启动 MarkText
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installDir = 'D:\Apps\MarkText'

function Invoke-Step([string]$Name, [scriptblock]$Action) {
  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Name 失败 (exit=$LASTEXITCODE)" }
}

# ---- 1. 构建 zip ----
Push-Location $root
try {
  Invoke-Step 'minify-locales'      { pnpm run minify-locales }
  if ($RebuildNative) {
    Invoke-Step 'electron-rebuild'  { pnpm -C packages/desktop run rebuild-native }
  }
  Invoke-Step 'electron-vite build' { pnpm -C packages/desktop exec electron-vite build }
  Invoke-Step 'electron-builder'    { pnpm -C packages/desktop exec electron-builder --win zip --x64 --publish never }
} finally { Pop-Location }

# ---- 2. 取最新的 zip ----
$zip = Get-ChildItem (Join-Path $root 'dist') -Filter '*.zip' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw 'dist/ 下没有找到 zip 产物' }
Write-Host "使用产物: $($zip.FullName) ($([math]::Round($zip.Length/1MB,1)) MB)"

# ---- 3. 关闭 MarkText（运行中会锁住 exe，无法覆盖）----
if (Get-Process -Name marktext -ErrorAction SilentlyContinue) {
  Write-Host '==> 正在关闭 MarkText（未保存的文档可能丢失）'
  Get-Process -Name marktext -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

# ---- 4. 可选：备份旧目录 ----
if ($Backup -and (Test-Path $installDir)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Rename-Item $installDir "MarkText.bak-$stamp"
  Write-Host "已备份旧目录 -> D:\Apps\MarkText.bak-$stamp"
}

# ---- 5. 解压覆盖 ----
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Invoke-Step '解压 zip' { & "$env:SystemRoot\System32\tar.exe" -xf $zip.FullName -C $installDir }
Write-Host "已部署: $($zip.Name) -> $installDir"

# ---- 6. 启动 ----
if (-not $NoLaunch) {
  Start-Process (Join-Path $installDir 'marktext.exe')
  Write-Host '已启动 MarkText'
}
Write-Host '完成。'
