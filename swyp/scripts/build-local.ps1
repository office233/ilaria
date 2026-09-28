# Build the Swyp developer CLI. This is not a language/runtime dependency.
# Existing binaries are retained in agent-lab before the new one is published.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin'
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
$backupDir = Join-Path $root ('agent-lab\build-' + $stamp)
New-Item -ItemType Directory -Force -Path $bin | Out-Null
New-Item -ItemType Directory -Path $backupDir | Out-Null
$temporary = Join-Path $bin ('swyp-build-' + $stamp + '.exe')
$destination = Join-Path $bin 'swyp.exe'
$oldCGO = $env:CGO_ENABLED
Push-Location $root
try {
    $env:CGO_ENABLED = '0'
    & go build -trimpath -o $temporary ./cmd/swyp
    if ($LASTEXITCODE -ne 0) { throw 'Swyp build failed; the previous executable was not changed.' }
    & $temporary version
    if ($LASTEXITCODE -ne 0) { throw 'The new executable failed its version check.' }
    $backup = $null
    if (Test-Path -LiteralPath $destination) {
        $backup = Join-Path $backupDir 'swyp.previous.exe'
        [System.IO.File]::Replace($temporary, $destination, $backup)
    } else {
        [System.IO.File]::Move($temporary, $destination)
    }
    $record = [ordered]@{
        builtAt = (Get-Date).ToUniversalTime().ToString('o')
        headCommit = ((& git rev-parse HEAD) -join '').Trim()
        executable = $destination
        sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        previousExecutable = $backup
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'build.json') -Encoding UTF8
    Write-Output ('READY: ' + $destination)
    Write-Output ('BUILD_RECORD: ' + (Join-Path $backupDir 'build.json'))
} finally {
    $env:CGO_ENABLED = $oldCGO
    Pop-Location
    # Only delete the uniquely named, temporary build output owned by this run.
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
