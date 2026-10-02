#ifndef SWYPIK_ARCH_X86_64_PLATFORM_BOOT_H
#define SWYPIK_ARCH_X86_64_PLATFORM_BOOT_H

#include "swypik/arch/x86_64/apic_mmio.h"
#include "swypik/arch/x86_64/apic_router.h"
#include "swypik/arch/x86_64/pci_ecam_mmio.h"
#include "swypik/arch/x86_64/platform_map.h"
#include "swypik/arch/x86_64/vtd.h"
#include "swypik/arch/x86_64/vtd_mmio.h"
#include "swypik/arch/x86_64/vtd_router.h"
#include "swypik/arch/x86_64/timer.h"
#include "swypik/firmware/acpi.h"
#include "swypik/kernel/kernel_runtime.h"

typedef struct SwypX86PlatformBoot {
    SwypAcpiPlatform acpi;
    SwypX86ApicMmio apic_mmio;
    SwypX86Apic apic;
    SwypX86ApicMmio apic_mmio_extra[SWYP_ACPI_MAX_IOAPICS - 1u];
    SwypX86Apic apic_extra[SWYP_ACPI_MAX_IOAPICS - 1u];
    SwypX86Apic *apic_units[SWYP_ACPI_MAX_IOAPICS];
    SwypX86ApicRouter apic_router;
    SwypX86PciEcamMmio pci_mmio;
    SwypX86PciEcam pci;
    SwypX86VtdMmio vtd_mmio;
    SwypX86Vtd vtd;
    SwypX86VtdMmio vtd_mmio_extra[SWYP_ACPI_MAX_DMAR_UNITS - 1u];
    SwypX86Vtd vtd_extra[SWYP_ACPI_MAX_DMAR_UNITS - 1u];
    SwypX86Vtd *vtd_units[SWYP_ACPI_MAX_DMAR_UNITS];
    SwypX86VtdRouter vtd_router;
    SwypX86Iommu iommu;
    SwypX86LapicTimer timer;
    SwypKernelRuntime runtime;
    uint32_t acpi_ready;
    uint32_t apic_ready;
    uint32_t apic_unit_count;
    uint32_t pci_ready;
    uint32_t iommu_ready;
    uint32_t vtd_unit_count;
    uint32_t timer_ready;
    uint32_t runtime_ready;
} SwypX86PlatformBoot;

typedef struct SwypX86PlatformBootOps {
    void *context;
    SwypStatus (*map_mmio)(void *context, SwypX86KernelRoot *kernel_root, SwypX86NativeMmu *native_mmu,
                           uint64_t physical_address, uint64_t length, volatile void **virtual_address);
    uint32_t (*current_apic_id)(void *context);
    void *vtd_register_context;
    const SwypX86VtdRegisterOps *vtd_register_ops;
    SwypStatus (*vtd_registers_for_unit)(void *context, uint32_t unit_index, volatile void *mapped,
                                         uint32_t length, void **register_context,
                                         const SwypX86VtdRegisterOps **register_ops);
    uint32_t lapic_timer_initial_count;
    uint32_t lapic_timer_divide_config;
    uint64_t tsc_deadline_ticks;
} SwypX86PlatformBootOps;

SwypStatus swyp_x86_platform_boot_init_from_acpi(SwypX86PlatformBoot *platform, const SwypAcpiPlatform *acpi,
                                                 SwypPageAllocator *page_allocator, SwypX86KernelRoot *kernel_root,
                                                 SwypX86NativeMmu *native_mmu,
                                                 void *address_hardware_context,
                                                 const SwypX86AddressSpaceHardwareOps *native_ops,
                                                 SwypX86PrivilegeState *privilege,
                                                 const SwypX86PlatformBootOps *boot_ops);

SwypStatus swyp_x86_platform_boot_init(SwypX86PlatformBoot *platform, const SwypBootInfo *boot_info,
                                       SwypPageAllocator *page_allocator, SwypX86KernelRoot *kernel_root,
                                       SwypX86NativeMmu *native_mmu,
                                       const SwypX86AddressSpaceHardwareOps *native_ops,
                                       SwypX86PrivilegeState *privilege);

#endif
