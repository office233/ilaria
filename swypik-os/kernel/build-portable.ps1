param(
    [string]$Zig = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root "out\efi-portable"
$ReproDir = Join-Path $Out "repro"
New-Item -ItemType Directory -Force $Out | Out-Null
Remove-Item $ReproDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ReproDir | Out-Null

function Resolve-Zig([string]$Requested) {
    foreach ($candidate in @($Requested, $env:SWYPIK_ZIG)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction SilentlyContinue
            if (-not $resolved) { throw "Zig compiler path does not exist: $candidate" }
            return $resolved.Path
        }
    }
    $command = Get-Command zig -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $workspaceRoot = Split-Path -Parent (Split-Path -Parent $Root)
    $tools = Join-Path $workspaceRoot ".tools"
    if (Test-Path -LiteralPath $tools) {
        foreach ($directory in Get-ChildItem -LiteralPath $tools -Directory -Filter "zig-*" | Sort-Object Name -Descending) {
            $candidate = Join-Path $directory.FullName "zig.exe"
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    throw "Zig compiler not found; pass -Zig, set SWYPIK_ZIG, install zig in PATH, or place it under .tools/zig-*"
}
$Zig = Resolve-Zig $Zig

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "native command failed ($LASTEXITCODE): $Exe $($Arguments -join ' ')"
    }
}

function Read-U16([byte[]]$Bytes, [int]$Offset) {
    if ($Offset -lt 0 -or $Offset + 2 -gt $Bytes.Length) { throw "PE read16 out of range at $Offset" }
    return [BitConverter]::ToUInt16($Bytes, $Offset)
}

function Read-U32([byte[]]$Bytes, [int]$Offset) {
    if ($Offset -lt 0 -or $Offset + 4 -gt $Bytes.Length) { throw "PE read32 out of range at $Offset" }
    return [BitConverter]::ToUInt32($Bytes, $Offset)
}

function Validate-EfiPe([string]$Path) {
    [byte[]]$bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 512 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
        throw "EFI artifact is not an MZ/PE image"
    }
    $pe = [int](Read-U32 $bytes 0x3c)
    if ($pe -lt 0x40 -or $pe + 0x100 -gt $bytes.Length -or
        $bytes[$pe] -ne 0x50 -or $bytes[$pe + 1] -ne 0x45 -or
        $bytes[$pe + 2] -ne 0 -or $bytes[$pe + 3] -ne 0) {
        throw "EFI artifact has invalid PE signature"
    }
    $file = $pe + 4
    $optional = $file + 20
    $machine = Read-U16 $bytes $file
    $timestamp = Read-U32 $bytes ($file + 4)
    $magic = Read-U16 $bytes $optional
    $entryRva = Read-U32 $bytes ($optional + 16)
    $subsystem = Read-U16 $bytes ($optional + 68)
    $numberOfRvaAndSizes = Read-U32 $bytes ($optional + 108)
    $numberOfSections = Read-U16 $bytes ($file + 2)
    $optionalSize = Read-U16 $bytes ($file + 16)
    if ($machine -ne 0x8664) { throw ("EFI machine is 0x{0:x4}, expected x86_64" -f $machine) }
    if ($magic -ne 0x020b) { throw ("EFI optional-header magic is 0x{0:x4}, expected PE32+" -f $magic) }
    if ($subsystem -ne 10) { throw "EFI subsystem is $subsystem, expected EFI application (10)" }
    if ($entryRva -eq 0) { throw "EFI entry point RVA is zero" }
    if ($timestamp -ne 0) { throw "EFI COFF timestamp is nonzero; build is not deterministic" }
    if ($numberOfRvaAndSizes -lt 2) { throw "EFI PE image has no import-directory slot" }
    $importRva = Read-U32 $bytes ($optional + 120)
    $importSize = Read-U32 $bytes ($optional + 124)
    if ($importRva -ne 0 -or $importSize -ne 0) {
        throw ("EFI artifact has imports: RVA=0x{0:x8} size={1}" -f $importRva, $importSize)
    }
    $sectionTable = $optional + $optionalSize
    for ($i = 0; $i -lt $numberOfSections; $i++) {
        $sectionOffset = $sectionTable + $i * 40
        if ($sectionOffset + 40 -gt $bytes.Length) { throw "EFI section table is truncated" }
        $sectionName = [Text.Encoding]::ASCII.GetString($bytes, $sectionOffset, 8).Trim([char]0)
        if ($sectionName -eq ".buildid") {
            $rawSize = Read-U32 $bytes ($sectionOffset + 16)
            $rawPointer = Read-U32 $bytes ($sectionOffset + 20)
            if ($rawPointer + $rawSize -gt $bytes.Length) { throw "EFI .buildid section is truncated" }
            for ($j = 0; $j -lt $rawSize; $j++) {
                if ($bytes[$rawPointer + $j] -ne 0) {
                    throw "EFI .buildid payload was not normalized"
                }
            }
        }
    }
    [pscustomobject]@{
        Machine = ('0x{0:x4}' -f $machine)
        Magic = ('0x{0:x4}' -f $magic)
        Subsystem = $subsystem
        EntryRva = ('0x{0:x8}' -f $entryRva)
        Timestamp = $timestamp
        ImportRva = $importRva
        ImportSize = $importSize
        Bytes = $bytes.Length
    }
}

function Normalize-EfiPe([string]$Path) {
    [byte[]]$bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
        throw "cannot normalize non-PE artifact"
    }
    $pe = [int](Read-U32 $bytes 0x3c)
    if ($pe -lt 0x40 -or $pe + 32 -gt $bytes.Length -or
        $bytes[$pe] -ne 0x50 -or $bytes[$pe + 1] -ne 0x45) {
        throw "cannot normalize malformed PE artifact"
    }
    $timestampOffset = $pe + 8
    $bytes[$timestampOffset + 0] = 0
    $bytes[$timestampOffset + 1] = 0
    $bytes[$timestampOffset + 2] = 0
    $bytes[$timestampOffset + 3] = 0
    $file = $pe + 4
    $numberOfSections = Read-U16 $bytes ($file + 2)
    $optionalSize = Read-U16 $bytes ($file + 16)
    $optional = $file + 20
    $sectionTable = $optional + $optionalSize
    for ($i = 0; $i -lt $numberOfSections; $i++) {
        $sectionOffset = $sectionTable + $i * 40
        if ($sectionOffset + 40 -gt $bytes.Length) { throw "cannot normalize truncated PE section table" }
        $sectionName = [Text.Encoding]::ASCII.GetString($bytes, $sectionOffset, 8).Trim([char]0)
        if ($sectionName -eq ".buildid") {
            $rawSize = Read-U32 $bytes ($sectionOffset + 16)
            $rawPointer = Read-U32 $bytes ($sectionOffset + 20)
            if ($rawPointer + $rawSize -gt $bytes.Length) { throw "cannot normalize truncated .buildid section" }
            for ($j = 0; $j -lt $rawSize; $j++) {
                $bytes[$rawPointer + $j] = 0
            }
        }
    }
    [IO.File]::WriteAllBytes($Path, $bytes)
}

$Sources = @(
    "src/core/contracts.c",
    "src/core/runtime_mem.c",
    "src/boot/uefi_handoff.c",
    "src/boot/uefi_init.c",
    "src/boot/uefi_acpi.c",
    "src/boot/uefi_bootstrap.c",
    "src/boot/pe_image.c",
    "src/boot/uefi_takeover.c",
    "src/boot/uefi_memory.c",
    "src/boot/uefi_x86_64.c",
    "src/boot/uefi_switch.S",
    "src/firmware/acpi.c",
    "src/arch/x86_64/address_space.c",
    "src/arch/x86_64/apic.c",
    "src/arch/x86_64/apic_router.c",
    "src/arch/x86_64/apic_mmio.c",
    "src/arch/x86_64/continuation.S",
    "src/arch/x86_64/driver_image.c",
    "src/arch/x86_64/driver_runtime.c",
    "src/arch/x86_64/extended_state.c",
    "src/arch/x86_64/iommu.c",
    "src/arch/x86_64/irq.c",
    "src/arch/x86_64/irq_entry.S",
    "src/arch/x86_64/kernel_root.c",
    "src/arch/x86_64/native_mmu.c",
    "src/arch/x86_64/pci_ecam.c",
    "src/arch/x86_64/pci_ecam_mmio.c",
    "src/arch/x86_64/platform_boot.c",
    "src/arch/x86_64/platform_map.c",
    "src/arch/x86_64/privilege.c",
    "src/arch/x86_64/privilege_native.S",
    "src/arch/x86_64/scheduler.c",
    "src/arch/x86_64/syscall.c",
    "src/arch/x86_64/syscall_entry.S",
    "src/arch/x86_64/timer.c",
    "src/arch/x86_64/timer_entry.S",
    "src/arch/x86_64/trap.c",
    "src/arch/x86_64/trap_entry.S",
    "src/arch/x86_64/user_mode.c",
    "src/arch/x86_64/user_entry.S",
    "src/arch/x86_64/vtd.c",
    "src/arch/x86_64/vtd_router.c",
    "src/arch/x86_64/vtd_mmio.c",
    "src/core/capability.c",
    "src/core/device_broker.c",
    "src/core/device_platform.c",
    "src/core/driver_domain.c",
    "src/core/ipc.c",
    "src/core/kernel_entry.c",
    "src/core/init.c",
    "src/core/kernel_runtime.c",
    "src/core/kernel_takeover.c",
    "src/core/scheduler.c",
    "src/core/device_graph.c"
)

$EfiImage = Join-Path $Out "BOOTX64.EFI"
$ReproImage = Join-Path $ReproDir "BOOTX64.EFI"
$ArgsBase = @(
    "cc",
    "-target", "x86_64-windows-gnu",
    "-std=c11",
    "-Wall", "-Wextra", "-Werror",
    # The UEFI continuation stack is 64 KiB; any larger frame (for example a
    # big compound-literal temporary at -O0) overflows it at boot.
    "-Wframe-larger-than=16384",
    "-Wno-unused-command-line-argument",
    "-Iinclude",
    "-ffreestanding",
    "-fno-stack-protector",
    "-fno-asynchronous-unwind-tables",
    "-fno-unwind-tables",
    "-fshort-wchar",
    "-mno-red-zone",
    "-ffunction-sections",
    "-fdata-sections",
    "-fno-ident",
    "-fno-builtin",
    "-fno-sanitize=all",
    "-mno-stack-arg-probe",
    "-nostdlib",
    "-shared",
    "-Wl,--entry,efi_main",
    "-Wl,--subsystem,efi_application",
    "-Wl,--gc-sections",
    "-Wl,--build-id=none"
) + $Sources

function Build-Efi([string]$Path) {
    Push-Location $Root
    try {
        Invoke-Native $Zig ($ArgsBase + @("-o", $Path))
    } finally {
        Pop-Location
    }
}

Build-Efi $EfiImage
Normalize-EfiPe $EfiImage
$pe = Validate-EfiPe $EfiImage
$hash = (Get-FileHash -Algorithm SHA256 $EfiImage).Hash.ToLowerInvariant()

Build-Efi $ReproImage
Normalize-EfiPe $ReproImage
[void](Validate-EfiPe $ReproImage)
$reproHash = (Get-FileHash -Algorithm SHA256 $ReproImage).Hash.ToLowerInvariant()
if ($hash -ne $reproHash) {
    throw "EFI reproducibility check failed: $hash != $reproHash"
}
Remove-Item $ReproDir -Recurse -Force

[IO.File]::WriteAllText((Join-Path $Out "SHA256SUMS.txt"), ("{0}  BOOTX64.EFI{1}" -f $hash, [Environment]::NewLine))
$toolchain = & $Zig version
[IO.File]::WriteAllText((Join-Path $Out "toolchain.txt"), ("zig={0}{1}" -f $toolchain, [Environment]::NewLine))
$pe | Format-List | Out-String | Set-Content -Encoding ascii (Join-Path $Out "pe-validation.txt")

$VerifyScript = Join-Path $Root "verify-efi.ps1"
if (Test-Path -LiteralPath $VerifyScript) {
    & $VerifyScript -Path $EfiImage | Set-Content -Encoding ascii (Join-Path $Out "verify-efi.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "extended EFI verification failed"
    }
}

Write-Host "EFI_SHA256=$hash"
Write-Host "EFI_REPRODUCIBLE=PASS"
Write-Host "swypik-kernel portable EFI build: PASS"
