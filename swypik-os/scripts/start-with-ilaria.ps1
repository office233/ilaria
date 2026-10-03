<#
Builds the native desktop and connects it to an explicitly configured Ilaria
service. The service must already implement the stable HTTP protocol.
No weights, tokenizer, pretrained architecture or missing server are assumed.

  powershell -File swypik-os\scripts\start-with-ilaria.ps1 -IlariaURL http://127.0.0.1:8091
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$IlariaURL,
    [string]$GoCommand = 'go',
    [string]$Workspace = '',
    [string]$DataDir = '',
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$swypik = Split-Path -Parent $PSScriptRoot
if (-not $DataDir) {
    $DataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SwypikOS'
}
$DataDir = [IO.Path]::GetFullPath($DataDir)
$binDir = Join-Path $DataDir 'bin'
[void][IO.Directory]::CreateDirectory($binDir)
$desktop = Join-Path $binDir 'swypik-os.exe'
$oldWork = $env:GOWORK
$oldOS = $env:GOOS
$oldArch = $env:GOARCH
$oldCGO = $env:CGO_ENABLED
try {
    $env:GOWORK = 'off'
    $target = @(& $GoCommand env GOHOSTOS GOHOSTARCH)
    if ($LASTEXITCODE -ne 0 -or $target.Count -ne 2 -or $target[0].Trim() -ne 'windows') {
        throw 'This launcher requires a native Windows Go toolchain.'
    }
    $env:GOOS = $target[0].Trim()
    $env:GOARCH = $target[1].Trim()
    $env:CGO_ENABLED = '0'
    Write-Host 'Building the native SwypikOS desktop; no model service is started.'
    Push-Location -LiteralPath $swypik
    try {
        & $GoCommand build -trimpath -o $desktop ./cmd/swypik-os
        if ($LASTEXITCODE -ne 0) { throw 'SwypikOS build failed' }
    } finally { Pop-Location }
    $desktopArgs = @('-ilaria-url', $IlariaURL, '-data-dir', $DataDir)
    if ($Workspace) { $desktopArgs += @('-workspace', $Workspace) }
    # Validate the endpoint and paths without a window, network or settings edits.
    & $desktop @desktopArgs -check
    if ($LASTEXITCODE -ne 0) { throw 'Invalid desktop configuration' }
    if (-not $Check) {
        & $desktop @desktopArgs
        if ($LASTEXITCODE -ne 0) { throw 'SwypikOS desktop exited with an error' }
    }
} finally {
    $env:GOWORK = $oldWork
    $env:GOOS = $oldOS
    $env:GOARCH = $oldArch
    $env:CGO_ENABLED = $oldCGO
}
