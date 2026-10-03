[CmdletBinding()]
param(
    [ValidateSet('ilaria', 'swyp', 'swypik-os')]
    [string[]]$Products = @('ilaria', 'swyp', 'swypik-os'),
    [string]$GoCommand = 'go',
    [string]$PythonCommand = 'python',
    [string]$TestTimeout = '180s',
    [switch]$SkipForge,
    [switch]$SkipContracts,
    [switch]$SkipEffects,
    [switch]$SkipSupervisor,
    [string]$KernelCompiler = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$previousWork = $env:GOWORK
$previousOS = $env:GOOS
$previousArch = $env:GOARCH

function Invoke-Check([string]$Command, [string[]]$Arguments) {
    Write-Host "RUN: $Command $($Arguments -join ' ')"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Verification failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

try {
    # Each product must build without the other products or a running model.
    $env:GOWORK = 'off'
    $hostTarget = @(& $GoCommand env GOHOSTOS GOHOSTARCH)
    if ($LASTEXITCODE -ne 0 -or $hostTarget.Count -ne 2) { throw 'Cannot determine the native Go target.' }
    $env:GOOS = $hostTarget[0].Trim()
    $env:GOARCH = $hostTarget[1].Trim()
    foreach ($product in ($Products | Select-Object -Unique)) {
        Push-Location -LiteralPath (Join-Path $root $product)
        try {
            Write-Host "VERIFY: $product"
            Invoke-Check $GoCommand @('vet', './...')
            Invoke-Check $GoCommand @('test', '-count=1', "-timeout=$TestTimeout", './...')
            Invoke-Check $GoCommand @('build', './cmd/...')
            if ($product -eq 'ilaria' -and -not $SkipForge) {
                Invoke-Check $PythonCommand @('-m', 'py_compile', 'forge/imc_model.py', 'forge/train_ilaria.py', 'forge/training_state.py')
                Invoke-Check $PythonCommand @('-m', 'pytest', '-q', 'forge')
            }
        } finally {
            Pop-Location
        }
    }
    if ($Products -contains 'ilaria') {
        Push-Location -LiteralPath (Join-Path $root 'ramasite/benchmarks/ilaria')
        try {
            Invoke-Check $GoCommand @('vet', './...')
            Invoke-Check $GoCommand @('test', '-count=1', "-timeout=$TestTimeout", './...')
        } finally {
            Pop-Location
        }
    }
    if (-not $SkipContracts) {
        & (Join-Path $PSScriptRoot 'verify-contracts.ps1') -GoCommand $GoCommand
    }
    if (-not $SkipEffects -and @($Products | Select-Object -Unique).Count -eq 3) {
        & (Join-Path $PSScriptRoot 'verify-effects.ps1') -GoCommand $GoCommand -PythonCommand $PythonCommand
    } else {
        Write-Host 'Cross-product effects integration not selected. Run verify-effects.ps1 to include it.'
    }
    if (-not $SkipSupervisor -and @($Products | Select-Object -Unique).Count -eq 3) {
        & (Join-Path $PSScriptRoot 'verify-supervisor.ps1') -GoCommand $GoCommand -PythonCommand $PythonCommand
    }
    if ($KernelCompiler) {
        & (Join-Path $root 'swypik-os/kernel/test-host.ps1') -Compiler $KernelCompiler
    } else {
        Write-Host 'Native kernel host tests not selected. Pass -KernelCompiler <gcc-or-zig-path> to include them.'
    }
    Push-Location -LiteralPath $root
    try {
        Invoke-Check 'git' @('diff', '--check')
    } finally {
        Pop-Location
    }
    Write-Host 'PASS: all selected workspace checks'
} finally {
    $env:GOWORK = $previousWork
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
}
