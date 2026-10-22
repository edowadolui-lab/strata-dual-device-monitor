[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$context = Get-InstallContext
$lockName = 'Local\StrataDualDeviceMonitor-' + ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($context.installRoot)).Replace('\','').Replace('/','').Replace('=',''))
$mutex = New-Object Threading.Mutex($false, $lockName)
$locked = $false
try {
    $locked = $mutex.WaitOne(10000)
    if (-not $locked) { throw 'Another monitor launcher is busy. Try again shortly.' }
    $url = 'http://127.0.0.1:' + $context.port
    $process = Get-OwnedMonitorProcess $context
    if (-not $process) {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$context.port)
        try { $listener.Start() } catch { throw ('Monitor port ' + $context.port + ' is occupied by another program or monitor copy. Stop that copy using its own launcher first.') }
        finally { $listener.Stop() }
        $node = Join-Path $context.installRoot 'runtime\node.exe'
        $server = Join-Path $context.installRoot 'app\server.mjs'
        $previousConfig = $env:STRATA_MONITOR_CONFIG
        $previousPort = $env:STRATA_MONITOR_PORT
        try {
            $env:STRATA_MONITOR_CONFIG = Join-Path $context.dataRoot 'config.json'
            $env:STRATA_MONITOR_PORT = [string]$context.port
            $process = Start-Process -FilePath $node -ArgumentList ('"' + $server + '"') -WorkingDirectory (Join-Path $context.installRoot 'app') -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $context.dataRoot 'monitor.stdout.log') -RedirectStandardError (Join-Path $context.dataRoot 'monitor.stderr.log')
        } finally { $env:STRATA_MONITOR_CONFIG = $previousConfig; $env:STRATA_MONITOR_PORT = $previousPort }
        Write-Json (Join-Path $context.dataRoot 'monitor-process.json') ([ordered]@{ appId = $script:AppId; processId = $process.Id; startTimeTicks = $process.StartTime.ToUniversalTime().Ticks.ToString() })
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Get-OwnedMonitorProcess $context)) { throw 'The monitor exited during startup. Check monitor.stderr.log in your configuration folder.' }
        try {
            $health = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 2
            if ($health.service -eq $script:AppId -and $health.readOnly -eq $true) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw 'The monitor did not become ready. Check the local log files.' }
    if (-not $NoBrowser) { Start-Process -FilePath $url | Out-Null }
    Write-Output ('Monitor ready: ' + $url)
} catch {
    if ($NoBrowser) { throw }
    Show-LaunchError $_.Exception.Message
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
