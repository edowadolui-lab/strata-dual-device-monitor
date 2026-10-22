[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-InstallContext
$configPath = Join-Path $context.dataRoot 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

function Read-Setting([string]$Label, [string]$Default) {
    $answer = Read-Host ($Label + ' [' + $Default + ']')
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Read-Secret([string]$Label, [string]$Existing) {
    $secure = Read-Host ($Label + $(if ($Existing) { ' (Enter keeps existing)' } else { '' })) -AsSecureString
    if ($secure.Length -eq 0) { if ($Existing) { return $Existing }; throw 'A credential is required.' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

Write-Host 'Strata Dual Device Monitor - local configuration'
Write-Host 'Your Strata engine and compatible remote /info agent must already be running.'
Write-Host 'Credentials are saved only in your protected Windows user configuration folder.'
Write-Host 'Press Enter to retain an existing setting. No credential is printed.'
$config.primary.metricsURL = Read-Setting 'Primary metrics URL (loopback HTTP)' $config.primary.metricsURL
$config.remote.agentURL = Read-Setting 'Remote agent /info URL (private IPv4 HTTP)' $config.remote.agentURL
$config.remote.stagePeer = Read-Setting 'Remote stage IPv4:port' $config.remote.stagePeer
$config.remote.name = Read-Setting 'Remote device name' $config.remote.name
$config.remote.cpuName = Read-Setting 'Remote CPU name' $config.remote.cpuName
$config.remote.gpuName = Read-Setting 'Remote GPU name' $config.remote.gpuName
$apiKey = Read-Secret 'Primary Strata API key' $config.primary.apiKey
$stageToken = Read-Secret 'Remote agent stage token' $config.remote.stageToken
$config.primary | Add-Member -MemberType NoteProperty -Name apiKey -Value $apiKey -Force
$config.remote | Add-Member -MemberType NoteProperty -Name stageToken -Value $stageToken -Force
$temporary = Join-Path $context.dataRoot ('configuration-' + [Guid]::NewGuid().ToString('N') + '.json')
try {
    Write-Json $temporary $config
    $node = Join-Path $context.installRoot 'runtime\node.exe'
    $server = Join-Path $context.installRoot 'app\server.mjs'
    $validator = Join-Path $context.installRoot 'scripts\validate-config.mjs'
    & $node $validator $server $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Configuration validation failed. The previous configuration was retained.' }
    Move-Item -LiteralPath $temporary -Destination $configPath -Force
    Protect-UserFolder $context.dataRoot
    Write-Host 'Configuration saved. The running monitor reloads it automatically on the next poll.'
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    $apiKey = $null; $stageToken = $null
}
Read-Host 'Press Enter to close' | Out-Null
