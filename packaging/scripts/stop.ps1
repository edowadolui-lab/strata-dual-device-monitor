[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-InstallContext
Stop-OwnedMonitor $context
Write-Output 'The installed monitor is stopped. Strata and its remote worker were not changed.'
