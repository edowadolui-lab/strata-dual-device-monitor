[CmdletBinding()]
param([switch]$NoShortcuts, [switch]$NoLaunch, [string]$TestRoot, [ValidateRange(1024,65535)][int]$Port = 47832)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\common.ps1')
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This package requires Windows x64.' }
$local = [Environment]::GetFolderPath('LocalApplicationData')
$isTest = -not [string]::IsNullOrWhiteSpace($TestRoot)
if ($isTest) {
    $TestRoot = Assert-ChildPath $TestRoot ([IO.Path]::GetTempPath())
    $installRoot = Get-FullPath (Join-Path $TestRoot 'Programs\StrataDualDeviceMonitor')
    $dataRoot = Get-FullPath (Join-Path $TestRoot 'Data\StrataDualDeviceMonitor')
    if (-not $NoShortcuts) { throw 'Test installations require -NoShortcuts.' }
} else {
    $installRoot = Get-FullPath (Join-Path $local 'Programs\StrataDualDeviceMonitor')
    $dataRoot = Get-FullPath (Join-Path $local 'StrataDualDeviceMonitor')
}
foreach ($path in @($installRoot,$dataRoot)) { Assert-NoReparsePoint $path -Recurse }
$markerPath = Join-Path $installRoot '.installation.json'
if (Test-Path -LiteralPath $installRoot) {
    if (-not (Test-Path -LiteralPath $markerPath)) { throw 'The destination exists without a monitor installation marker. Nothing was changed.' }
    $old = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($old.appId -ne $script:AppId -or (Get-FullPath $old.installRoot) -ne $installRoot -or (Get-FullPath $old.dataRoot) -ne $dataRoot) { throw 'The existing installation marker does not match this monitor.' }
    Stop-OwnedMonitor $old
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json') -Raw | ConvertFrom-Json
if ($manifest.application -ne $script:AppId) { throw 'Invalid release manifest.' }
foreach ($file in $manifest.files) {
    $source = Assert-ChildPath (Join-Path $PSScriptRoot $file.path) $PSScriptRoot
    if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Release file integrity check failed: ' + $file.path) }
}
New-Item -ItemType Directory -Path $installRoot,$dataRoot -Force | Out-Null
Protect-UserFolder $dataRoot
foreach ($directory in @('app','runtime','scripts')) {
    $target = Join-Path $installRoot $directory
    if (Test-Path -LiteralPath $target) {
        $null = Assert-ChildPath $target $installRoot
        Assert-NoReparsePoint $target -Recurse
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $directory) -Destination $installRoot -Recurse
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json') -Destination $installRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'INSTALLATION.txt') -Destination $installRoot
$configPath = Join-Path $dataRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { Copy-Item -LiteralPath (Join-Path $installRoot 'app\config.example.json') -Destination $configPath }
$context = [ordered]@{ appId = $script:AppId; version = $manifest.version; installRoot = $installRoot; dataRoot = $dataRoot;
    testInstall = $isTest; testRoot = $TestRoot; port = $Port; shortcuts = @() }
if (-not $NoShortcuts) {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) $script:AppName
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $links = @(
        @{ Name = $script:AppName; File = 'start.ps1'; Visible = $false },
        @{ Name = 'Configure Monitor'; File = 'configure.ps1'; Visible = $true },
        @{ Name = 'Stop Monitor'; File = 'stop.ps1'; Visible = $false },
        @{ Name = 'Uninstall Monitor'; File = 'uninstall.ps1'; Visible = $true }
    )
    foreach ($link in $links) {
        $shortcutPath = Join-Path $startMenu ($link.Name + '.lnk')
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $powershell
        $window = if ($link.Visible) { 'Normal' } else { 'Hidden' }
        $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle ' + $window + ' -File "' + (Join-Path $installRoot ('scripts\' + $link.File)) + '"'
        $shortcut.WorkingDirectory = $installRoot
        $shortcut.Description = 'Independent read-only Strata cluster monitor'
        $shortcut.Save()
        $context.shortcuts += $shortcutPath
    }
    $desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ($script:AppName + '.lnk')
    Copy-Item -LiteralPath (Join-Path $startMenu ($script:AppName + '.lnk')) -Destination $desktop -Force
    $context.shortcuts += $desktop
}
Write-Json $markerPath $context
Write-Output ('Installed Strata Dual Device Monitor ' + $manifest.version)
Write-Output ('Application: ' + $installRoot)
Write-Output ('Configuration: ' + $configPath)
Write-Output 'Use Configure Monitor before connecting to your existing StrataLink setup.'
if (-not $NoLaunch) { & (Join-Path $installRoot 'scripts\start.ps1') }
