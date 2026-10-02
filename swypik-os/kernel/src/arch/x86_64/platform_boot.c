#include "swypik/arch/x86_64/platform_boot.h"

/* Zero in place. A compound-literal assignment of this ~2.4 MiB structure is
   materialized as a stack temporary at -O0, which overflows the 64 KiB boot
   continuation stack (found by booting under OVMF/QEMU). */
static void swyp_x86_platform_zero(void *pointer, size_t bytes) {
    uint8_t *out = (uint8_t *)pointer;
    size_t i;
    for (i = 0u; i < bytes; ++i) {
        out[i] = 0u;
    }
}

static void *swyp_x86_platform_acpi_physical(void *context, uint64_t physical_address) {
    SwypX86NativeMmu *mmu = (SwypX86NativeMmu *)context;
    const SwypX86AddressSpaceHardwareOps *ops = swyp_x86_native_mmu_ops();
    return ops == NULL || ops->physical_to_virtual == NULL ? NULL : ops->physical_to_virtual(mmu, physical_address);
}

static uint32_t swyp_x86_platform_current_apic_id(void *context) {
    (void)context;
#if defined(__GNUC__) && defined(__x86_64__)
    uint32_t eax = 1u;
    uint32_t ebx = 0u;
    uint32_t ecx = 0u;
    uint32_t edx = 0u;
    __asm__ volatile("cpuid" : "+a"(eax), "=b"(ebx), "=c"(ecx), "=d"(edx));
    (void)ecx;
    (void)edx;
    return (ebx >> 24) & UINT32_C(0xff);
#else
    return 0u;
#endif
}

static void swyp_x86_platform_cpuid(uint32_t leaf, uint32_t subleaf, uint32_t *eax, uint32_t *ebx,
                                    uint32_t *ecx, uint32_t *edx) {
#if defined(__GNUC__) && defined(__x86_64__)
    uint32_t a = leaf;
    uint32_t b = 0u;
    uint32_t c = subleaf;
    uint32_t d = 0u;
    __asm__ volatile("cpuid" : "+a"(a), "=b"(b), "+c"(c), "=d"(d));
    if (eax != NULL) {
        *eax = a;
    }
    if (ebx != NULL) {
        *ebx = b;
    }
    if (ecx != NULL) {
        *ecx = c;
    }
    if (edx != NULL) {
        *edx = d;
    }
#else
    (void)leaf;
    (void)subleaf;
    if (eax != NULL) {
        *eax = 0u;
    }
    if (ebx != NULL) {
        *ebx = 0u;
    }
    if (ecx != NULL) {
        *ecx = 0u;
    }
    if (edx != NULL) {
        *edx = 0u;
    }
#endif
}

static uint64_t swyp_x86_platform_native_tsc_deadline_ticks(void) {
    uint32_t max_leaf = 0u;
    uint32_t eax = 0u;
    uint32_t ebx = 0u;
    uint32_t ecx = 0u;
    uint64_t tsc_hz = 0u;
    swyp_x86_platform_cpuid(0u, 0u, &max_leaf, NULL, NULL, NULL);
    if (max_leaf < 1u) {
        return 0u;
    }
    swyp_x86_platform_cpuid(1u, 0u, &eax, &ebx, &ecx, NULL);
    if ((ecx & (UINT32_C(1) << 24)) == 0u) {
        return 0u;
    }
    if (max_leaf >= UINT32_C(0x15)) {
        uint32_t denominator = 0u;
        uint32_t numerator = 0u;
        uint32_t crystal_hz = 0u;
        swyp_x86_platform_cpuid(UINT32_C(0x15), 0u, &denominator, &numerator, &crystal_hz, NULL);
        if (denominator != 0u && numerator != 0u && crystal_hz != 0u) {
            tsc_hz = ((uint64_t)crystal_hz * numerator) / denominator;
        }
    }
    if (tsc_hz == 0u && max_leaf >= UINT32_C(0x16)) {
        uint32_t base_mhz = 0u;
        swyp_x86_platform_cpuid(UINT32_C(0x16), 0u, &base_mhz, NULL, NULL, NULL);
        if (base_mhz != 0u) {
            tsc_hz = (uint64_t)base_mhz * UINT64_C(1000000);
        }
    }
    if (tsc_hz < UINT64_C(1000)) {
        return 0u;
    }
    return tsc_hz / UINT64_C(1000); /* 1 ms scheduler tick */
}

static uint64_t swyp_x86_platform_timer_read_tsc(void *context) {
    uint32_t low = 0u;
    uint32_t high = 0u;
    (void)context;
#if defined(__GNUC__) && defined(__x86_64__)
    __asm__ volatile("rdtsc" : "=a"(low), "=d"(high));
#endif
    return ((uint64_t)high << 32) | low;
}

static SwypStatus swyp_x86_platform_timer_write_tsc_deadline(void *context, uint64_t deadline) {
    uint32_t low = (uint32_t)deadline;
    uint32_t high = (uint32_t)(deadline >> 32);
    (void)context;
#if defined(__GNUC__) && defined(__x86_64__)
    __asm__ volatile("wrmsr" : : "c"(UINT32_C(0x6e0)), "a"(low), "d"(high) : "memory");
    return SWYP_OK;
#else
    (void)low;
    (void)high;
    return SWYP_ERR_UNSUPPORTED;
#endif
}

static SwypStatus swyp_x86_platform_native_map_mmio(void *context, SwypX86KernelRoot *root, SwypX86NativeMmu *mmu,
                                                    uint64_t physical_address, uint64_t length,
                                                    volatile void **virtual_address) {
    (void)context;
    return swyp_x86_platform_map_mmio(root, mmu, physical_address, length, virtual_address);
}

static const SwypX86PlatformBootOps swyp_x86_platform_native_boot_ops = {
    .context = NULL,
    .map_mmio = swyp_x86_platform_native_map_mmio,
    .current_apic_id = swyp_x86_platform_current_apic_id,
    .vtd_register_context = NULL,
    .vtd_register_ops = NULL,
    .vtd_registers_for_unit = NULL,
    .lapic_timer_initial_count = 0u,
    .lapic_timer_divide_config = 0u,
    .tsc_deadline_ticks = 0u,
};

static SwypStatus swyp_x86_platform_timer_lapic_write(void *context, uint32_t offset, uint32_t value) {
    SwypX86Apic *apic = (SwypX86Apic *)context;
    if (apic == NULL || apic->hardware_ops == NULL || apic->hardware_ops->lapic_write == NULL) {
        return SWYP_ERR_INVALID;
    }
    return apic->hardware_ops->lapic_write(apic->hardware_context, offset, value);
}

static const SwypX86LapicTimerHardwareOps swyp_x86_platform_timer_ops = {
    .lapic_write = swyp_x86_platform_timer_lapic_write,
    .read_tsc = swyp_x86_platform_timer_read_tsc,
    .write_tsc_deadline = swyp_x86_platform_timer_write_tsc_deadline,
};

static SwypX86Apic *swyp_x86_platform_apic_unit(SwypX86PlatformBoot *platform, uint32_t index) {
    if (platform == NULL || index >= SWYP_ACPI_MAX_IOAPICS) {
        return NULL;
    }
    return index == 0u ? &platform->apic : &platform->apic_extra[index - 1u];
}

static SwypX86ApicMmio *swyp_x86_platform_apic_mmio(SwypX86PlatformBoot *platform, uint32_t index) {
    if (platform == NULL || index >= SWYP_ACPI_MAX_IOAPICS) {
        return NULL;
    }
    return index == 0u ? &platform->apic_mmio : &platform->apic_mmio_extra[index - 1u];
}

#define SWYP_X86_VTD_REGISTER_WINDOW UINT64_C(0x4000)
#define SWYP_ACPI_DMAR_DRHD_INCLUDE_PCI_ALL UINT8_C(1)

static SwypX86Vtd *swyp_x86_platform_vtd_unit(SwypX86PlatformBoot *platform, uint32_t index) {
    if (platform == NULL || index >= SWYP_ACPI_MAX_DMAR_UNITS) {
        return NULL;
    }
    return index == 0u ? &platform->vtd : &platform->vtd_extra[index - 1u];
}

static SwypX86VtdMmio *swyp_x86_platform_vtd_mmio(SwypX86PlatformBoot *platform, uint32_t index) {
    if (platform == NULL || index >= SWYP_ACPI_MAX_DMAR_UNITS) {
        return NULL;
    }
    return index == 0u ? &platform->vtd_mmio : &platform->vtd_mmio_extra[index - 1u];
}

static void swyp_x86_platform_shutdown_vtd_units(SwypX86PlatformBoot *platform, uint32_t count) {
    while (count != 0u) {
        SwypX86Vtd *unit;
        count -= 1u;
        unit = swyp_x86_platform_vtd_unit(platform, count);
        if (unit != NULL && swyp_x86_vtd_is_enabled(unit)) {
            (void)swyp_x86_vtd_shutdown(unit);
        }
        platform->vtd_units[count] = NULL;
    }
    platform->vtd_unit_count = 0u;
}

static SwypStatus swyp_x86_platform_init_vtd(SwypX86PlatformBoot *platform, SwypPageAllocator *page_allocator,
                                              SwypX86KernelRoot *kernel_root, SwypX86NativeMmu *native_mmu,
                                              void *address_hardware_context,
                                              const SwypX86AddressSpaceHardwareOps *native_ops,
                                              const SwypX86PlatformBootOps *boot_ops) {
    uint32_t i;
    if (platform->acpi.dmar_unit_count == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (platform->acpi.dmar_unit_count > SWYP_ACPI_MAX_DMAR_UNITS) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = 0u; i < platform->acpi.dmar_unit_count; ++i) {
        const SwypAcpiDmarUnit *unit = &platform->acpi.dmar_units[i];
        SwypX86Vtd *vtd = swyp_x86_platform_vtd_unit(platform, i);
        SwypX86VtdMmio *mmio = swyp_x86_platform_vtd_mmio(platform, i);
        volatile void *mapped = NULL;
        void *register_context = NULL;
        const SwypX86VtdRegisterOps *register_ops = NULL;
        SwypStatus status;
        status = boot_ops->map_mmio(boot_ops->context, kernel_root, native_mmu, unit->register_base,
                                    SWYP_X86_VTD_REGISTER_WINDOW, &mapped);
        if (status != SWYP_OK || mapped == NULL || vtd == NULL || mmio == NULL) {
            swyp_x86_platform_shutdown_vtd_units(platform, i);
            return status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
        }
        if (boot_ops->vtd_registers_for_unit != NULL) {
            status = boot_ops->vtd_registers_for_unit(boot_ops->context, i, mapped,
                                                       (uint32_t)SWYP_X86_VTD_REGISTER_WINDOW,
                                                       &register_context, &register_ops);
            if (status != SWYP_OK || register_ops == NULL) {
                swyp_x86_platform_shutdown_vtd_units(platform, i);
                return status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
            }
        } else if (boot_ops->vtd_register_ops != NULL) {
            if (platform->acpi.dmar_unit_count != 1u) {
                swyp_x86_platform_shutdown_vtd_units(platform, i);
                return SWYP_ERR_UNSUPPORTED;
            }
            register_context = boot_ops->vtd_register_context;
            register_ops = boot_ops->vtd_register_ops;
        } else {
            status = swyp_x86_vtd_mmio_init(mmio, mapped, (uint32_t)SWYP_X86_VTD_REGISTER_WINDOW);
            if (status != SWYP_OK) {
                swyp_x86_platform_shutdown_vtd_units(platform, i);
                return status;
            }
            register_context = mmio;
            register_ops = swyp_x86_vtd_mmio_ops();
        }
        status = swyp_x86_vtd_init(vtd, unit->segment, page_allocator, address_hardware_context, native_ops,
                                   register_context, register_ops);
        if (status != SWYP_OK) {
            swyp_x86_platform_shutdown_vtd_units(platform, i);
            return status;
        }
        platform->vtd_units[i] = vtd;
        platform->vtd_unit_count = i + 1u;
    }
    {
        SwypStatus status = swyp_x86_vtd_router_init(&platform->vtd_router, &platform->acpi, platform->vtd_units,
                                                     platform->vtd_unit_count);
        if (status != SWYP_OK) {
            swyp_x86_platform_shutdown_vtd_units(platform, platform->vtd_unit_count);
            return status;
        }
        if (platform->pci_ready != 0u) {
            swyp_x86_vtd_router_set_pci(&platform->vtd_router, &platform->pci);
        }
    }
    swyp_x86_iommu_init(&platform->iommu, &platform->vtd_router, swyp_x86_vtd_router_iommu_ops());
    platform->iommu_ready = 1u;
    return SWYP_OK;
}

static SwypStatus swyp_x86_platform_map_ecam(SwypX86PlatformBoot *platform, SwypX86KernelRoot *root,
                                             SwypX86NativeMmu *mmu, const SwypX86PlatformBootOps *boot_ops) {
    SwypX86PciEcamSegment segments[SWYP_X86_PCI_ECAM_SEGMENT_CAPACITY];
    uint32_t i;
    if (platform->acpi.mcfg_segment_count == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (platform->acpi.mcfg_segment_count > SWYP_X86_PCI_ECAM_SEGMENT_CAPACITY) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = 0u; i < platform->acpi.mcfg_segment_count; ++i) {
        const SwypAcpiMcfgSegment *source = &platform->acpi.mcfg_segments[i];
        uint64_t buses = (uint64_t)source->end_bus - source->start_bus + 1u;
        uint64_t length = buses << 20;
        volatile void *mapped = NULL;
        SwypStatus status = boot_ops->map_mmio(boot_ops->context, root, mmu, source->physical_base, length, &mapped);
        if (status != SWYP_OK || mapped == NULL) {
            return status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
        }
        segments[i].physical_base = source->physical_base;
        segments[i].segment = source->segment;
        segments[i].start_bus = source->start_bus;
        segments[i].end_bus = source->end_bus;
    }
    if (swyp_x86_pci_ecam_mmio_init(&platform->pci_mmio, mmu) != SWYP_OK) {
        return SWYP_ERR_CORRUPT;
    }
    return swyp_x86_pci_ecam_init(&platform->pci, &platform->pci_mmio, swyp_x86_pci_ecam_mmio_ops(), segments,
                                  platform->acpi.mcfg_segment_count);
}

SwypStatus swyp_x86_platform_boot_init_from_acpi(SwypX86PlatformBoot *platform, const SwypAcpiPlatform *acpi,
                                                 SwypPageAllocator *page_allocator, SwypX86KernelRoot *kernel_root,
                                                 SwypX86NativeMmu *native_mmu,
                                                 void *address_hardware_context,
                                                 const SwypX86AddressSpaceHardwareOps *native_ops,
                                                 SwypX86PrivilegeState *privilege,
                                                 const SwypX86PlatformBootOps *boot_ops) {
    volatile void *lapic_virtual = NULL;
    const SwypX86ApicHardwareOps *apic_ops;
    uint32_t apic_id;
    uint32_t i;
    SwypStatus status;
    if (platform == NULL || acpi == NULL || page_allocator == NULL || kernel_root == NULL || native_mmu == NULL ||
        native_ops == NULL || privilege == NULL || boot_ops == NULL || boot_ops->map_mmio == NULL ||
        boot_ops->current_apic_id == NULL || kernel_root->active == 0u) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_platform_zero(platform, sizeof(*platform));
    platform->acpi = *acpi;
    platform->acpi_ready = 1u;
    if (platform->acpi.local_apic_address == 0u || platform->acpi.ioapic_count == 0u ||
        platform->acpi.ioapic_count > SWYP_ACPI_MAX_IOAPICS) {
        return platform->acpi.ioapic_count > SWYP_ACPI_MAX_IOAPICS ? SWYP_ERR_NO_SPACE : SWYP_ERR_NOT_FOUND;
    }
    status = boot_ops->map_mmio(boot_ops->context, kernel_root, native_mmu, platform->acpi.local_apic_address,
                                SWYP_X86_64_PAGE_SIZE, &lapic_virtual);
    if (status != SWYP_OK) {
        return status;
    }
    apic_ops = swyp_x86_apic_mmio_ops();
    apic_id = boot_ops->current_apic_id(boot_ops->context);
    for (i = 0u; i < platform->acpi.ioapic_count; ++i) {
        volatile void *ioapic_virtual = NULL;
        SwypX86ApicMmio *mmio = swyp_x86_platform_apic_mmio(platform, i);
        SwypX86Apic *unit = swyp_x86_platform_apic_unit(platform, i);
        uint32_t ioapic_version = 0u;
        uint32_t redirections;
        if (mmio == NULL || unit == NULL) {
            return SWYP_ERR_CORRUPT;
        }
        status = boot_ops->map_mmio(boot_ops->context, kernel_root, native_mmu, platform->acpi.ioapics[i].address,
                                    SWYP_X86_64_PAGE_SIZE, &ioapic_virtual);
        if (status != SWYP_OK || ioapic_virtual == NULL) {
            return status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
        }
        status = swyp_x86_apic_mmio_init(mmio, lapic_virtual, ioapic_virtual);
        if (status != SWYP_OK) {
            return status;
        }
        status = apic_ops->ioapic_read(mmio, 1u, &ioapic_version);
        if (status != SWYP_OK) {
            return status;
        }
        redirections = ((ioapic_version >> 16) & UINT32_C(0xff)) + 1u;
        status = swyp_x86_apic_init(unit, mmio, apic_ops, platform->acpi.ioapics[i].gsi_base, redirections, apic_id);
        if (status != SWYP_OK) {
            return status;
        }
        platform->apic_units[i] = unit;
        platform->apic_unit_count = i + 1u;
    }
    status = swyp_x86_apic_router_init(&platform->apic_router, platform->apic_units, platform->apic_unit_count);
    if (status != SWYP_OK) {
        return status;
    }
    platform->apic_ready = 1u;
    status = swyp_x86_platform_map_ecam(platform, kernel_root, native_mmu, boot_ops);
    if (status == SWYP_OK) {
        platform->pci_ready = 1u;
    } else if (status != SWYP_ERR_NOT_FOUND) {
        return status;
    }
    status = swyp_x86_platform_init_vtd(platform, page_allocator, kernel_root, native_mmu,
                                        address_hardware_context, native_ops, boot_ops);
    if (status == SWYP_ERR_UNSUPPORTED) {
        /* DMAR hardware is present but lacks capabilities the safe VT-d path
           requires. Units were already shut down; continue without an IOMMU so
           every driver DMA request is refused rather than halting the kernel. */
        platform->iommu_status = status;
    } else if (status != SWYP_OK && status != SWYP_ERR_NOT_FOUND) {
        return status;
    }
    status = swyp_kernel_runtime_init(&platform->runtime, page_allocator, address_hardware_context, native_ops,
                                      swyp_x86_apic_router_contract(&platform->apic_router),
                                      platform->iommu_ready != 0u ? &platform->iommu : NULL,
                                      platform->pci_ready != 0u ? &platform->pci : NULL);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_kernel_runtime_bind_kernel_root(&platform->runtime, kernel_root);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_kernel_runtime_bind_syscall_idt(&platform->runtime, privilege);
    if (status != SWYP_OK) {
        return status;
    }
    if (boot_ops->tsc_deadline_ticks != 0u || boot_ops->lapic_timer_initial_count != 0u) {
        if (boot_ops->tsc_deadline_ticks != 0u) {
            status = swyp_x86_lapic_timer_init_tsc_deadline(&platform->timer, &platform->apic,
                                                            &swyp_x86_platform_timer_ops,
                                                            boot_ops->tsc_deadline_ticks, NULL, NULL);
        } else {
            status = swyp_x86_lapic_timer_init(&platform->timer, &platform->apic, &swyp_x86_platform_timer_ops,
                                               boot_ops->lapic_timer_initial_count,
                                               boot_ops->lapic_timer_divide_config, NULL, NULL);
        }
        if (status != SWYP_OK) {
            return status;
        }
        status = swyp_kernel_runtime_bind_preemption_timer(&platform->runtime, &platform->timer, privilege);
        if (status != SWYP_OK) {
            return status;
        }
        platform->timer_ready = 1u;
    }
    platform->runtime_ready = 1u;
    return SWYP_OK;
}

SwypStatus swyp_x86_platform_boot_init(SwypX86PlatformBoot *platform, const SwypBootInfo *boot_info,
                                       SwypPageAllocator *page_allocator, SwypX86KernelRoot *kernel_root,
                                       SwypX86NativeMmu *native_mmu,
                                       const SwypX86AddressSpaceHardwareOps *native_ops,
                                       SwypX86PrivilegeState *privilege) {
    SwypAcpiMemoryOps acpi_memory;
    SwypAcpiPlatform discovered;
    SwypStatus status;
    SwypX86PlatformBootOps boot_ops = swyp_x86_platform_native_boot_ops;
    if (platform == NULL || boot_info == NULL || page_allocator == NULL || kernel_root == NULL || native_mmu == NULL ||
        native_ops == NULL || privilege == NULL || boot_info->acpi_rsdp_address == 0u || kernel_root->active == 0u) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_platform_zero(platform, sizeof(*platform));
    acpi_memory.context = native_mmu;
    acpi_memory.physical_to_virtual = swyp_x86_platform_acpi_physical;
    status = swyp_acpi_discover(boot_info->acpi_rsdp_address, &acpi_memory, &discovered);
    if (status != SWYP_OK) {
        return status;
    }
    boot_ops.tsc_deadline_ticks = swyp_x86_platform_native_tsc_deadline_ticks();
    if (boot_ops.tsc_deadline_ticks == 0u) {
        /* A bounded count-based quantum is not a calibrated duration. The
           timer stays disarmed unless an admitted user task is running. */
        boot_ops.lapic_timer_initial_count = 1000000u;
        boot_ops.lapic_timer_divide_config = 3u;
    }
    status = swyp_x86_platform_boot_init_from_acpi(platform, &discovered, page_allocator, kernel_root, native_mmu,
                                                   native_mmu, native_ops, privilege, &boot_ops);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_extended_state_native_enable();
    if (status != SWYP_OK) {
        return status;
    }
    return swyp_kernel_runtime_bind_extended_state(&platform->runtime, NULL, swyp_x86_extended_state_native_ops());
}
