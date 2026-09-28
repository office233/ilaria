[CmdletBinding()]
param(
    [ValidateSet('Windows', 'Linux')][string]$Target = 'Windows',
    [switch]$SkipTests,
    [switch]$VerifyOnly,
    [string]$Distro = 'swypik',
    [string]$KernelVersion = ''
)
$ErrorActionPreference = 'Stop'
if ($Target -eq 'Linux') {
    & "$PSScriptRoot/build-linux.ps1" -Distro $Distro -KernelVersion $KernelVersion -VerifyOnly:$VerifyOnly
    return
}
if ($env:OS -ne 'Windows_NT') { throw 'The native EXE build must run on Windows. Use -Target Linux explicitly for the separate ISO prototype.' }
if ($VerifyOnly -and $SkipTests) { throw '-VerifyOnly cannot be combined with -SkipTests.' }
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Go is required. No Node, npm, Electron, WSL or browser SDK is needed for the Windows build.' }

function Get-PeSubsystem([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 128 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) { throw "Not a PE executable: $Path" }
    $offset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($offset -lt 0 -or $offset -gt $bytes.Length - 94 -or [BitConverter]::ToUInt32($bytes, $offset) -ne 0x4550) { throw "Invalid PE header: $Path" }
    return [BitConverter]::ToUInt16($bytes, $offset + 24 + 68)
}

$root = Split-Path -Parent $PSScriptRoot
$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
$staging = $null
Push-Location -LiteralPath $root
try {
    $hostArch = (& go env GOHOSTARCH).Trim()
    if ($LASTEXITCODE -ne 0 -or $hostArch -notin @('amd64', 'arm64')) { throw 'A supported 64-bit Go toolchain is required.' }
    $env:GOOS = 'windows'
    $env:GOARCH = $hostArch
    $env:CGO_ENABLED = '0'
    if (-not $SkipTests) {
        & go test -count=1 -timeout=5m ./...
        if ($LASTEXITCODE -ne 0) { throw 'Go tests failed; existing binaries were not replaced.' }
        & go vet ./...
        if ($LASTEXITCODE -ne 0) { throw 'Go vet failed; existing binaries were not replaced.' }
    }
    if ($VerifyOnly) { Write-Host 'Windows source verification passed.'; return }

    $version = 'dev'
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $revision = (& git rev-parse --short HEAD 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $revision -match '^[a-f0-9]+$') {
            $version = $revision
            if ((& git status --porcelain | Out-String).Trim()) { $version += '-dirty' }
        }
    }
    $bin = Join-Path $root 'bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $staging = Join-Path $bin ('.native-build-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    $gui = Join-Path $staging 'swypik-os.exe'
    $console = Join-Path $staging 'swypik-os-console.exe'
    & go build -trimpath -ldflags "-H=windowsgui -s -w -X main.desktopGUI=true -X main.buildVersion=$version" -o $gui ./cmd/swypik-os
    if ($LASTEXITCODE -ne 0) { throw 'Native GUI compilation failed.' }
    & go build -trimpath -ldflags "-s -w -X main.buildVersion=$version" -o $console ./cmd/swypik-os
    if ($LASTEXITCODE -ne 0) { throw 'Native console compilation failed.' }
    if ((Get-PeSubsystem $gui) -ne 2) { throw 'GUI artifact is not PE Windows GUI subsystem 2.' }
    if ((Get-PeSubsystem $console) -ne 3) { throw 'Diagnostic artifact is not PE Windows CUI subsystem 3.' }
    $versionOutput = (& $console -version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Native version smoke check failed.' }
    $probe = Join-Path $staging '_configuration-probe'
    $check = (& $console -check -data-dir $probe -workspace (Join-Path $probe 'workspace') | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Native configuration smoke check failed.' }
    $configuration = $check | ConvertFrom-Json
    if ($configuration.runtime -ne 'win32' -or $configuration.browser_required -or $configuration.http_listener -or (Test-Path -LiteralPath $probe)) {
        throw 'Native configuration check violated its no-browser/no-listener/no-write contract.'
    }
    $hashes = [ordered]@{}
    foreach ($file in @($gui, $console)) { $hashes[[IO.Path]::GetFileName($file)] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
    [ordered]@{
        version = $version
        built_utc = [DateTime]::UtcNow.ToString('o')
        toolchain = (& go version | Out-String).Trim()
        platform = "windows/$hostArch"
        cgo = $false
        tests_run = (-not $SkipTests.IsPresent)
        pe_gui_subsystem = 2
        pe_console_subsystem = 3
        version_check = $versionOutput
        native_configuration_check = 'passed'
        artifacts_sha256 = $hashes
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $staging 'build-manifest.json') -Encoding UTF8
    @($hashes.GetEnumerator() | ForEach-Object { "$($_.Value)  $($_.Key)" }) | Set-Content -LiteralPath (Join-Path $staging 'SHA256SUMS') -Encoding ASCII
    $archiveName = "swypik-os-windows-$hostArch.zip"
    Compress-Archive -Path @($gui, $console, (Join-Path $staging 'build-manifest.json'), (Join-Path $staging 'SHA256SUMS')) -DestinationPath (Join-Path $staging $archiveName)
    # Publish only after both binaries compile and the CLI/header checks succeed.
    foreach ($name in @('swypik-os.exe', 'swypik-os-console.exe', 'build-manifest.json', 'SHA256SUMS', $archiveName)) {
        Move-Item -LiteralPath (Join-Path $staging $name) -Destination (Join-Path $bin $name) -Force
    }
    Write-Host "Built $bin\swypik-os.exe (native Win32, no Electron or browser runtime)."
    Write-Host "Portable package: $bin\$archiveName"
    Write-Host 'Run scripts/smoke-windows.ps1 for an interactive Windows window lifecycle check.'
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
    $env:GOOS = $previousGOOS
    $env:GOARCH = $previousGOARCH
    $env:CGO_ENABLED = $previousCGO
    Pop-Location
}
