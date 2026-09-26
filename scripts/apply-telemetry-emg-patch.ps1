param([string]$InstallDirectory = 'C:\PulsePoint-Standalone\desktop-release\win-unpacked')
$ErrorActionPreference = 'Stop'
$appDirectory = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'resources\app'))
$executable = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'Sarah.exe'))
$payloadDirectory = Join-Path $PSScriptRoot 'payload'
$installed = Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw | ConvertFrom-Json
if ($installed.name -ne 'sarah-standalone' -or $installed.version -notin @('0.1.266', '0.1.267', '0.1.268')) {
    throw 'This patch requires the Sarah 0.1.266 or 0.1.267 Windows installation.'
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
# Check every source and destination before stopping Sarah or replacing files.
foreach ($entry in $manifest) {
    $source = [IO.Path]::GetFullPath((Join-Path $payloadDirectory $entry.path))
    $destination = [IO.Path]::GetFullPath((Join-Path $appDirectory $entry.path))
    if (!$source.StartsWith([IO.Path]::GetFullPath($payloadDirectory) + '\', [StringComparison]::OrdinalIgnoreCase) -or !$destination.StartsWith($appDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid patch path.' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Patch checksum failed: $($entry.path)" }
}
$running = @(Get-Process Sarah -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable })
if ($running.Count) {
    $capture = Invoke-RestMethod 'http://127.0.0.1:8787/api/live-capture/status' -TimeoutSec 5
    if ($capture.session.active -or $capture.hr.recording.active) { throw 'End the active capture before applying this patch.' }
    Start-Process -FilePath $executable -ArgumentList '--sarah-release-quit' -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $running = @(Get-Process Sarah -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable })
    } while ($running.Count -and (Get-Date) -lt $deadline)
    if ($running.Count) { throw 'Sarah did not close. Quit Sarah, then run this patch again.' }
}
if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { throw 'The Sarah backend is still running. Close it before applying the patch.' }
$backup = Join-Path $InstallDirectory ('patch-backups\0.1.268-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($entry in $manifest) {
    $destination = Join-Path $appDirectory $entry.path
    if (Test-Path -LiteralPath $destination) {
        $previous = Join-Path $backup $entry.path
        New-Item -ItemType Directory -Force -Path (Split-Path $previous) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $previous -Force
    }
}
foreach ($entry in $manifest) {
    $destination = Join-Path $appDirectory $entry.path
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $payloadDirectory $entry.path) -Destination $destination -Force
}
Start-Process -FilePath $executable -WindowStyle Hidden
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $null = Invoke-RestMethod 'http://127.0.0.1:8787/api/live-capture/emg/helper' -TimeoutSec 2
        $ready = $true
        break
    } catch { }
}
if (!$ready) { throw "Files updated, but backend readiness was not confirmed. Backup: $backup" }
Write-Host "Sarah 0.1.268 is ready. Previous files are backed up at $backup"
