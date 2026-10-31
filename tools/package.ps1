<#
.SYNOPSIS
    Packages every plugin under plugins/ and refreshes the market catalogue.

.DESCRIPTION
    The single production path for this repo's artefacts (plugin-market
    design.md §4). For each plugins/<id>/manifest.json it:

      1. validates that the manifest names an entry file and that the entry plus
         the three fixed resources (panel.html, app.js, style.css) exist;
      2. deletes and rebuilds dist/<id>-<version>.zip with manifest.json and
         those resources AT THE ZIP ROOT - no wrapper directory, because the
         host extracts straight into <dataDir>/plugins/<id>/ and a wrapper would
         put manifest.json one level too deep;
      3. computes the SHA256 of the finished zip with Get-FileHash;
      4. rewrites market/index.json from the *packaged* manifest, so the
         permissions a user sees in the catalogue can never drift from the ones
         the package actually asks for (design.md D3);
      5. refreshes the packages the host repo's built-in sample ALREADY ships
         and rewrites that sample's index.json to list exactly them. The sample
         is a CURATED SUBSET (AGENTS.md §3.7: "故意更旧"), not a mirror - see the
         comment above the copy at the end of this file for what copying every
         package over it broke.

    Deliberately does NOT run git, npm, go, wails or anything on the network:
    packaging is local and offline, and publishing is a human decision.

    Entry timestamps are pinned to a constant so two runs over unchanged sources
    produce a byte-identical zip. Without that, a re-run after a fresh clone
    would change the hash and every committed index.json would look stale.

.PARAMETER HostSampleDir
    Where the host repo keeps its embedded sample source. Override only if the
    host checkout lives somewhere else.

.EXAMPLE
    pwsh -File tools/package.ps1
#>
[CmdletBinding()]
param(
    # Derived, not hardcoded: this used to say `F:\pet_pc\internal\plugins\sample`, which is
    # where the host checkout lived before it moved - and the copy step would then quietly
    # create a second sample tree somewhere else. tools -> market -> host repo root.
    [string]$HostSampleDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'internal\plugins\sample')
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginsRoot = Join-Path $repoRoot 'plugins'
$distDir = Join-Path $repoRoot 'dist'
$indexPath = Join-Path $repoRoot 'index.json'

# The three resources a plugin front end always ships next to its manifest.
$fixedResources = @('panel.html', 'app.js', 'style.css')

# Pinned so the zip is a pure function of its inputs (see the header comment).
$entryTimestamp = [System.DateTimeOffset]::new([System.DateTime]::new(2024, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc))

<#
    Escapes one string as a JSON string literal.

    Hand-rolled rather than ConvertTo-Json because Windows PowerShell 5.1
    escapes every non-ASCII character to \uXXXX, which would turn the Chinese
    name and description in index.json into unreadable noise. The escaping here
    is the minimum the JSON grammar requires.
#>
function ConvertTo-JsonString {
    param([AllowEmptyString()][string]$Value)

    $v = $Value
    $v = $v -replace '\\', '\\'
    $v = $v -replace '"', '\"'
    $v = $v -replace "`r", '\r'
    $v = $v -replace "`n", '\n'
    $v = $v -replace "`t", '\t'
    return '"' + $v + '"'
}

# Writes UTF-8 with no BOM: Go's encoding/json tolerates a BOM, but a BOM would
# show up as a stray character in every diff and in `Get-Content | ConvertFrom-Json`
# on older hosts.
function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

if (-not (Test-Path $pluginsRoot)) {
    throw "插件目录不存在：$pluginsRoot"
}

$manifestFiles = @(Get-ChildItem -Path $pluginsRoot -Directory | ForEach-Object {
    $candidate = Join-Path $_.FullName 'manifest.json'
    if (Test-Path $candidate) { $candidate }
})

if ($manifestFiles.Count -eq 0) {
    throw "plugins/ 下没有任何 manifest.json"
}

if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

$entries = @()

foreach ($manifestPath in $manifestFiles) {
    $pluginDir = Split-Path -Parent $manifestPath
    $manifest = Get-Content -Path $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $manifest.id) { throw "$manifestPath 缺少必填字段 id" }
    if (-not $manifest.version) { throw "$manifestPath 缺少必填字段 version" }
    if (-not $manifest.entry) { throw "$manifestPath 缺少必填字段 entry" }

    $id = [string]$manifest.id
    $version = [string]$manifest.version

    # The entry must name a file inside this plugin's own directory. The host
    # repeats these checks on install; failing here says so at packaging time,
    # where the author can still fix it.
    if ([string]::IsNullOrWhiteSpace($manifest.entry)) { throw "$manifestPath 的 entry 为空" }
    if ($manifest.entry -notlike '*.html') { throw "$manifestPath 的 entry 必须以 .html 结尾：$($manifest.entry)" }
    if ($manifest.entry -match '[\\/]' -or $manifest.entry -match '\.\.') {
        throw "$manifestPath 的 entry 必须是插件目录内的纯文件名：$($manifest.entry)"
    }

    $entryFile = Join-Path $pluginDir $manifest.entry
    if (-not (Test-Path -Path $entryFile -PathType Leaf)) {
        throw "$manifestPath 指向的入口文件不存在：$($manifest.entry)"
    }

    foreach ($resource in $fixedResources) {
        $resourcePath = Join-Path $pluginDir $resource
        if (-not (Test-Path -Path $resourcePath -PathType Leaf)) {
            throw "插件 $id 缺少资源文件：$resource"
        }
    }

    # The zip holds the manifest plus the entry plus the three resources; the
    # union keeps a plugin whose entry is not panel.html working too.
    #
    # `assets` are the extra files a package declares - audio, in the voice
    # plugin's case. They are appended AFTER the fixed set, and each is verified
    # to exist here rather than failing later inside the zip writer, because the
    # failure there names a stream instead of the file the author forgot.
    #
    # The path rules are re-checked even though the manifest validator applies
    # them too: this script also runs over plugin directories that were never
    # parsed by Go (a work-in-progress package), and a ".." here would make the
    # zip read a file from outside the plugin - i.e. publish something the author
    # never meant to ship.
    $zipMembers = New-Object System.Collections.Generic.List[string]
    $zipMembers.Add('manifest.json')
    foreach ($name in @($fixedResources)) {
        if (-not $zipMembers.Contains($name)) { $zipMembers.Add($name) }
    }
    if (-not $zipMembers.Contains($manifest.entry)) { $zipMembers.Add($manifest.entry) }

    $declaredAssets = @()
    if ($null -ne $manifest.assets) { $declaredAssets = @($manifest.assets) }
    foreach ($asset in $declaredAssets) {
        if ([string]::IsNullOrWhiteSpace($asset)) { throw "$manifestPath 的 assets 含空项" }
        $assetPosix = $asset -replace '\\', '/'
        if ($assetPosix -match '^/') { throw "$manifestPath 的 assets 不能是绝对路径：$asset" }
        if ($assetPosix -match '(^|/)\.\.(/|$)' -or $assetPosix -match '(^|/)\.(/|$)') {
            throw "$manifestPath 的 assets 不能包含 . 或 .. 路径段：$asset"
        }
        if (-not $zipMembers.Contains($assetPosix)) { $zipMembers.Add($assetPosix) }

        $assetPath = Join-Path $pluginDir ($assetPosix -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -Path $assetPath -PathType Leaf)) {
            throw "插件 $id 声明的 assets 文件不存在：$assetPosix"
        }
    }

    # Delete then recreate, so a stale archive can never contribute an extra
    # entry to the new one.
    $zipName = "$id-$version.zip"
    $zipPath = Join-Path $distDir $zipName
    if (Test-Path $zipPath) { Remove-Item -Path $zipPath -Force }

    # Two passes. The first writes the content; the second reopens the finished
    # archive in Update mode to pin every timestamp. Setting LastWriteTime while
    # an entry is still being written is rejected by .NET Framework ("cannot
    # modify entry in Create mode after entry has been opened for writing"),
    # which is the runtime Windows PowerShell 5.1 uses.
    $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($member in $zipMembers) {
            $source = Join-Path $pluginDir $member
            $entry = $archive.CreateEntry($member, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $sourceStream = [System.IO.File]::OpenRead($source)
                try {
                    $sourceStream.CopyTo($entryStream)
                }
                finally {
                    $sourceStream.Dispose()
                }
            }
            finally {
                $entryStream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        foreach ($entry in $archive.Entries) {
            $entry.LastWriteTime = $entryTimestamp
        }
    }
    finally {
        $archive.Dispose()
    }

    $sha256 = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $permissions = @()
    if ($manifest.permissions) { $permissions = @($manifest.permissions | ForEach-Object { [string]$_ }) }

    $entries += [pscustomobject]@{
        Id          = $id
        Name        = [string]$manifest.name
        Version     = $version
        Author      = [string]$manifest.author
        Description = [string]$manifest.description
        Permissions = $permissions
        # netHosts must be carried here, not just inside the package.
        #
        # The installer compares the catalogue row against the manifest INSIDE the
        # zip and refuses the install when they differ, because "what the user was
        # shown is not what they would be authorising". Omitting this field made
        # every net.fetch plugin uninstallable from the built-in source: the
        # catalogue reported no hosts, the package declared some, and the refusal
        # blamed the permissions list - which matched, making the message look
        # like a bug in the comparison rather than a missing field here.
        NetHosts    = @($manifest.netHosts)
        Download    = "dist/$zipName"
        Sha256      = $sha256
        ZipPath     = $zipPath
    }

    Write-Host ("已打包 {0} -> dist/{1}（sha256 {2}）" -f $id, $zipName, $sha256)
}

# Build index.json by hand for stable key order and readable Chinese.
#
# A FUNCTION rather than inline, because the file is written TWICE: the market's own catalogue
# (every packaged plugin) and the built-in sample's (only the packages it ships). The two used to
# be one file, and that is exactly what the sample step at the bottom now stopped doing.
function Build-IndexJson {
    param([object[]]$rows, [string]$stamp)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("{`n")
    [void]$sb.Append("  ""version"": 1,`n")
    [void]$sb.Append("  ""updatedAt"": " + (ConvertTo-JsonString $stamp) + ",`n")
    [void]$sb.Append("  ""plugins"": [`n")

    for ($i = 0; $i -lt $rows.Count; $i++) {
        $e = $rows[$i]
        [void]$sb.Append("    {`n")
        [void]$sb.Append("      ""id"": " + (ConvertTo-JsonString $e.Id) + ",`n")
        [void]$sb.Append("      ""name"": " + (ConvertTo-JsonString $e.Name) + ",`n")
        [void]$sb.Append("      ""version"": " + (ConvertTo-JsonString $e.Version) + ",`n")
        [void]$sb.Append("      ""author"": " + (ConvertTo-JsonString $e.Author) + ",`n")
        [void]$sb.Append("      ""description"": " + (ConvertTo-JsonString $e.Description) + ",`n")
        $perms = ($e.Permissions | ForEach-Object { ConvertTo-JsonString $_ }) -join ', '
        [void]$sb.Append("      ""permissions"": [" + $perms + "],`n")
        # Emitted only when non-empty, matching the manifest's own `omitempty` and the
        # Go struct's, so a plugin without hosts produces byte-identical JSON to
        # before and the chat package's digest does not move.
        $hosts = @($e.NetHosts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($hosts.Count -gt 0) {
            $hostJson = ($hosts | ForEach-Object { ConvertTo-JsonString $_ }) -join ', '
            [void]$sb.Append("      ""netHosts"": [" + $hostJson + "],`n")
        }
        [void]$sb.Append("      ""download"": " + (ConvertTo-JsonString $e.Download) + ",`n")
        [void]$sb.Append("      ""sha256"": " + (ConvertTo-JsonString $e.Sha256) + "`n")
        [void]$sb.Append("    }")
        if ($i -lt $rows.Count - 1) { [void]$sb.Append(",") }
        [void]$sb.Append("`n")
    }

    [void]$sb.Append("  ]`n")
    [void]$sb.Append("}`n")
    return $sb.ToString()
}

$updatedAt = [System.DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
Write-Utf8NoBom -Path $indexPath -Text (Build-IndexJson -rows $entries -stamp $updatedAt)
Write-Host ("已回写 index.json（updatedAt {0}）" -f $updatedAt)

# Refresh the host repo's built-in sample source.
#
# IT IS A SUBSET, NOT A MIRROR, and its packages are DELIBERATELY OLDER (AGENTS.md §3.7).
# This step used to copy EVERY package over it and then overwrite the sample's index.json with the
# market's, which quietly broke the offline floor as soon as the market outgrew the sample: the
# embedded catalogue declared 36 downloads while internal/plugins/sample/embed.go embeds ten by
# name, so a user clicking 安装 on the fallback would 404 for the other 26.
# TestBuiltinSampleMatchesIndex caught the symptom afterwards; the fix belongs here.
#
# What this step therefore does, and refuses to do:
#
#   - it NEVER adds a file to the sample: embed.go lists packages by name, and a file the binary
#     does not carry is a catalogue row that 404s. Growing the floor stays a hand edit (drop the
#     package in, add it to embed.go, run this script);
#   - a sample package whose version has moved on STAYS where it is - that is the "故意更旧" half
#     of the contract, and a floor that tracked every release would re-embed megabytes each time;
#   - a sample package whose id left the market catalogue is dropped, because the fallback can
#     only offer what the catalogue still lists;
#   - every kept row's sha256 is recomputed from the FILE ON DISK (same version repackaged = new
#     bytes), so the sample index can never describe a package it does not ship.
if (-not (Test-Path $HostSampleDir)) {
    New-Item -ItemType Directory -Path $HostSampleDir -Force | Out-Null
}

$sampleIndexPath = Join-Path $HostSampleDir 'index.json'
if (-not (Test-Path $sampleIndexPath)) {
    throw ("内置样例源缺少 index.json（{0}）：兜底源至少要有一份目录" -f $sampleIndexPath)
}

$sampleDoc = Get-Content -Path $sampleIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
$marketById = @{}
foreach ($e in $entries) { $marketById[$e.Id] = $e }

$sampleRows = @()
$sampleNames = @{}
foreach ($row in @($sampleDoc.plugins)) {
    $name = Split-Path ([string]$row.download) -Leaf
    $file = Join-Path $HostSampleDir $name
    if (-not (Test-Path $file)) {
        Write-Host ("样例索引声明了 {0}，但文件不在：把它从样例里去掉" -f $name) -ForegroundColor Yellow
        continue
    }
    if (-not $marketById.ContainsKey([string]$row.id)) {
        Write-Host ("{0} 已经不在市场目录里：样例索引去掉它（兜底源只能是市场的子集）" -f $row.id) -ForegroundColor Yellow
        continue
    }
    $fresh = $marketById[[string]$row.id]
    if ((Split-Path $fresh.ZipPath -Leaf) -eq $name) {
        # Same version: take the freshly built bytes (a fix at the same version is still a fix);
        # the digest below is recomputed from whatever ended up on disk.
        Copy-Item -Path $fresh.ZipPath -Destination $file -Force
    }
    $row.sha256 = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $sampleRows += $row
    $sampleNames[$name] = $true
}

if ($sampleRows.Count -eq 0) {
    throw ("内置样例源里一个可用的包都没有（{0}）：离线兜底会变成空目录" -f $HostSampleDir)
}

# A zip nobody indexes is a zip embed.go may be listing without a catalogue row. Warn instead of
# deleting: the human may be halfway through adding a package.
foreach ($file in Get-ChildItem -Path $HostSampleDir -Filter *.zip -File) {
    if (-not $sampleNames.ContainsKey($file.Name)) {
        Write-Host ("样例目录里有 {0}，但样例索引没有它：确认 embed.go 与 index.json 要不要一起改" -f $file.Name) -ForegroundColor Yellow
    }
}

Write-Utf8NoBom -Path $sampleIndexPath -Text (Build-IndexJson -rows $sampleRows -stamp $updatedAt)
Write-Host ("已刷新内置样例 {0} 个包与它的 index.json（市场目录共 {1} 个，其余不进兜底源）" -f $sampleRows.Count, $entries.Count)

Write-Host "打包完成。"
exit 0
