[CmdletBinding()]
param(
    [string]$GoCommand = 'go',
    [string]$PythonCommand = 'python',
    [string]$LinuxCgroupRoot = $env:NEXUS_TEST_CGROUP_ROOT,
    [switch]$AllowSkips,
    [string]$JsonOutput = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryBase ('nexus-supervisor-v3-worker5-' + [Guid]::NewGuid().ToString('N'))
$previousWork = $env:GOWORK
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
New-Item -ItemType Directory -Path $temporary | Out-Null

try {
    $env:GOWORK = 'off'
    $hostTarget = @(& $GoCommand env GOHOSTOS GOHOSTARCH)
    if ($LASTEXITCODE -ne 0 -or $hostTarget.Count -ne 2) {
        throw 'Cannot determine the native Go target.'
    }
    $env:GOOS = $hostTarget[0].Trim()
    $env:GOARCH = $hostTarget[1].Trim()
    $extension = if ($env:GOOS -eq 'windows') { '.exe' } else { '' }
    $commands = @(
        @{ Product = 'swyp'; Command = 'swyp' },
        @{ Product = 'swypik-os'; Command = 'plan-supervisor' },
        @{ Product = 'ilaria'; Command = 'evidence-check' }
    )
    foreach ($command in $commands) {
        Push-Location -LiteralPath (Join-Path $root $command.Product)
        try {
            & $GoCommand build -buildvcs=false -trimpath -o (Join-Path $temporary ($command.Command + $extension)) "./cmd/$($command.Command)"
            if ($LASTEXITCODE -ne 0) {
                throw "Supervisor v3 CLI build failed: $($command.Product)/$($command.Command)"
            }
        } finally {
            Pop-Location
        }
    }

    $arguments = @(
        (Join-Path $PSScriptRoot 'verify-supervisor-v3.py'),
        '--repo-root', $root,
        '--swyp', (Join-Path $temporary ('swyp' + $extension)),
        '--supervisor', (Join-Path $temporary ('plan-supervisor' + $extension)),
        '--verifier', (Join-Path $temporary ('evidence-check' + $extension)),
        '--artifacts-dir', $temporary
    )
    if ($env:GOOS -eq 'linux') {
        if (-not $LinuxCgroupRoot) {
            throw 'Linux supervisor v3 integration requires an explicit delegated cgroup root.'
        }
        $arguments += @('--cgroup-root', $LinuxCgroupRoot)
    }
    if ($AllowSkips) {
        $arguments += '--allow-skips'
    }
    if ($JsonOutput) {
        $arguments += @('--json-output', $JsonOutput)
    }
    & $PythonCommand @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Supervisor v3 integration gate failed with exit code $LASTEXITCODE."
    }
} finally {
    $env:GOWORK = $previousWork
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if (([IO.Path]::GetDirectoryName($resolvedTemporary) -eq $temporaryBase.TrimEnd('\', '/')) -and
        ([IO.Path]::GetFileName($resolvedTemporary) -match '^nexus-supervisor-v3-worker5-[0-9a-f]{32}$')) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    } else {
        throw "Refusing to remove unexpected temporary path: $resolvedTemporary"
    }
}
