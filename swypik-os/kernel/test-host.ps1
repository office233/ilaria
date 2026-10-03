param(
    [string]$Compiler = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root "out\host"
New-Item -ItemType Directory -Force $Out | Out-Null

function Resolve-Compiler([string]$Requested) {
    if ($Requested) {
        $resolved = Resolve-Path -LiteralPath $Requested -ErrorAction SilentlyContinue
        if (-not $resolved) {
            throw "compiler path does not exist: $Requested"
        }
        return $resolved.Path
    }
    foreach ($name in @("gcc", "zig")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            return $cmd.Source
        }
    }
    throw "no host C compiler found; pass -Compiler <gcc-or-zig-path>"
}

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "native command failed ($LASTEXITCODE): $Exe $($Arguments -join ' ')"
    }
}

$CompilerPath = Resolve-Compiler $Compiler
$CompilerName = [IO.Path]::GetFileNameWithoutExtension($CompilerPath).ToLowerInvariant()
$Prefix = @()
if ($CompilerName -eq "zig") {
    $Prefix = @("cc")
} elseif ($CompilerName -notmatch "gcc$") {
    throw "unsupported host compiler '$CompilerName'; expected gcc or zig"
}

$Sources = @(
    "src/core/contracts.c",
    "src/boot/uefi_handoff.c",
    "src/boot/uefi_init.c",
    "src/boot/uefi_acpi.c",
    "src/boot/uefi_bootstrap.c",
    "src/boot/pe_image.c",
    "src/boot/uefi_takeover.c",
    "src/boot/uefi_memory.c",
    "src/boot/uefi_x86_64.c",
    "src/arch/x86_64/address_space.c",
    "src/arch/x86_64/apic.c",
    "src/arch/x86_64/apic_router.c",
    "src/arch/x86_64/apic_mmio.c",
    "src/arch/x86_64/driver_runtime.c",
    "src/arch/x86_64/extended_state.c",
    "src/arch/x86_64/driver_image.c",
    "src/arch/x86_64/iommu.c",
    "src/arch/x86_64/irq.c",
    "src/arch/x86_64/kernel_root.c",
    "src/arch/x86_64/native_mmu.c",
    "src/arch/x86_64/pci_ecam.c",
    "src/arch/x86_64/pci_ecam_mmio.c",
    "src/arch/x86_64/platform_boot.c",
    "src/arch/x86_64/platform_map.c",
    "src/arch/x86_64/privilege.c",
    "src/arch/x86_64/scheduler.c",
    "src/arch/x86_64/syscall.c",
    "src/arch/x86_64/timer.c",
    "src/arch/x86_64/trap.c",
    "src/arch/x86_64/user_mode.c",
    "src/arch/x86_64/vtd.c",
    "src/arch/x86_64/vtd_router.c",
    "src/arch/x86_64/vtd_mmio.c",
    "src/firmware/acpi.c",
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
    "src/core/device_graph.c",
    "tests/host_core_test.c"
    "tests/init_host_test.c"
)
$AssemblySources = @("src/boot/uefi_switch.S", "src/arch/x86_64/continuation.S", "src/arch/x86_64/irq_entry.S", "src/arch/x86_64/privilege_native.S", "src/arch/x86_64/trap_entry.S", "src/arch/x86_64/syscall_entry.S", "src/arch/x86_64/timer_entry.S", "src/arch/x86_64/user_entry.S")
$Executable = Join-Path $Out "core_tests.exe"
$Arguments = $Prefix + @("-std=c11", "-Wall", "-Wextra", "-Werror", "-Iinclude") + $Sources + $AssemblySources + @("-o", $Executable)
# Native stubs use absolute function-pointer tables. Host tests never need PIE;
# disabling it avoids text relocations on ELF without changing the UEFI ABI.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Unix) {
    $Arguments = $Prefix + @("-fno-pie", "-no-pie") + $Arguments[$Prefix.Length..($Arguments.Length - 1)]
}

Push-Location $Root
try {
    Invoke-Native $CompilerPath $Arguments
    Invoke-Native $Executable @()
} finally {
    Pop-Location
}

Write-Host "swypik-kernel host test gate: PASS ($CompilerName)"
