[CmdletBinding()]
param([switch]$RemoveUserData)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-InstallContext
Stop-OwnedMonitor $context
if ($context.testInstall -ne $true) {
    $shell = New-Object -ComObject WScript.Shell
    $startMenu = Get-FullPath (Join-Path ([Environment]::GetFolderPath('Programs')) $script:AppName)
    $desktop = Get-FullPath (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ($script:AppName + '.lnk'))
    foreach ($item in $context.shortcuts) {
        $path = Get-FullPath $item
        $allowed = $path -eq $desktop -or $path.StartsWith(($startMenu + '\'), [StringComparison]::OrdinalIgnoreCase)
        if ($allowed -and (Test-Path -LiteralPath $path -PathType Leaf)) {
            $shortcut = $shell.CreateShortcut($path)
            if ($shortcut.Arguments.Contains(('"' + $context.installRoot + '\scripts\'))) { Remove-Item -LiteralPath $path -Force }
        }
    }
    if ((Test-Path -LiteralPath $startMenu) -and @(Get-ChildItem -LiteralPath $startMenu -Force).Count -eq 0) { Remove-Item -LiteralPath $startMenu -Force }
}
$installRoot = Get-FullPath $context.installRoot
Assert-NoReparsePoint $installRoot -Recurse
Remove-Item -LiteralPath $installRoot -Recurse -Force
if ($RemoveUserData) {
    $dataRoot = Get-FullPath $context.dataRoot
    Assert-NoReparsePoint $dataRoot -Recurse
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
    Write-Output 'Monitor application and its local configuration/logs were removed.'
} else {
    Write-Output ('Monitor removed. Local configuration/logs preserved: ' + $context.dataRoot)
}
