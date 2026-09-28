[CmdletBinding()]
param(
    [string]$Distro = 'swypik',
    [string]$KernelVersion = '',
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is required as a Linux build host. The product remains a native bootable OS.'
}
if (-not $VerifyOnly -and [string]::IsNullOrWhiteSpace($KernelVersion)) {
    throw 'Specify -KernelVersion using an installed Linux image and matching modules inside WSL, or use -VerifyOnly.'
}
$portableRoot = $root.Replace('\', '/')
$linuxRoot = (& wsl.exe -d $Distro --exec wslpath -u $portableRoot | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRoot.StartsWith('/')) {
    throw 'Could not resolve the project path in the selected WSL distribution.'
}
$mode = 'build'
if ($VerifyOnly) { $mode = 'verify' }
$arguments = @('-d', $Distro, '--exec', 'bash', "$linuxRoot/scripts/build-wsl.sh", '--source', $linuxRoot, '--mode', $mode)
if (-not $VerifyOnly) { $arguments += @('--kernel-version', $KernelVersion) }
& wsl.exe @arguments
if ($LASTEXITCODE -ne 0) {
    throw 'Linux validation/build failed. Inspect out/last-linux-build.txt and the retained logs. No Windows executable was produced.'
}
