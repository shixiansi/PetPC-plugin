# media-helper.ps1 —— 正在播放的本机辅助脚本（由插件经 process.launch 启动）。
#
# Windows 的"系统正在播什么"住在 SMTC（System Media Transport Controls）里：
# 每个播放器把自己的曲目注册进去，GlobalSystemMediaTransportControlsSessionManager
# 是它的 WinRT 门面。PowerShell 能借 WinRT 投影拿到它——宿主的能力表里没有这一条
# （手册 §4.1 是穷尽的），所以和剪贴板、系统采样一样，只能委托给本机脚本。
#
# 每 2 秒把当前曲目写进 outbox/media.json（原子写）：
#   { title, artist, album, status, at }
# status: playing | paused | stopped | ""
#
# 没有 SMTC 会话（没开播放器 / macOS / Linux）时不写文件——插件侧把"没有数据"
# 显示为"现在没在放"，而不是报错。

param([string]$OutDir = "", [int]$IntervalSec = 2)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP 'pet-media' }
$outbox = Join-Path $OutDir 'outbox'
New-Item -ItemType Directory -Force -Path $outbox | Out-Null

# WinRT 投影：Windows 10 17763+ 上可用；失败时写一条错误并退出（插件侧显示不可用）。
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
} catch {
  @{ error = "WinRT 不可用：$($_.Exception.Message)"; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
    ConvertTo-Json -Compress | Set-Content -Path (Join-Path $outbox 'media.json') -Encoding UTF8
  exit 1
}

# await WinRT 的 IAsyncOperation：WinRT 的管理器是 async 静态方法。
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

while ($true) {
  try {
    $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
      ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    # 取"正在播放"的那个会话：优先 playbackStatus == Playing，否则最近的一个。
    $sessions = @($manager.GetSessions())
    $session = $null
    foreach ($s in $sessions) {
      if ($s.GetPlaybackInfo().PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing) { $session = $s; break }
    }
    if (-not $session -and $sessions.Count -gt 0) { $session = $sessions[0] }

    if ($session) {
      $info = $session.GetPlaybackInfo()
      $statusMap = @{
        [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing = 'playing'
        [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Paused  = 'paused'
        [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Stopped = 'stopped'
      }
      $status = $statusMap[$info.PlaybackStatus]
      if (-not $status) { $status = 'unknown' }

      $title = ''; $artist = ''; $album = ''
      try {
        $props = Await ($session.TryGetMediaPropertiesAsync()) `
          ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $title = [string]$props.Title
        $artist = [string]$props.Artist
        $album = [string]$props.AlbumTitle
      } catch { }

      $event = [pscustomobject]@{
        title  = $title
        artist = $artist
        album  = $album
        status = $status
        at     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      }
      $tmp = Join-Path $outbox 'media.json.tmp'
      $dst = Join-Path $outbox 'media.json'
      $event | ConvertTo-Json -Compress -Depth 4 | Set-Content -Path $tmp -Encoding UTF8
      Move-Item -Force -Path $tmp -Destination $dst
    }
    # 没有 session：不写文件（"没在放"由插件侧的"文件不存在"表达）。
  } catch {
    # 单轮失败不退出：下一轮再试。
  }
  Start-Sleep -Seconds $IntervalSec
}
