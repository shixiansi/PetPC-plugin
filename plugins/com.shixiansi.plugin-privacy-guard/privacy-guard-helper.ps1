# privacy-guard-helper.ps1 —— 敏感信息监控的本机辅助脚本（由插件经 process.launch 启动）。
#
# 两件事，一个进程（pet-sense 同款流水线：本机做采集，插件只轮询文件）：
#
#   1. 剪贴板：每秒读一次，内容变了就写 outbox/clipboard
#      { at, hash, text } —— text 只保留前 4000 字符（大粘贴不膨胀）。
#   2. 文件：监视 WatchDir（默认用户目录）下的 .env / *.txt / *.json，
#      变更后写 outbox/file { at, path, hash, text }（同样截断）。
#
# hash 是内容的前 64 位 SHA256（去重用：插件侧只处理 hash 变了的条目）。
#
# 输出目录：$env:PRIVACY_GUARD_DIR\outbox\

param(
  [string]$OutDir = "",
  [string]$WatchDir = "",
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'privacy-guard' }
$outbox = Join-Path $OutDir 'outbox'
New-Item -ItemType Directory -Force -Path $outbox | Out-Null
if (-not $WatchDir) { $WatchDir = $env:USERPROFILE }

Add-Type -AssemblyName System.Windows.Forms
$sha = [System.Security.Cryptography.SHA256]::Create()

function Get-TextHash([string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $h = $sha.ComputeHash($bytes)
  return ([BitConverter]::ToString($h) -replace '-', '').Substring(0, 16).ToLower()
}

function Write-Json([string]$Path, [object]$Obj) {
  $Obj | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $Path -Encoding UTF8
}

# --- 剪贴板轮询 -------------------------------------------------------------------
$script:lastClipHash = ''

# --- 文件监听（FileSystemWatcher 对 .env/*.txt/*.json） ----------------------------
$watcher = $null
try {
  $watcher = New-Object System.IO.FileSystemWatcher
  $watcher.Path = $WatchDir
  $watcher.IncludeSubdirectories = $false   # 只看顶层：递归太吵
  $watcher.EnableRaisingEvents = $true
} catch {
  Write-Json (Join-Path $outbox 'error') @{ at = (Get-Date -UFormat %s); note = "watcher: $($_.Exception.Message)" }
}
$script:lastFileHash = @{}

function Get-ChangedFile {
  # 返回最近 2 秒内修改过的第一个 .env/.txt/.json 文件（简单够用：插件轮询频率 1s）。
  if ($null -eq $watcher) { return $null }
  try {
    $cutoff = (Get-Date).AddSeconds(-3)
    $files = Get-ChildItem -Path $WatchDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -gt $cutoff -and $_.Extension -match '^\.?(env|txt|json)$|^\.$' }
    # .env 是无扩展名文件，单独补一遍
    $envFiles = Get-ChildItem -Path $WatchDir -File -Filter '.env*' -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -gt $cutoff }
    $all = @($files) + @($envFiles)
    if ($all.Count -eq 0) { return $null }
    return $all | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  } catch { return $null }
}

while ($true) {
  try {
    # 剪贴板
    $clip = ''
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $clip = [System.Windows.Forms.Clipboard]::GetText() }
    if ($clip) {
      $text = $clip
      if ($text.Length -gt 4000) { $text = $text.Substring(0, 4000) }
      $h = Get-TextHash $text
      if ($h -ne $script:lastClipHash) {
        $script:lastClipHash = $h
        Write-Json (Join-Path $outbox 'clipboard') @{ at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); hash = $h; text = $text }
      }
    }
  } catch {
    # 剪贴板被别的进程占用：下一轮再试。
  }

  try {
    $f = Get-ChangedFile
    if ($f) {
      $content = ''
      try { $content = Get-Content -Path $f.FullName -Raw -Encoding UTF8 -ErrorAction Stop } catch { $content = '' }
      if ($content) {
        if ($content.Length -gt 4000) { $content = $content.Substring(0, 4000) }
        $fh = Get-TextHash $content
        $known = $script:lastFileHash[$f.FullName]
        if ($known -ne $fh) {
          $script:lastFileHash[$f.FullName] = $fh
          Write-Json (Join-Path $outbox 'file') @{ at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); path = $f.FullName; hash = $fh; text = $content }
        }
      }
    }
  } catch {
    # 文件被锁住（正被写入）：下一轮再试。
  }

  Start-Sleep -Milliseconds $IntervalMs
}
