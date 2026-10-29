# pet-sense-helper.ps1 —— 系统与 DSH 感知的本机辅助脚本（由插件经 process.launch 启动）。
#
# 它同时做两件事，一个进程：
#
#   1. 采样：每 5 秒把 CPU / 内存写进 outbox（插件私有目录里的 state.json），
#      连续 N 次（默认 3 次 = 15 秒）负载 > 阈值（默认 80%）时写一条 load-high 事件；
#   2. 监听：在 127.0.0.1:3210 上开一个 HTTP 服务，POST /api/state 收 DSH 的
#      thinking / tool / done / error 状态，原样落进 outbox（dsh.json）。
#
# 为什么一个脚本干两件事：宿主的能力表里没有 TCP 监听（手册 §4.1 是穷尽的），"收 DSH
# 的 HTTP 推送"只能委托给本机程序——而既然必须起一个进程，采样也放这里，插件侧只做
# 文件轮询，一条流水线两个来源。
#
# 输出全是文件（$env:PET_SENSE_DIR 下的 outbox/）：
#   outbox/system.json   { cpu, memUsedGb, memTotalGb, at }
#   outbox/load.json     { high, at, consecutive }        负载事件（含恢复）
#   outbox/dsh.json      { state, tool, note, at }        DSH 状态（原样转发）
#   outbox/health.json   { http, port, requests, at }     自身健康
#
# 协议：POST /api/state  body { "state": "thinking"|"tool"|"done"|"error",
#                               "tool"?: "…", "note"?: "…" }
#        GET  /health     → "ok"

param([string]$OutDir = "", [int]$IntervalSec = 5, [double]$CpuThreshold = 80.0, [int]$HighStreak = 3)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'pet-sense' }
$outbox = Join-Path $OutDir 'outbox'
New-Item -ItemType Directory -Force -Path $outbox | Out-Null

function Write-Json([string]$Path, [object]$Obj) {
  $Obj | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $Path -Encoding UTF8
}

# --- CPU 采样：两个快照的差值（Get-Counter 在部分系统上不可用，走 WMI 差分最稳） ------
$script:lastCpu = $null

function Get-CpuPercent {
  $s = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average
  if ($s -and $null -ne $s.Average) { return [double]$s.Average }
  return -1.0
}

function Get-MemInfo {
  $os = Get-CimInstance Win32_OperatingSystem
  $totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
  $freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
  [pscustomobject]@{
    totalGb = $totalGb
    usedGb  = [math]::Round($totalGb - $freeGb, 2)
    pct     = if ($totalGb -gt 0) { [math]::Round((($totalGb - $freeGb) / $totalGb) * 100, 1) } else { 0 }
  }
}

# --- HTTP 监听：127.0.0.1:3210，POST /api/state ---------------------------------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:3210/')
try { $listener.Start() } catch {
  # 端口被占（多半是上一个实例没退）不是死局：采样照跑，HTTP 部分报告 error。
  Write-Json (Join-Path $outbox 'health.json') @{ http = 'error'; port = 3210; note = "$($_.Exception.Message)"; at = 0 }
  $listener = $null
}

if ($listener) {
  Write-Json (Join-Path $outbox 'health.json') @{ http = 'listening'; port = 3210; requests = 0; at = 0 }
}

$script:httpState = if ($listener) { 'listening' } else { 'error' }
$script:requests = 0

# HTTP 循环放后台 runspace：采样在主循环里 sleep，监听不能被它卡住。
$job = $null
if ($listener) {
  $job = Start-ThreadJob -ScriptBlock {
    param($Listener, $Outbox)
    $DshPath = Join-Path $Outbox 'dsh.json'
    $HealthPath = Join-Path $Outbox 'health.json'
    while ($Listener.IsListening) {
      $ctx = $Listener.GetContext()          # 阻塞等下一个请求
      try {
        $req = $ctx.Request
        $res = $ctx.Response
        if ($req.Url.AbsolutePath -eq '/health' -and $req.HttpMethod -eq 'GET') {
          $bytes = [Text.Encoding]::UTF8.GetBytes('ok')
          $res.ContentType = 'text/plain; charset=utf-8'
          $res.StatusCode = 200
          $res.OutputStream.Write($bytes, 0, $bytes.Length)
          $res.OutputStream.Close()
          continue
        }
        if ($req.Url.AbsolutePath -ne '/api/state' -or $req.HttpMethod -ne 'POST') {
          $res.StatusCode = 404
          $res.OutputStream.Close()
          continue
        }
        $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
        $body = $null
        try { $body = $raw | ConvertFrom-Json } catch { }
        $state = if ($body -and $body.state) { [string]$body.state } else { '' }
        if ($state -notin @('thinking', 'tool', 'done', 'error')) {
          $res.StatusCode = 422
          $res.OutputStream.Close()
          continue
        }
        $event = [pscustomobject]@{
          state = $state
          tool  = if ($body -and $body.tool) { [string]$body.tool } else { '' }
          note  = if ($body -and $body.note) { ([string]$body.note).Substring(0, [Math]::Min(200, ([string]$body.note).Length)) } else { '' }
          at    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        # 原子写：先写临时文件再替换，读的一方永远看到完整 JSON。
        $tmp = "$DshPath.tmp"
        $event | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $tmp -Encoding UTF8
        Move-Item -Force -Path $tmp -Destination $DshPath

        $health = $null
        try { $health = Get-Content $HealthPath -Raw | ConvertFrom-Json } catch { }
        $count = if ($health -and $health.requests) { [int]$health.requests + 1 } else { 1 }
        [pscustomobject]@{ http = 'listening'; port = 3210; requests = $count; at = $event.at } |
          ConvertTo-Json -Compress | Set-Content -Path $HealthPath -Encoding UTF8

        $res.StatusCode = 204
        $res.OutputStream.Close()
      } catch {
        try { $ctx.Response.StatusCode = 500; $ctx.Response.OutputStream.Close() } catch { }
      }
    }
  } -ArgumentList $listener, $outbox | Out-Null
}

# --- 主循环：每 5 秒采样 ---------------------------------------------------------
$streak = 0
$nextHealth = 0
while ($true) {
  try {
    $cpu = Get-CpuPercent
    $mem = Get-MemInfo
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    Write-Json (Join-Path $outbox 'system.json') @{
      cpu        = $cpu
      memUsedGb  = $mem.usedGb
      memTotalGb = $mem.totalGb
      memPct     = $mem.pct
      at         = $at
    }

    # 负载判定：CPU 与内存任一超阈值都算"忙"，连续 $HighStreak 次才算事件。
    $busy = ($cpu -ge $CpuThreshold) -or ($mem.pct -ge $CpuThreshold)
    $streak = if ($busy) { $streak + 1 } else { 0 }
    if ($streak -eq $HighStreak) {
      Write-Json (Join-Path $outbox 'load.json') @{ high = $true; consecutive = $streak; cpu = $cpu; memPct = $mem.pct; at = $at }
    } elseif ($streak -eq 0 -and (Test-Path (Join-Path $outbox 'load.json'))) {
      $prev = Get-Content (Join-Path $outbox 'load.json') -Raw | ConvertFrom-Json
      if ($prev.high) {
        Write-Json (Join-Path $outbox 'load.json') @{ high = $false; consecutive = 0; cpu = $cpu; memPct = $mem.pct; at = $at }
      }
    }
  } catch {
    # 采样失败不退出：写一条空数据让插件侧显示"采样不可用"，下一轮再试。
  }
  Start-Sleep -Seconds $IntervalSec
}
