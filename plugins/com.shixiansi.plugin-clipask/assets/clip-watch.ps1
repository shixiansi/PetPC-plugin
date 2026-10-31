param(
    [string]$OutDir = '',
    [int]$IntervalMs = 600,
    [int]$MaxChars = 20000
)

# 由宿主的 sidecar 启动时不传参数：私有目录从环境变量来（脚本自己拼 clip\inbox）。
# 手动跑（调试）时仍然可以 -OutDir 指定。
if (-not $OutDir) {
    $data = $env:PETPC_PLUGIN_DATA
    if (-not $data) { throw 'PETPC_PLUGIN_DATA 没有设置：这个脚本必须由宿主的 sidecar 启动（manifest 的 sidecar 字段）' }
    $OutDir = Join-Path $data 'clip\inbox'
}

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$last = ''
$stall = 0
$lastSkip = 0

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Publish-Latest {
    param([string]$Text)
    $payload = @{
        at   = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        text = $Text
    } | ConvertTo-Json -Compress
    $tmp = Join-Path $OutDir 'latest.tmp'
    Write-Utf8NoBom -Path $tmp -Text $payload
    # The file name must match the storage key the plugin polls, character for character:
  # clip/inbox/latest, with NO extension. A key segment only allows [A-Za-z0-9_-], so a
  # .txt name can never be read back - and the script writes by absolute path, so nothing
  # complains: the plugin just never sees a sample. (2026-10-30: latest.txt vs latest.)
  # Keep this whole script ASCII: it is launched with Get-Content -Raw under Windows
  # PowerShell 5.1, which decodes a BOM-less file as the ANSI code page and can eat a
  # quote or a newline in the middle of a multi-byte comment. (AGENTS.md section 7.)
  Move-Item -LiteralPath $tmp -Destination (Join-Path $OutDir 'latest') -Force
}

while ($true) {
    Start-Sleep -Milliseconds ([Math]::Max(100, $IntervalMs))

    $text = $null
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            $text = [System.Windows.Forms.Clipboard]::GetText()
        }
    }
    catch {
        $text = $null
    }

    if ([string]::IsNullOrEmpty($text)) { continue }
    if ($text -ceq $last) { continue }
    $last = $text

    if ($text.Length -gt $MaxChars) {
        # Too long for the ask flow: publish an empty sample so the plugin sees that
        # something was skipped (throttled by $lastSkip).
        if (([System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lastSkip) -gt 30000) {
            $lastSkip = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            try { Publish-Latest -Text '' } catch { }
        }
        continue
    }

    try {
        Publish-Latest -Text $text
        $stall = 0
    }
    catch {
        $stall += 1
        if ($stall -gt 20) { Start-Sleep -Seconds 5 }
    }
