#include "swypik/arch/x86_64/platform_map.h"

SwypStatus swyp_x86_platform_map_mmio(SwypX86KernelRoot *root, SwypX86NativeMmu *mmu,
                                      uint64_t physical_address, uint64_t length, volatile void **virtual_address) {
    uint64_t base;
    uint64_t end;
    uint64_t mapped_end;
    uint64_t mapped_length;
    uint64_t virtual_base;
    SwypStatus status;
    if (root == NULL || mmu == NULL || virtual_address == NULL || length == 0u ||
        length - 1u > UINT64_MAX - physical_address) {
        return SWYP_ERR_INVALID;
    }
    *virtual_address = NULL;
    base = physical_address & ~(SWYP_X86_64_PAGE_SIZE - 1u);
    end = physical_address + length;
    if (end > UINT64_MAX - (SWYP_X86_64_PAGE_SIZE - 1u)) {
        return SWYP_ERR_INVALID;
    }
    mapped_end = (end + SWYP_X86_64_PAGE_SIZE - 1u) & ~(SWYP_X86_64_PAGE_SIZE - 1u);
    mapped_length = mapped_end - base;
    if (root->direct_map_base > UINT64_MAX - base || mapped_end == 0u) {
        return SWYP_ERR_INVALID;
    }
    virtual_base = root->direct_map_base + base;
    status = swyp_x86_64_kernel_root_map_active(root, virtual_base, base, mapped_length,
                                                SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_DEVICE | SWYP_MMU_GLOBAL,
                                                1);
    if (status != SWYP_OK) {
        return status;
    }
    if (mapped_end > mmu->physical_limit) {
        status = swyp_x86_native_mmu_extend_limit(mmu, mapped_end);
        if (status != SWYP_OK) {
            return status;
        }
        root->physical_limit = mapped_end;
    }
    status = swyp_x86_native_mmu_add_range(mmu, base, mapped_length);
    if (status != SWYP_OK) {
        if (swyp_x86_64_kernel_root_unmap_active(root, virtual_base, mapped_length) != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
        return status;
    }
    *virtual_address = (volatile void *)(uintptr_t)(virtual_base + (physical_address - base));
    return SWYP_OK;
}
