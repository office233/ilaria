#include "swypik/kernel/kernel_takeover.h"

static int swyp_kernel_takeover_range_valid(SwypKernelPhysicalRange range) {
    return range.length != 0u && (range.base & (SWYP_X86_64_PAGE_SIZE - 1u)) == 0u &&
           (range.length & (SWYP_X86_64_PAGE_SIZE - 1u)) == 0u && range.length - 1u <= UINT64_MAX - range.base;
}

static int swyp_kernel_takeover_direct_flags_valid(uint64_t flags) {
    return (flags & SWYP_MMU_READ) != 0u &&
           (flags & (SWYP_MMU_USER | SWYP_MMU_EXECUTE | SWYP_MMU_DEVICE)) == 0u &&
           (flags & ~(SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL)) == 0u;
}

static uint64_t swyp_kernel_takeover_physical_limit(const SwypKernelPhysicalRange *ranges, uint32_t count) {
    uint64_t limit = 0u;
    uint32_t i;
    for (i = 0u; i < count; ++i) {
        uint64_t end;
        if (!swyp_kernel_takeover_range_valid(ranges[i])) {
            return 0u;
        }
        end = ranges[i].base + ranges[i].length;
        if (end > limit) {
            limit = end;
        }
    }
    return limit;
}

static void swyp_kernel_takeover_reset(SwypKernelTakeover *takeover) {
    if (takeover == NULL) {
        return;
    }
    takeover->root.allocator = NULL;
    takeover->root.hardware_context = NULL;
    takeover->root.hardware_ops = NULL;
    takeover->root.pml4_physical = 0u;
    takeover->root.direct_map_base = 0u;
    takeover->root.physical_limit = 0u;
    takeover->root.failed = 0u;
    takeover->root.active = 0u;
    takeover->native_mmu.direct_map_base = 0u;
    takeover->native_mmu.physical_limit = 0u;
    takeover->native_mmu.range_count = 0u;
    takeover->native_mmu.reserved0 = 0u;
    takeover->prepared = 0u;
    takeover->activated = 0u;
}

SwypStatus swyp_kernel_takeover_prepare(SwypKernelTakeover *takeover, SwypPageAllocator *page_table_allocator,
                                        void *bootstrap_hardware_context,
                                        const SwypX86AddressSpaceHardwareOps *bootstrap_hardware_ops,
                                        const SwypKernelPhysicalRange *direct_ranges, uint32_t direct_range_count,
                                        const SwypKernelIdentityRange *identity_ranges, uint32_t identity_range_count) {
    uint64_t physical_limit;
    uint32_t i;
    SwypStatus status;
    if (takeover == NULL || page_table_allocator == NULL || bootstrap_hardware_ops == NULL || direct_ranges == NULL ||
        direct_range_count == 0u || direct_range_count > SWYP_KERNEL_TAKEOVER_MAX_DIRECT_RANGES ||
        identity_range_count > SWYP_KERNEL_TAKEOVER_MAX_IDENTITY_RANGES ||
        (identity_range_count != 0u && identity_ranges == NULL)) {
        return SWYP_ERR_INVALID;
    }
    swyp_kernel_takeover_reset(takeover);
    physical_limit = swyp_kernel_takeover_physical_limit(direct_ranges, direct_range_count);
    if (physical_limit == 0u || (physical_limit & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_64_kernel_root_init(&takeover->root, page_table_allocator, bootstrap_hardware_context,
                                          bootstrap_hardware_ops, SWYP_X86_64_DIRECT_MAP_BASE, physical_limit);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_native_mmu_init_sparse(&takeover->native_mmu, SWYP_X86_64_DIRECT_MAP_BASE, physical_limit);
    if (status != SWYP_OK) {
        (void)swyp_x86_64_kernel_root_destroy(&takeover->root);
        swyp_kernel_takeover_reset(takeover);
        return status;
    }
    for (i = 0u; i < direct_range_count; ++i) {
        uint64_t flags = direct_ranges[i].flags == 0u
                             ? (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL)
                             : direct_ranges[i].flags;
        if (!swyp_kernel_takeover_direct_flags_valid(flags)) {
            (void)swyp_x86_64_kernel_root_destroy(&takeover->root);
            swyp_kernel_takeover_reset(takeover);
            return SWYP_ERR_INVALID;
        }
        status = swyp_x86_native_mmu_add_range(&takeover->native_mmu, direct_ranges[i].base, direct_ranges[i].length);
        if (status == SWYP_OK) {
            status = swyp_x86_64_kernel_root_map_direct(&takeover->root, direct_ranges[i].base,
                                                        direct_ranges[i].length, flags, 1);
        }
        if (status != SWYP_OK) {
            (void)swyp_x86_64_kernel_root_destroy(&takeover->root);
            swyp_kernel_takeover_reset(takeover);
            return status;
        }
    }
    for (i = 0u; i < identity_range_count; ++i) {
        SwypKernelIdentityRange range = identity_ranges[i];
        SwypKernelPhysicalRange physical_range = {range.base, range.length, range.flags};
        if (!swyp_kernel_takeover_range_valid(physical_range)) {
            (void)swyp_x86_64_kernel_root_destroy(&takeover->root);
            swyp_kernel_takeover_reset(takeover);
            return SWYP_ERR_INVALID;
        }
        status = swyp_x86_64_kernel_root_map_identity(&takeover->root, range.base, range.length, range.flags, 1);
        if (status != SWYP_OK) {
            (void)swyp_x86_64_kernel_root_destroy(&takeover->root);
            swyp_kernel_takeover_reset(takeover);
            return status;
        }
    }
    takeover->prepared = 1u;
    return SWYP_OK;
}

SwypStatus swyp_kernel_takeover_activate(SwypKernelTakeover *takeover) {
    SwypStatus status;
    if (takeover == NULL || takeover->prepared == 0u || takeover->activated != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_64_kernel_root_activate(&takeover->root);
    if (status == SWYP_OK) {
        takeover->activated = 1u;
    }
    return status;
}

uint64_t swyp_kernel_takeover_root_physical(const SwypKernelTakeover *takeover) {
    if (takeover == NULL || takeover->prepared == 0u || takeover->root.failed != 0u) {
        return 0u;
    }
    return takeover->root.pml4_physical;
}

SwypStatus swyp_kernel_takeover_confirm_external_activation(SwypKernelTakeover *takeover) {
    uint64_t current;
    if (takeover == NULL || takeover->prepared == 0u || takeover->activated != 0u || takeover->root.failed != 0u ||
        takeover->root.hardware_ops == NULL || takeover->root.hardware_ops->current_root == NULL) {
        return SWYP_ERR_INVALID;
    }
    current = takeover->root.hardware_ops->current_root(takeover->root.hardware_context);
    if (current == 0u || current != takeover->root.pml4_physical) {
        return SWYP_ERR_DENIED;
    }
    takeover->root.active = 1u;
    takeover->activated = 1u;
    return SWYP_OK;
}

const SwypX86AddressSpaceHardwareOps *swyp_kernel_takeover_native_ops(const SwypKernelTakeover *takeover) {
    if (takeover == NULL || takeover->prepared == 0u) {
        return NULL;
    }
    return swyp_x86_native_mmu_ops();
}

SwypX86NativeMmu *swyp_kernel_takeover_native_mmu(SwypKernelTakeover *takeover) {
    if (takeover == NULL || takeover->prepared == 0u) {
        return NULL;
    }
    return &takeover->native_mmu;
}

SwypStatus swyp_kernel_takeover_destroy_unactivated(SwypKernelTakeover *takeover) {
    SwypStatus status;
    if (takeover == NULL || takeover->prepared == 0u || takeover->activated != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_64_kernel_root_destroy(&takeover->root);
    if (status == SWYP_OK) {
        swyp_kernel_takeover_reset(takeover);
    }
    return status;
}
