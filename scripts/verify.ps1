[CmdletBinding()]
param(
    [ValidateSet('Windows', 'Linux')][string]$Target = 'Windows',
    [string]$Distro = 'swypik',
    [switch]$Race
)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/build.ps1" -Target $Target -Distro $Distro -VerifyOnly
if ($Target -ne 'Windows' -or -not $Race) { return }
$previousCGO = $env:CGO_ENABLED
$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    $env:CGO_ENABLED = '1'
    $env:GOOS = 'windows'
    $env:GOARCH = (& go env GOHOSTARCH).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine the native Go architecture.' }
    & go test -race -count=1 -timeout=5m ./...
    if ($LASTEXITCODE -ne 0) { throw 'Windows race-detector verification failed. A compatible C compiler is required.' }
    Write-Host 'Windows race-detector verification passed.'
} finally {
    $env:CGO_ENABLED = $previousCGO
    $env:GOOS = $previousGOOS
    $env:GOARCH = $previousGOARCH
    Pop-Location
}
