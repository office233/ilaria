<#
Starts the local Ilaria model service from this Nexus checkout and opens the
SwypikOS desktop connected to it.

  powershell -File swypik-os\scripts\start-with-ilaria.ps1          # GPU if available
  powershell -File swypik-os\scripts\start-with-ilaria.ps1 -Cpu     # force CPU (slow)

Nothing is downloaded: the model and tokenizer must already exist under the
Nexus data directory (see -Model and -Tokenizer). The service listens only on
127.0.0.1 and is stopped when the desktop window closes.
#>
[CmdletBinding()]
param(
    [string]$NexusRoot = '',
    [string]$Model = '',
    [string]$Tokenizer = '',
    [int]$Port = 8091,
    [int]$MaxTokens = 256,
    [switch]$Cpu
)
$ErrorActionPreference = 'Stop'

$swypik = Split-Path -Parent $PSScriptRoot
if (-not $NexusRoot) { $NexusRoot = Split-Path -Parent $swypik }
if (-not $Model) { $Model = Join-Path $NexusRoot 'data\forge\bitnet-2b4t\bitnet.nxtf' }
if (-not $Tokenizer) { $Tokenizer = Join-Path $NexusRoot 'data\pretrained\bitnet-b1.58-2B-4T\tokenizer.json' }
foreach ($required in @($Model, $Tokenizer)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing Ilaria file: $required" }
}

$useCuda = -not $Cpu -and [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$binDir = Join-Path $env:LOCALAPPDATA 'SwypikOS\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$serve = Join-Path $binDir ($(if ($useCuda) { 'ilaria-serve-gpu.exe' } else { 'ilaria-serve.exe' }))
$desktop = Join-Path $binDir 'swypik-os.exe'

Write-Host "Building Ilaria service ($(if ($useCuda) { 'CUDA' } else { 'CPU' }))..."
Push-Location $NexusRoot
try {
    if ($useCuda) { $env:CGO_ENABLED = '1'; go build -tags gpu -o $serve ./cmd/ilaria-serve }
    else { go build -o $serve ./cmd/ilaria-serve }
    if ($LASTEXITCODE -ne 0) { throw 'ilaria-serve build failed' }
} finally { Pop-Location; Remove-Item Env:\CGO_ENABLED -ErrorAction SilentlyContinue }

Write-Host 'Building SwypikOS desktop...'
Push-Location $swypik
try {
    go build -trimpath -ldflags '-H=windowsgui -X main.desktopGUI=true' -o $desktop ./cmd/swypik-os
    if ($LASTEXITCODE -ne 0) { throw 'SwypikOS build failed' }
} finally { Pop-Location }

$serveArgs = @('-model', $Model, '-tokenizer', $Tokenizer, '-port', "$Port", '-max-tokens', "$MaxTokens")
if ($useCuda) { $serveArgs = @('-cuda') + $serveArgs }
$log = Join-Path $env:LOCALAPPDATA 'SwypikOS\logs'
New-Item -ItemType Directory -Force -Path $log | Out-Null
$server = Start-Process -FilePath $serve -ArgumentList $serveArgs -PassThru -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $log 'ilaria-serve.err.log') -RedirectStandardOutput (Join-Path $log 'ilaria-serve.out.log')
try {
    Write-Host 'Loading the model (up to 3 minutes on first start)...'
    $deadline = (Get-Date).AddMinutes(3)
    $ready = $false
    while ((Get-Date) -lt $deadline -and -not $server.HasExited) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.status -eq 'ready') { $ready = $true; break }
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ready) { throw "Ilaria did not become ready; see $log\ilaria-serve.err.log" }
    Write-Host "Ilaria ready on http://127.0.0.1:$Port. Opening SwypikOS."
    $ui = Start-Process -FilePath $desktop -ArgumentList @('-ilaria-url', "http://127.0.0.1:$Port") -PassThru
    $ui.WaitForExit()
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
