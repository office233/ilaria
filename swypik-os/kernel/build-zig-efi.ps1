param(
    [string]$Zig = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PortableBuild = Join-Path $Root "build-portable.ps1"
$PortableOut = Join-Path $Root "out\efi-portable"
$Out = Join-Path $Root "out\efi-zig"

if (-not (Test-Path -LiteralPath $PortableBuild)) {
    throw "canonical portable EFI build script is missing: $PortableBuild"
}

if ($Zig) {
    & $PortableBuild -Zig $Zig
} else {
    & $PortableBuild
}
if ($LASTEXITCODE -ne 0) {
    throw "canonical portable EFI build failed"
}

$SourceEfi = Join-Path $PortableOut "BOOTX64.EFI"
if (-not (Test-Path -LiteralPath $SourceEfi)) {
    throw "canonical EFI artifact is missing: $SourceEfi"
}

Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($Name in @("BOOTX64.EFI", "SHA256SUMS.txt", "toolchain.txt", "pe-validation.txt", "verify-efi.txt")) {
    $Source = Join-Path $PortableOut $Name
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination (Join-Path $Out $Name) -Force
    }
}

$Hash = (Get-FileHash -Algorithm SHA256 (Join-Path $Out "BOOTX64.EFI")).Hash.ToLowerInvariant()
Write-Output "EFI_ZIG_BUILD=PASS"
Write-Output ("EFI_SHA256={0}" -f $Hash)
