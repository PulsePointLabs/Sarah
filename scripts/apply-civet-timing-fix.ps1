$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$install = Join-Path $root 'desktop-release\win-unpacked'
$app = Join-Path $install 'resources\app'
if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { throw 'Close Sarah before applying this patch.' }
$backup = Join-Path $install ('patch-backups\civet-timing-' + (Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($file in @('civet.js', 'civetReadiness.js')) {
    $source = Join-Path $root ('src\lib\' + $file)
    $destination = Join-Path $app ('src\lib\' + $file)
    Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $file)
    Copy-Item -LiteralPath $source -Destination $destination -Force
    if ((Get-FileHash $source).Hash -ne (Get-FileHash $destination).Hash) { throw 'Installed file verification failed.' }
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $install 'Sarah.exe') -WindowStyle Hidden
Write-Host 'Timing fix installed. Reconnect CIVET and repeat rest and hold.'
