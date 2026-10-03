param(
    [string]$Compiler = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildScript = Join-Path $Root "build-zig-efi.ps1"
$VerifyScript = Join-Path $Root "verify-efi.ps1"
$Efi = Join-Path $Root "out\efi-zig\BOOTX64.EFI"

if ($Compiler) {
    & $BuildScript -Zig $Compiler
} else {
    & $BuildScript
}
if ($LASTEXITCODE -ne 0) {
    throw "Zig EFI build failed"
}
& $VerifyScript -Path $Efi
if ($LASTEXITCODE -ne 0) {
    throw "EFI verification failed"
}

$Hash = (Get-FileHash -Algorithm SHA256 $Efi).Hash.ToLowerInvariant()
Write-Host "swypik-kernel Zig EFI gate: PASS"
Write-Host "EFI_SHA256=$Hash"
