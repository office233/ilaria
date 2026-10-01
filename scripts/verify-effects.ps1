[CmdletBinding()]
param(
    [string]$GoCommand = 'go',
    [string]$PythonCommand = 'python'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryBase ('nexus-effects-' + [Guid]::NewGuid().ToString('N'))
$previousWork = $env:GOWORK
$previousOS = $env:GOOS
$previousArch = $env:GOARCH

New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $env:GOWORK = 'off'
    $hostTarget = @(& $GoCommand env GOHOSTOS GOHOSTARCH)
    if ($LASTEXITCODE -ne 0 -or $hostTarget.Count -ne 2) { throw 'Cannot determine the native Go target.' }
    $env:GOOS = $hostTarget[0].Trim()
    $env:GOARCH = $hostTarget[1].Trim()
    $extension = if ($env:GOOS -eq 'windows') { '.exe' } else { '' }
    $commands = @(
        @{ Product = 'swyp'; Command = 'swyp' },
        @{ Product = 'swypik-os'; Command = 'effect-broker' },
        @{ Product = 'ilaria'; Command = 'evidence-check' }
    )
    foreach ($command in $commands) {
        Push-Location -LiteralPath (Join-Path $root $command.Product)
        try {
            $output = Join-Path $temporary ($command.Command + $extension)
            & $GoCommand build -buildvcs=false -trimpath -o $output "./cmd/$($command.Command)"
            if ($LASTEXITCODE -ne 0) { throw "Effects CLI build failed: $($command.Product)/$($command.Command)" }
        } finally {
            Pop-Location
        }
    }
    & $PythonCommand (Join-Path $PSScriptRoot 'verify-effects.py') `
        --swyp (Join-Path $temporary ('swyp' + $extension)) `
        --broker (Join-Path $temporary ('effect-broker' + $extension)) `
        --verifier (Join-Path $temporary ('evidence-check' + $extension))
    if ($LASTEXITCODE -ne 0) { throw 'Effects v1 integration gate failed.' }
} finally {
    $env:GOWORK = $previousWork
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if (([IO.Path]::GetDirectoryName($resolvedTemporary) -eq $temporaryBase.TrimEnd('\', '/')) -and
        ([IO.Path]::GetFileName($resolvedTemporary) -match '^nexus-effects-[0-9a-f]{32}$')) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    } else {
        throw "Refusing to remove unexpected temporary path: $resolvedTemporary"
    }
}
