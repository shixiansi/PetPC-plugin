# vision-helper.ps1 —— 屏幕视觉的本机辅助脚本（由插件经 process.launch 启动）。
#
# 它是插件拿到"屏幕像素"的唯一通道：宿主的能力表（手册 §4.1）里没有任何屏幕捕获方法，
# 所以截图只能委托给本机程序——这与 pet-sense 的采样辅助脚本是同一条路。
#
# 一次抓取 = 插件写一个任务文件，本脚本轮询到它：
#
#   插件侧 ──写─> capture.ask   { "region": "full", "at": <epoch ms> }   （拍完会被删）
#   本脚本 ──────────────────────> System.Drawing 截图 → PNG
#   本脚本 ──写─> capture.png     整张截图的字节（给需要原始像素的用途）
#   本脚本 ──写─> capture.meta    { "at", "w", "h", "base64Length", "sha256", "tookMs" }
#   本脚本 ──POST visionBaseUrl─> 上传 PNG（把响应原文写回 capture.upload）
#
# 上传为什么在这里做：截图必须变成"视觉模型拉得到的 http(s) URL"（llm.chat 的 images
# 只收地址，手册 §6.6），而"把文件发到某个地址"需要 HTTP POST——这同样超出了插件的能力表。
# visionBaseUrl 是用户自己填的（manifest 里 hostWhitelist），常见形态是一个本地小服务
# （例如 http://127.0.0.1:8321/put），它负责存下截图并回一个可拉的 URL。
#
# 轮询间隔 600ms：一次"看一眼屏幕"从点按钮到可用 < 1 秒，人感觉是即时的。

param([string]$OutDir = "", [int]$PollMs = 600)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = $env:PETPC_PLUGIN_DATA }
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'pet-vision' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 截图要用 System.Drawing：Windows PowerShell（5.1）里加类型最稳，不会踩 pwsh 的程序集差异。
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$askPath = Join-Path $OutDir 'capture.ask'
$pngPath = Join-Path $OutDir 'capture.png'
$metaPath = Join-Path $OutDir 'capture.meta'
$uploadPath = Join-Path $OutDir 'capture.upload'

function Write-JsonFile([string]$Path, [object]$Obj) {
  $Obj | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $Path -Encoding UTF8
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try {
    return Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Invoke-Capture([string]$Region) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $scale = 0
  if ($Region -eq 'primary') { $scale = 1280 }

  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
    $g.Dispose()

    if ($scale -gt 0 -and $bmp.Width -gt $scale) {
      $newH = [int]([double]$bmp.Height * $scale / $bmp.Width)
      $small = New-Object System.Drawing.Bitmap($bmp, $scale, $newH)
      $bmp.Dispose()
      $bmp = $small
    }
    $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }

  $bytes = [System.IO.File]::ReadAllBytes($pngPath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($bytes)
    $hex = ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally {
    $sha.Dispose()
  }

  Write-JsonFile $metaPath @{
    at           = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    w            = $bounds.Width
    h            = $bounds.Height
    base64Length = ($bytes.Length * 4 / 3)
    bytes        = $bytes.Length
    sha256       = $hex
    tookMs       = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startedAt)
    uploaded     = $false
  }
}

function Invoke-Upload([string]$Url) {
  if (-not (Test-Path $pngPath)) { return }
  if (-not (Test-Path $metaPath)) { return }
  $meta = Read-JsonFile $metaPath
  if ($null -eq $meta -or $meta.uploaded) { return }
  try {
    $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($pngPath))
    $body = @{ image = $b64; format = 'png' } | ConvertTo-Json -Compress
    $resp = Invoke-WebRequest -Uri $Url -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20
    $meta | Add-Member -NotePropertyName uploadStatus -NotePropertyValue ([int]$resp.StatusCode) -Force
    $resp.Content | Set-Content -Path $uploadPath -Encoding UTF8
    $meta | Add-Member -NotePropertyName uploaded -NotePropertyValue $true -Force
    Write-JsonFile $metaPath $meta
  } catch {
    # 上传失败不算致命：截图还在本地，meta 里留着状态，插件把原因念给用户听。
    $meta | Add-Member -NotePropertyName uploadError -NotePropertyValue ($_.Exception.Message) -Force
    Write-JsonFile $metaPath $meta
  }
}

# --- 主循环 -------------------------------------------------------------------
#
# 健康文件让插件知道脚本活着（面板的"辅助脚本"一行）；内容每 5 秒刷一次就够。

$healthPath = Join-Path $OutDir 'health.json'
$lastHealth = 0
Write-JsonFile $healthPath @{ http = $false; port = 0; requests = 0; at = 0; started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

while ($true) {
  $task = Read-JsonFile $askPath
  if ($null -ne $task -and $task.region) {
    Remove-Item -Path $askPath -Force -ErrorAction SilentlyContinue
    Invoke-Capture ([string]$task.region)
    $url = [string]$task.uploadUrl
    if ($url) { Invoke-Upload $url }
  }

  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($nowMs - $lastHealth -gt 5000) {
    $lastHealth = $nowMs
    Write-JsonFile $healthPath @{ http = $false; port = 0; requests = 0; at = $nowMs }
  }

  Start-Sleep -Milliseconds $PollMs
}
