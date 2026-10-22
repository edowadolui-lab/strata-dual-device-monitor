$ErrorActionPreference = 'Stop'
$script:AppId = 'strata-dual-device-monitor'
$script:AppName = 'Strata Dual Device Monitor'
$script:AppFolder = 'StrataDualDeviceMonitor'

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $full = Get-FullPath $Path
    $base = Get-FullPath $Parent
    if (-not $full.StartsWith(($base + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Managed path must be below its expected parent directory.' }
    return $full
}

function Assert-NoReparsePoint([string]$Path, [switch]$Recurse) {
    $ancestor = [IO.Path]::GetFullPath($Path)
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing to modify a managed path with a symbolic link or junction in its ancestry.'
        }
        $parent = [IO.Directory]::GetParent($ancestor)
        $ancestor = if ($parent) { $parent.FullName } else { $null }
    }
    if (Test-Path -LiteralPath $Path) {
        $items = @(Get-Item -LiteralPath $Path -Force)
        if ($Recurse) { $items += @(Get-ChildItem -LiteralPath $Path -Force -Recurse) }
        foreach ($item in $items) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to modify a managed directory containing a symbolic link or junction.' }
        }
    }
}

function Write-Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
}

function Protect-UserFolder([string]$Path) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $directory = New-Object IO.DirectoryInfo $Path
    if ($PSVersionTable.PSEdition -eq 'Core') {
        $acl = [IO.FileSystemAclExtensions]::GetAccessControl($directory, [Security.AccessControl.AccessControlSections]::Access)
    } else {
        $acl = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }
    foreach ($sid in @($identity, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl) }
    else { $directory.SetAccessControl($acl) }
}

function Get-InstallContext {
    $installRoot = Get-FullPath (Join-Path $PSScriptRoot '..')
    $markerPath = Join-Path $installRoot '.installation.json'
    if (-not (Test-Path -LiteralPath $markerPath)) { throw 'This script must run from an installed monitor.' }
    $context = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($context.appId -ne $script:AppId -or (Get-FullPath $context.installRoot) -ne $installRoot) { throw 'Invalid installation marker.' }
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if ($context.testInstall -eq $true) {
        $null = Assert-ChildPath $installRoot ([IO.Path]::GetTempPath())
        $testRoot = Get-FullPath $context.testRoot
        $null = Assert-ChildPath $testRoot ([IO.Path]::GetTempPath())
        if ($installRoot -ne (Get-FullPath (Join-Path $testRoot 'Programs\StrataDualDeviceMonitor')) -or
            (Get-FullPath $context.dataRoot) -ne (Get-FullPath (Join-Path $testRoot 'Data\StrataDualDeviceMonitor'))) { throw 'Invalid test installation paths.' }
    } else {
        if ($installRoot -ne (Get-FullPath (Join-Path $local 'Programs\StrataDualDeviceMonitor')) -or
            (Get-FullPath $context.dataRoot) -ne (Get-FullPath (Join-Path $local 'StrataDualDeviceMonitor'))) { throw 'Unexpected installation paths.' }
    }
    Assert-NoReparsePoint $installRoot
    Assert-NoReparsePoint $context.dataRoot
    return $context
}

function Get-OwnedMonitorProcess($Context) {
    $stateFile = Join-Path $Context.dataRoot 'monitor-process.json'
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ($state.appId -ne $script:AppId) { return $null }
        $process = Get-Process -Id ([int]$state.processId) -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$state.startTimeTicks) { return $null }
        $node = Get-FullPath (Join-Path $Context.installRoot 'runtime\node.exe')
        $server = Get-FullPath (Join-Path $Context.installRoot 'app\server.mjs')
        $detail = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$state.processId)
        if (-not $detail -or (Get-FullPath $detail.ExecutablePath) -ne $node -or
            -not $detail.CommandLine.Contains(('"' + $server + '"'))) { return $null }
        return $process
    } catch { return $null }
}

function Stop-OwnedMonitor($Context) {
    $process = Get-OwnedMonitorProcess $Context
    if ($process) {
        try {
            try {
                if (-not $process.HasExited) { $process.Kill() }
            } catch {
                if (-not $process.HasExited) { throw }
            }
            if (-not $process.WaitForExit(5000)) { throw 'The verified monitor process did not stop within five seconds.' }
        } finally { $process.Dispose() }
    }
    $stateFile = Join-Path $Context.dataRoot 'monitor-process.json'
    if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile -Force }
}

function Show-LaunchError([string]$Message) {
    Write-Error $Message -ErrorAction Continue
    try { $shell = New-Object -ComObject WScript.Shell; $null = $shell.Popup($Message, 0, $script:AppName, 16) } catch { }
}
