[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ArchivePath, [switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('strata-monitor-install-test-' + [Guid]::NewGuid().ToString('N'))
$testRoot = Join-Path $taskRoot 'isolated-user'
$extracted = Join-Path $taskRoot 'archive'
New-Item -ItemType Directory -Path $taskRoot,$extracted -Force | Out-Null
$fixture = $null
$installed = $null
function Assert-PrivateConfiguration([string]$ConfigFile) {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($currentSid, 'S-1-5-18')
    foreach ($rule in (Get-Acl -LiteralPath $ConfigFile).Access) {
        if ($allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { throw 'Configuration has an unexpected access rule.' }
    }
    if (-not (Get-Acl -LiteralPath (Split-Path -Parent $ConfigFile)).AreAccessRulesProtected) { throw 'Configuration folder inheritance was not restricted.' }
}
try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extracted
    $bundle = @(Get-ChildItem -LiteralPath $extracted -Directory)
    if ($bundle.Count -ne 1) { throw 'Release ZIP must contain exactly one application folder.' }
    $bundle = $bundle[0].FullName
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    & (Join-Path $bundle 'install.ps1') -NoShortcuts -NoLaunch -TestRoot $testRoot -Port $port
    $installed = Join-Path $testRoot 'Programs\StrataDualDeviceMonitor'
    $data = Join-Path $testRoot 'Data\StrataDualDeviceMonitor'
    $node = Join-Path $installed 'runtime\node.exe'
    $portFile = Join-Path $taskRoot 'fixture-port.json'
    $fixture = Start-Process -FilePath (Join-Path $bundle 'runtime\node.exe') -ArgumentList ('"' + (Join-Path $PSScriptRoot 'test-fixture.mjs') + '" "' + $portFile + '"') -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $portFile); $attempt++) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $portFile)) { throw 'Synthetic telemetry fixture did not start.' }
    $fixturePort = (Get-Content -LiteralPath $portFile -Raw | ConvertFrom-Json).port
    $configFile = Join-Path $data 'config.json'
    Assert-PrivateConfiguration $configFile
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $cfg.primary.metricsURL = 'http://127.0.0.1:' + $fixturePort + '/metrics?workers=1'
    $cfg.remote.agentURL = 'http://127.0.0.1:' + $fixturePort + '/info'
    $cfg.primary | Add-Member NoteProperty apiKey 'synthetic-primary-key' -Force
    $cfg.remote | Add-Member NoteProperty stageToken 'synthetic-stage-token' -Force
    [IO.File]::WriteAllText($configFile, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
    & $node (Join-Path $installed 'scripts\validate-config.mjs') (Join-Path $installed 'app\server.mjs') $configFile
    if ($LASTEXITCODE -ne 0) { throw 'Valid synthetic configuration rejected.' }
    $invalidFile = Join-Path $taskRoot 'invalid-config.json'
    $invalidCfg = $cfg | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $invalidCfg.primary.metricsURL = 'https://example.com/metrics'
    [IO.File]::WriteAllText($invalidFile, ($invalidCfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
    $invalidTest = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $installed 'scripts\validate-config.mjs') + '" "' + (Join-Path $installed 'app\server.mjs') + '" "' + $invalidFile + '"') -WindowStyle Hidden -Wait -PassThru `
        -RedirectStandardOutput (Join-Path $taskRoot 'validation.stdout.log') -RedirectStandardError (Join-Path $taskRoot 'validation.stderr.log')
    if ($invalidTest.ExitCode -eq 0) { throw 'Invalid configuration was accepted.' }
    & (Join-Path $installed 'scripts\start.ps1') -NoBrowser
    $stateFile = Join-Path $data 'monitor-process.json'
    $state = Get-Content -LiteralPath $stateFile -Raw
    $firstProcessId = ($state | ConvertFrom-Json).processId
    & (Join-Path $installed 'scripts\start.ps1') -NoBrowser
    if ((Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json).processId -ne $firstProcessId) { throw 'Repeated launch created another monitor process.' }
    $base = 'http://127.0.0.1:' + $port
    $status = Invoke-RestMethod -Uri ($base + '/api/status') -TimeoutSec 5
    if ($status.primary.connection.state -ne 'online' -or $status.apex.connection.state -ne 'online' -or $status.link.state -ne 'connected') { throw 'Installed monitor did not read the two synthetic device sources.' }
    if ($status.model.localLayers[1] -ne 43 -or $status.model.remoteLayers[0] -ne 44) { throw 'Layer split fixture mismatch.' }
    $fixture.Refresh()
    $fakeState = @{ appId = 'strata-dual-device-monitor'; processId = $fixture.Id; startTimeTicks = $fixture.StartTime.ToUniversalTime().Ticks.ToString() }
    [IO.File]::WriteAllText($stateFile, ($fakeState | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    & (Join-Path $installed 'scripts\stop.ps1')
    $fixture.Refresh()
    if ($fixture.HasExited) { throw 'Stop terminated an unrelated Node process.' }
    [IO.File]::WriteAllText($stateFile, $state, (New-Object Text.UTF8Encoding $false))
    & (Join-Path $installed 'scripts\stop.ps1')
    $remaining = Get-Process -Id $firstProcessId -ErrorAction SilentlyContinue
    if ($remaining) {
        try {
            if ($remaining.StartTime.ToUniversalTime().Ticks.ToString() -eq ($state | ConvertFrom-Json).startTimeTicks -and -not $remaining.WaitForExit(5000)) { throw 'Owned monitor process remained after Stop.' }
        } finally { $remaining.Dispose() }
    }
    $configBefore = (Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash
    & (Join-Path $bundle 'install.ps1') -NoShortcuts -NoLaunch -TestRoot $testRoot -Port $port
    Assert-PrivateConfiguration $configFile
    if ((Get-FileHash -LiteralPath $configFile -Algorithm SHA256).Hash -ne $configBefore) { throw 'Upgrade changed existing user configuration.' }
    & (Join-Path $installed 'scripts\uninstall.ps1')
    if ((Test-Path -LiteralPath $installed) -or -not (Test-Path -LiteralPath $configFile)) { throw 'Default uninstall did not preserve user configuration.' }
    & (Join-Path $bundle 'install.ps1') -NoShortcuts -NoLaunch -TestRoot $testRoot -Port $port
    & (Join-Path $installed 'scripts\uninstall.ps1') -RemoveUserData
    if ((Test-Path -LiteralPath $installed) -or (Test-Path -LiteralPath $data)) { throw 'Explicit user-data uninstall did not clean the test installation.' }
    Write-Output 'PASS: clean install, protected config, configuration validation, two synthetic devices/layers, repeat launch, process ownership, upgrade, stop, uninstall preserving config, explicit user-data removal.'
} catch {
    Write-Output ('INSTALL TEST FAILED: ' + $_.Exception.Message)
    throw
} finally {
    if ($installed -and (Test-Path -LiteralPath (Join-Path $installed 'scripts\stop.ps1'))) {
        try { & (Join-Path $installed 'scripts\stop.ps1') } catch { }
    }
    if ($fixture) {
        $fixture.Refresh()
        if (-not $fixture.HasExited) {
            Stop-Process -Id $fixture.Id -Force
            try { Wait-Process -Id $fixture.Id -Timeout 5 -ErrorAction Stop } catch { }
        }
        $null = $fixture.WaitForExit(5000)
        $fixture.Dispose()
    }
    $resolved = [IO.Path]::GetFullPath($taskRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('strata-monitor-install-test-') -and (Test-Path -LiteralPath $resolved)) {
        for ($cleanupAttempt = 0; $cleanupAttempt -lt 20; $cleanupAttempt++) {
            try { Remove-Item -LiteralPath $resolved -Recurse -Force; break }
            catch { if ($cleanupAttempt -eq 19) { Write-Warning ('Temporary test files could not yet be removed: ' + $resolved) }; Start-Sleep -Milliseconds 200 }
        }
    }
}
