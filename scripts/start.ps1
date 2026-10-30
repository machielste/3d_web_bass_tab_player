$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:UV_CACHE_DIR = Join-Path (Get-Location) '.cache\uv'
if (-not (Test-Path -LiteralPath 'node_modules/three/build/three.module.js')) {
    & npm.cmd install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Could not install Three.js.' }
}
if (-not (Test-Path -LiteralPath '.tools/vgmstream/vgmstream-cli.exe')) {
    Write-Host 'Setting up Rocksmith audio playback (first launch only)...'
    New-Item -ItemType Directory -Force -Path '.tools/vgmstream' | Out-Null
    $archive = Join-Path (Get-Location) '.tools/vgmstream-win64.zip'
    Invoke-WebRequest -Uri 'https://github.com/vgmstream/vgmstream/releases/download/r2168/vgmstream-win64.zip' -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath '.tools/vgmstream' -Force
}
& uv run python server.py @args
exit $LASTEXITCODE
