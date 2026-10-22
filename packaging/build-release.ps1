[CmdletBinding()]
param([string]$Version)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid release version.' }
$runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw | ConvertFrom-Json
$dist = Join-Path $repo 'dist'
$cache = Join-Path $repo '.build-cache'
$stage = Join-Path $cache ('release-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dist,$cache,$stage -Force | Out-Null
try {
    $archive = Join-Path $cache ('node-v' + $runtime.version + '-win-x64.zip')
    if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $runtime.url -OutFile $archive -UseBasicParsing }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256) {
        throw 'Node runtime SHA256 verification failed. Remove the cached archive and retry.'
    }
    $unpacked = Join-Path $stage 'node-archive'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $bundle = Join-Path $stage ('strata-dual-device-monitor-v' + $Version + '-windows-x64')
    $app = Join-Path $bundle 'app'
    $node = Join-Path $bundle 'runtime'
    $scripts = Join-Path $bundle 'scripts'
    New-Item -ItemType Directory -Path $bundle,$app,$node,$scripts -Force | Out-Null
    foreach ($name in @('server.mjs','package.json','config.example.json','LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $app
    }
    Copy-Item -LiteralPath (Join-Path $repo 'public') -Destination $app -Recurse
    $sourceNode = Join-Path $unpacked ('node-v' + $runtime.version + '-win-x64')
    foreach ($name in @('node.exe','LICENSE','README.md')) { Copy-Item -LiteralPath (Join-Path $sourceNode $name) -Destination $node }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Destination $node
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'scripts') -File | Copy-Item -Destination $scripts
    foreach ($name in @('Install.cmd','install.ps1','INSTALLATION.txt')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $bundle }
    $sourceCommit = $env:GITHUB_SHA
    if (-not $sourceCommit) {
        try { $sourceCommit = (& git -C $repo rev-parse HEAD 2>$null | Select-Object -First 1); if ($LASTEXITCODE -ne 0) { $sourceCommit = $null } } catch { $sourceCommit = $null }
    }
    & (Join-Path $node 'node.exe') --test (Join-Path $repo 'server.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed with the bundled Node.js runtime.' }
    if (Test-Path -LiteralPath (Join-Path $repo 'THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $repo 'THIRD_PARTY_NOTICES.md') -Destination $bundle }
    $manifest = [ordered]@{ application = 'strata-dual-device-monitor'; version = $Version; platform = 'windows-x64'; sourceCommit = $sourceCommit;
        copyright = 'Copyright (c) 2026 edowadolui-lab'; runtime = $runtime; files = @() }
    $manifest.files = @(Get-ChildItem -LiteralPath $bundle -File -Recurse | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($bundle.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $manifestText = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $bundle 'release-manifest.json'), $manifestText, (New-Object Text.UTF8Encoding $false))
    $zipName = 'strata-dual-device-monitor-v' + $Version + '-windows-x64.zip'
    $zip = Join-Path $dist $zipName
    Compress-Archive -LiteralPath $bundle -DestinationPath $zip -Force
    $sum = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), ($sum + '  ' + $zipName + "`n"), (New-Object Text.UTF8Encoding $false))
    [IO.File]::WriteAllText((Join-Path $dist 'release-manifest.json'), $manifestText, (New-Object Text.UTF8Encoding $false))
    Write-Output ('Release archive: ' + $zip)
    Write-Output ('SHA256: ' + $sum)
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if ($resolvedStage.StartsWith(([IO.Path]::GetFullPath($cache) + '\'), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
