[CmdletBinding()]
param(
    [ValidateRange(5, 1000)]
    [int]$Samples = 20,
    [string]$GoCommand = 'go',
    [string]$PythonCommand = 'python',
    [string]$LinuxCgroupRoot = $env:NEXUS_TEST_CGROUP_ROOT
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryBase ('nexus-supervisor-benchmark-' + [Guid]::NewGuid().ToString('N'))
$previousWork = $env:GOWORK
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $env:GOWORK = 'off'
    $hostTarget = @(& $GoCommand env GOHOSTOS GOHOSTARCH)
    if ($LASTEXITCODE -ne 0 -or $hostTarget.Count -ne 2) { throw 'Cannot determine native Go target.' }
    $env:GOOS, $env:GOARCH = $hostTarget[0].Trim(), $hostTarget[1].Trim()
    $extension = if ($env:GOOS -eq 'windows') { '.exe' } else { '' }
    foreach ($item in @(@('swyp', 'swyp'), @('swypik-os', 'plan-supervisor'), @('ilaria', 'evidence-check'))) {
        Push-Location -LiteralPath (Join-Path $root $item[0])
        try {
            & $GoCommand build -buildvcs=false -trimpath -o (Join-Path $temporary ($item[1] + $extension)) "./cmd/$($item[1])"
            if ($LASTEXITCODE -ne 0) { throw "Build failed: $($item[0])/$($item[1])" }
        } finally { Pop-Location }
    }
    $arguments = @(
        (Join-Path $PSScriptRoot 'benchmark-supervisor.py'),
        '--swyp', (Join-Path $temporary ('swyp' + $extension)),
        '--supervisor', (Join-Path $temporary ('plan-supervisor' + $extension)),
        '--verifier', (Join-Path $temporary ('evidence-check' + $extension)),
        '--samples', $Samples
    )
    if ($env:GOOS -eq 'linux') {
        if (-not $LinuxCgroupRoot) { throw 'Linux benchmark requires an explicit delegated cgroup root.' }
        $arguments += @('--cgroup-root', $LinuxCgroupRoot)
    }
    & $PythonCommand @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Supervisor v2 benchmark failed.' }
} finally {
    $env:GOWORK, $env:GOOS, $env:GOARCH = $previousWork, $previousOS, $previousArch
    $resolved = [IO.Path]::GetFullPath($temporary)
    if ([IO.Path]::GetDirectoryName($resolved) -eq $temporaryBase.TrimEnd('\', '/') -and [IO.Path]::GetFileName($resolved) -match '^nexus-supervisor-benchmark-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
