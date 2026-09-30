param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root "out"
$HostOut = Join-Path $Out "host"
$ContractOut = Join-Path $Out "contracts"
$EfiOut = Join-Path $Out "efi"
$BenchOut = Join-Path $Out "bench"

New-Item -ItemType Directory -Force $HostOut, $ContractOut, $EfiOut, $BenchOut | Out-Null

function Resolve-RequiredTool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "required local tool is missing: $Name"
    }
    return $cmd.Source
}

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "native command failed ($LASTEXITCODE): $Exe $($Arguments -join ' ')"
    }
}

$Gcc = Resolve-RequiredTool "gcc"
$Objdump = Resolve-RequiredTool "objdump"
$Nasm = Resolve-RequiredTool "nasm"

$Toolchain = @(
    "gcc=$((& $Gcc --version | Select-Object -First 1))",
    "objdump=$((& $Objdump --version | Select-Object -First 1))",
    "nasm=$((& $Nasm --version | Select-Object -First 1))"
)
[IO.File]::WriteAllLines((Join-Path $Out "toolchain.txt"), $Toolchain)

$Common = @("-std=c11", "-Wall", "-Wextra", "-Werror", "-Iinclude")

Write-Host "[1/5] host architecture-neutral core tests"
$HostTest = Join-Path $HostOut "core_tests.exe"
Invoke-Native $Gcc ($Common + @(
    "src/core/contracts.c",
    "src/core/capability.c",
    "src/core/ipc.c",
    "src/core/device_graph.c",
    "tests/host_core_test.c",
    "-o", $HostTest
))
Invoke-Native $HostTest @()

Write-Host "[2/5] x86_64/arm64/riscv64 contract compile checks"
$Checks = @(
    @{ Name = "x86_64"; Define = "SWYP_CONTRACT_X86_64" },
    @{ Name = "arm64"; Define = "SWYP_CONTRACT_ARM64" },
    @{ Name = "riscv64"; Define = "SWYP_CONTRACT_RISCV64" }
)
foreach ($Check in $Checks) {
    $ObjectPath = Join-Path $ContractOut ("contract-{0}.o" -f $Check.Name)
    Invoke-Native $Gcc ($Common + @(("-D{0}=1" -f $Check.Define), "-c", "src/arch/contract_check.c", "-o", $ObjectPath))
}

Write-Host "[3/5] benchmark schema emitter skeleton"
$BenchExe = Join-Path $HostOut "benchmark_harness.exe"
Invoke-Native $Gcc @("-std=c11", "-Wall", "-Wextra", "-Werror", "bench/benchmark_harness.c", "-o", $BenchExe)
$Placeholder = & $BenchExe "swypik-seed" "host-contract-only" "0" "0" "0" "0" "placeholder"
if ($LASTEXITCODE -ne 0) {
    throw "benchmark harness failed with exit code $LASTEXITCODE"
}
[IO.File]::WriteAllText((Join-Path $BenchOut "swypik-seed-placeholder.ndjson"), ($Placeholder + [Environment]::NewLine))

Write-Host "[4/5] x86_64 UEFI PE32+ seed"
$Freestanding = $Common + @(
    "-ffreestanding",
    "-fno-stack-protector",
    "-fno-asynchronous-unwind-tables",
    "-fno-unwind-tables",
    "-fshort-wchar",
    "-mno-red-zone",
    "-maccumulate-outgoing-args",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-ident"
)
$ContractsObject = Join-Path $EfiOut "contracts.o"
$UefiObject = Join-Path $EfiOut "uefi_x86_64.o"
$EfiImage = Join-Path $EfiOut "BOOTX64.EFI"
Invoke-Native $Gcc ($Freestanding + @("-c", "src/core/contracts.c", "-o", $ContractsObject))
Invoke-Native $Gcc ($Freestanding + @("-c", "src/boot/uefi_x86_64.c", "-o", $UefiObject))
Invoke-Native $Gcc @(
    "-nostdlib",
    "-shared",
    "-Wl,--entry,efi_main",
    "-Wl,--subsystem,10",
    "-Wl,--gc-sections",
    "-Wl,--no-insert-timestamp",
    "-o", $EfiImage,
    $UefiObject,
    $ContractsObject
)

Write-Host "[5/5] PE inspection and hash"
$PeDump = (& $Objdump -x $EfiImage | Out-String)
[IO.File]::WriteAllText((Join-Path $EfiOut "objdump.txt"), $PeDump)
if ($PeDump -notmatch "pei-x86-64") {
    throw "EFI artifact is not pei-x86-64"
}
if ($PeDump -notmatch "Magic\s+020b") {
    throw "EFI artifact is not PE32+"
}
if ($PeDump -notmatch "Subsystem\s+0000000a") {
    throw "EFI artifact subsystem is not EFI application (10)"
}
if ($PeDump -match "DLL Name:") {
    throw "EFI artifact unexpectedly imports a DLL"
}
$Hash = (Get-FileHash -Algorithm SHA256 $EfiImage).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $EfiOut "SHA256SUMS.txt"), ("{0}  BOOTX64.EFI{1}" -f $Hash, [Environment]::NewLine))

$Qemu = Get-Command "qemu-system-x86_64" -ErrorAction SilentlyContinue
if ($Qemu) {
    Write-Host "QEMU is present, but this M1 build script does not boot or mutate firmware state automatically."
} else {
    Write-Host "QEMU unavailable: boot execution remains an explicit blocker; PE build/inspection completed."
}
Write-Host "EFI_SHA256=$Hash"
Write-Host "swypik-kernel build: PASS"
