$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'bin') | Out-Null
    & go build -o bin/swypik-os.exe ./cmd/swypik-os
    if ($LASTEXITCODE -ne 0) { throw 'SwypikOS build failed' }
    & go build -o bin/SwypikInstaller.exe ./installer/windows
    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
    Write-Host 'Build complete: bin/swypik-os.exe and bin/SwypikInstaller.exe'
} finally {
    Pop-Location
}
