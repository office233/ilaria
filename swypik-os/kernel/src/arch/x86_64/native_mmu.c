#include "swypik/arch/x86_64/native_mmu.h"

#include <stdint.h>

static int swyp_x86_native_page_aligned(uint64_t value) {
    return (value & (SWYP_X86_64_PAGE_SIZE - 1u)) == 0u;
}

static int swyp_x86_native_range_contains(const SwypX86NativeMmu *mmu, uint64_t physical_address) {
    uint32_t i;
    if (mmu == NULL) {
        return 0;
    }
    for (i = 0u; i < mmu->range_count; ++i) {
        const SwypX86NativeRange *range = &mmu->ranges[i];
        if (physical_address >= range->base && physical_address - range->base < range->length) {
            return 1;
        }
    }
    return 0;
}

static void *swyp_x86_native_physical_to_virtual(void *context, uint64_t physical_address) {
    SwypX86NativeMmu *mmu = (SwypX86NativeMmu *)context;
    uint64_t virtual_address;
    if (mmu == NULL || physical_address >= mmu->physical_limit || !swyp_x86_native_range_contains(mmu, physical_address) ||
        mmu->direct_map_base > UINT64_MAX - physical_address) {
        return NULL;
    }
    virtual_address = mmu->direct_map_base + physical_address;
    return (void *)(uintptr_t)virtual_address;
}

static SwypStatus swyp_x86_native_activate_root(void *context, uint64_t pml4_physical) {
    SwypX86NativeMmu *mmu = (SwypX86NativeMmu *)context;
    if (mmu == NULL || pml4_physical >= mmu->physical_limit || !swyp_x86_native_range_contains(mmu, pml4_physical) ||
        (pml4_physical & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    __asm__ volatile("mov %0, %%cr3" : : "r"(pml4_physical) : "memory");
    return SWYP_OK;
}

static uint64_t swyp_x86_native_current_root(void *context) {
    SwypX86NativeMmu *mmu = (SwypX86NativeMmu *)context;
    uint64_t value = 0u;
    if (mmu == NULL) {
        return 0u;
    }
    __asm__ volatile("mov %%cr3, %0" : "=r"(value) : : "memory");
    return value & UINT64_C(0x000ffffffffff000);
}

static void swyp_x86_native_invalidate_page(void *context, uint64_t virtual_address) {
    SwypX86NativeMmu *mmu = (SwypX86NativeMmu *)context;
    if (mmu != NULL) {
        __asm__ volatile("invlpg (%0)" : : "r"((uintptr_t)virtual_address) : "memory");
    }
}

static const SwypX86AddressSpaceHardwareOps swyp_x86_native_ops = {
    .physical_to_virtual = swyp_x86_native_physical_to_virtual,
    .activate_root = swyp_x86_native_activate_root,
    .current_root = swyp_x86_native_current_root,
    .invalidate_page = swyp_x86_native_invalidate_page,
};

SwypStatus swyp_x86_native_mmu_init_sparse(SwypX86NativeMmu *mmu, uint64_t direct_map_base, uint64_t physical_limit) {
    uint32_t i;
    if (mmu == NULL || physical_limit == 0u || !swyp_x86_native_page_aligned(physical_limit) ||
        direct_map_base > UINT64_MAX - (physical_limit - 1u)) {
        return SWYP_ERR_INVALID;
    }
    mmu->direct_map_base = direct_map_base;
    mmu->physical_limit = physical_limit;
    mmu->range_count = 0u;
    mmu->reserved0 = 0u;
    for (i = 0u; i < SWYP_X86_NATIVE_MMU_MAX_RANGES; ++i) {
        mmu->ranges[i].base = 0u;
        mmu->ranges[i].length = 0u;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_native_mmu_add_range(SwypX86NativeMmu *mmu, uint64_t base, uint64_t length) {
    uint64_t end;
    uint32_t position = 0u;
    uint32_t i;
    if (mmu == NULL || length == 0u || !swyp_x86_native_page_aligned(base) ||
        !swyp_x86_native_page_aligned(length) || length - 1u > UINT64_MAX - base) {
        return SWYP_ERR_INVALID;
    }
    end = base + length;
    if (end > mmu->physical_limit) {
        return SWYP_ERR_DENIED;
    }
    while (position < mmu->range_count && mmu->ranges[position].base < base) {
        position += 1u;
    }
    if (position > 0u) {
        SwypX86NativeRange *previous = &mmu->ranges[position - 1u];
        uint64_t previous_end = previous->base + previous->length;
        if (base < previous_end) {
            return SWYP_ERR_DENIED;
        }
        if (base == previous_end) {
            previous->length += length;
            if (position < mmu->range_count && previous->base + previous->length == mmu->ranges[position].base) {
                previous->length += mmu->ranges[position].length;
                for (i = position; i + 1u < mmu->range_count; ++i) {
                    mmu->ranges[i] = mmu->ranges[i + 1u];
                }
                mmu->range_count -= 1u;
                mmu->ranges[mmu->range_count].base = 0u;
                mmu->ranges[mmu->range_count].length = 0u;
            }
            return SWYP_OK;
        }
    }
    if (position < mmu->range_count) {
        SwypX86NativeRange *next = &mmu->ranges[position];
        if (end > next->base) {
            return SWYP_ERR_DENIED;
        }
        if (end == next->base) {
            next->base = base;
            next->length += length;
            return SWYP_OK;
        }
    }
    if (mmu->range_count >= SWYP_X86_NATIVE_MMU_MAX_RANGES) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = mmu->range_count; i > position; --i) {
        mmu->ranges[i] = mmu->ranges[i - 1u];
    }
    mmu->ranges[position].base = base;
    mmu->ranges[position].length = length;
    mmu->range_count += 1u;
    return SWYP_OK;
}

SwypStatus swyp_x86_native_mmu_remove_range(SwypX86NativeMmu *mmu, uint64_t base, uint64_t length) {
    uint64_t end;
    uint32_t i;
    if (mmu == NULL || length == 0u || !swyp_x86_native_page_aligned(base) ||
        !swyp_x86_native_page_aligned(length) || length - 1u > UINT64_MAX - base) {
        return SWYP_ERR_INVALID;
    }
    end = base + length;
    for (i = 0u; i < mmu->range_count; ++i) {
        SwypX86NativeRange *range = &mmu->ranges[i];
        uint64_t range_end = range->base + range->length;
        if (base < range->base || end > range_end) {
            continue;
        }
        if (base == range->base && end == range_end) {
            uint32_t j;
            for (j = i; j + 1u < mmu->range_count; ++j) {
                mmu->ranges[j] = mmu->ranges[j + 1u];
            }
            mmu->range_count -= 1u;
            mmu->ranges[mmu->range_count].base = 0u;
            mmu->ranges[mmu->range_count].length = 0u;
            return SWYP_OK;
        }
        if (base == range->base) {
            range->base = end;
            range->length = range_end - end;
            return SWYP_OK;
        }
        if (end == range_end) {
            range->length = base - range->base;
            return SWYP_OK;
        }
        if (mmu->range_count >= SWYP_X86_NATIVE_MMU_MAX_RANGES) {
            return SWYP_ERR_NO_SPACE;
        }
        {
            uint32_t j;
            SwypX86NativeRange suffix = {end, range_end - end};
            for (j = mmu->range_count; j > i + 1u; --j) {
                mmu->ranges[j] = mmu->ranges[j - 1u];
            }
            range->length = base - range->base;
            mmu->ranges[i + 1u] = suffix;
            mmu->range_count += 1u;
        }
        return SWYP_OK;
    }
    return SWYP_ERR_NOT_FOUND;
}

SwypStatus swyp_x86_native_mmu_extend_limit(SwypX86NativeMmu *mmu, uint64_t physical_limit) {
    if (mmu == NULL || physical_limit < mmu->physical_limit || physical_limit == 0u ||
        !swyp_x86_native_page_aligned(physical_limit) ||
        mmu->direct_map_base > UINT64_MAX - (physical_limit - 1u)) {
        return SWYP_ERR_INVALID;
    }
    mmu->physical_limit = physical_limit;
    return SWYP_OK;
}

SwypStatus swyp_x86_native_mmu_init(SwypX86NativeMmu *mmu, uint64_t direct_map_base, uint64_t physical_limit) {
    SwypStatus status = swyp_x86_native_mmu_init_sparse(mmu, direct_map_base, physical_limit);
    if (status != SWYP_OK) {
        return status;
    }
    return swyp_x86_native_mmu_add_range(mmu, 0u, physical_limit);
}

const SwypX86AddressSpaceHardwareOps *swyp_x86_native_mmu_ops(void) {
    return &swyp_x86_native_ops;
}
