param([string]$InstallDirectory = 'C:\PulsePoint-Standalone\desktop-release\win-unpacked')
$ErrorActionPreference = 'Stop'
$appDirectory = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'resources\app'))
$installed = Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw | ConvertFrom-Json
if ($installed.name -ne 'sarah-standalone' -or $installed.version -ne '0.1.276') {
    throw 'This display-only patch requires Sarah 0.1.276 for Windows.'
}
$payload = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'payload'))
$manifest = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json)
if (!$manifest.Count -or !($manifest | Where-Object { $_.path -eq 'dist\index.html' })) { throw 'Incomplete patch manifest.' }
foreach ($entry in $manifest) {
    $source = [IO.Path]::GetFullPath((Join-Path $payload $entry.path))
    $destination = [IO.Path]::GetFullPath((Join-Path $appDirectory $entry.path))
    if (!$source.StartsWith($payload + '\dist\', [StringComparison]::OrdinalIgnoreCase) -or !$destination.StartsWith($appDirectory + '\dist\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid display patch path.' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Patch checksum failed: $($entry.path)" }
}
$backup = Join-Path $InstallDirectory ('patch-backups\live-preview-0.1.276-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
# Back up before writing. Keep old hashed assets for already-open windows.
foreach ($entry in $manifest) {
    $destination = Join-Path $appDirectory $entry.path
    if (Test-Path -LiteralPath $destination) {
        $previous = Join-Path $backup $entry.path
        New-Item -ItemType Directory -Force -Path (Split-Path $previous) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $previous -Force
    }
}
# Publish the entry point last, after every asset is in place and verified.
foreach ($entry in ($manifest | Sort-Object { $_.path -eq 'dist\index.html' })) {
    $destination = Join-Path $appDirectory $entry.path
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $payload $entry.path) -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Installed checksum failed: $($entry.path). Backup: $backup" }
}
Write-Host "Live preview chart fix installed. Refresh Sarah when convenient. No services were restarted. Backup: $backup"
