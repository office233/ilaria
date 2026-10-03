#include "swypik/arch/x86_64/kernel_root.h"

#define SWYP_X86_KR_PRESENT (UINT64_C(1) << 0)
#define SWYP_X86_KR_WRITE (UINT64_C(1) << 1)
#define SWYP_X86_KR_PWT (UINT64_C(1) << 3)
#define SWYP_X86_KR_PCD (UINT64_C(1) << 4)
#define SWYP_X86_KR_PS (UINT64_C(1) << 7)
#define SWYP_X86_KR_GLOBAL (UINT64_C(1) << 8)
#define SWYP_X86_KR_NX (UINT64_C(1) << 63)
#define SWYP_X86_KR_ADDRESS_MASK UINT64_C(0x000ffffffffff000)
#define SWYP_X86_KR_LARGE_ADDRESS_MASK UINT64_C(0x000fffffffe00000)
#define SWYP_X86_KR_TABLE_FLAGS (SWYP_X86_KR_PRESENT | SWYP_X86_KR_WRITE)
#define SWYP_X86_KR_ALLOWED (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_EXECUTE | SWYP_MMU_DEVICE | SWYP_MMU_GLOBAL)

static uint16_t swyp_x86_kr_pml4_index(uint64_t address) { return (uint16_t)((address >> 39) & UINT64_C(0x1ff)); }
static uint16_t swyp_x86_kr_pdpt_index(uint64_t address) { return (uint16_t)((address >> 30) & UINT64_C(0x1ff)); }
static uint16_t swyp_x86_kr_pd_index(uint64_t address) { return (uint16_t)((address >> 21) & UINT64_C(0x1ff)); }
static uint16_t swyp_x86_kr_pt_index(uint64_t address) { return (uint16_t)((address >> 12) & UINT64_C(0x1ff)); }

static int swyp_x86_kr_page_aligned(uint64_t value) { return (value & (SWYP_X86_64_PAGE_SIZE - 1u)) == 0u; }

static int swyp_x86_kr_canonical(uint64_t address) {
    return address <= SWYP_X86_64_USER_CANONICAL_MAX || address >= SWYP_X86_64_KERNEL_CANONICAL_MIN;
}

static int swyp_x86_kr_virtual_range_valid(uint64_t address, uint64_t length) {
    uint64_t last;
    if (length == 0u || !swyp_x86_kr_page_aligned(address) || !swyp_x86_kr_page_aligned(length) ||
        length - 1u > UINT64_MAX - address) {
        return 0;
    }
    last = address + length - 1u;
    if (!swyp_x86_kr_canonical(address) || !swyp_x86_kr_canonical(last)) {
        return 0;
    }
    return (address <= SWYP_X86_64_USER_CANONICAL_MAX && last <= SWYP_X86_64_USER_CANONICAL_MAX) ||
           (address >= SWYP_X86_64_KERNEL_CANONICAL_MIN && last >= SWYP_X86_64_KERNEL_CANONICAL_MIN);
}

static int swyp_x86_kr_physical_range_valid(uint64_t address, uint64_t length) {
    uint64_t last;
    if (length == 0u || !swyp_x86_kr_page_aligned(address) || !swyp_x86_kr_page_aligned(length) ||
        length - 1u > UINT64_MAX - address) {
        return 0;
    }
    last = address + length - 1u;
    return (address & ~SWYP_X86_KR_ADDRESS_MASK) == 0u &&
           ((last & ~(SWYP_X86_KR_ADDRESS_MASK | (SWYP_X86_64_PAGE_SIZE - 1u))) == 0u);
}

static int swyp_x86_kr_flags_valid(uint64_t flags) {
    if ((flags & ~SWYP_X86_KR_ALLOWED) != 0u || (flags & SWYP_MMU_READ) == 0u ||
        (flags & SWYP_MMU_USER) != 0u) {
        return 0;
    }
    if ((flags & SWYP_MMU_WRITE) != 0u && (flags & SWYP_MMU_EXECUTE) != 0u) {
        return 0;
    }
    return 1;
}

static uint64_t swyp_x86_kr_leaf_bits(uint64_t flags) {
    uint64_t bits = SWYP_X86_KR_PRESENT;
    if ((flags & SWYP_MMU_WRITE) != 0u) {
        bits |= SWYP_X86_KR_WRITE;
    }
    if ((flags & SWYP_MMU_DEVICE) != 0u) {
        bits |= SWYP_X86_KR_PWT | SWYP_X86_KR_PCD;
    }
    if ((flags & SWYP_MMU_GLOBAL) != 0u) {
        bits |= SWYP_X86_KR_GLOBAL;
    }
    if ((flags & SWYP_MMU_EXECUTE) == 0u) {
        bits |= SWYP_X86_KR_NX;
    }
    return bits;
}

static uint64_t swyp_x86_kr_abstract_flags(uint64_t entry) {
    uint64_t flags = SWYP_MMU_READ;
    if ((entry & SWYP_X86_KR_WRITE) != 0u) {
        flags |= SWYP_MMU_WRITE;
    }
    if ((entry & (SWYP_X86_KR_PWT | SWYP_X86_KR_PCD)) != 0u) {
        flags |= SWYP_MMU_DEVICE;
    }
    if ((entry & SWYP_X86_KR_GLOBAL) != 0u) {
        flags |= SWYP_MMU_GLOBAL;
    }
    if ((entry & SWYP_X86_KR_NX) == 0u) {
        flags |= SWYP_MMU_EXECUTE;
    }
    return flags;
}

static uint64_t *swyp_x86_kr_table(const SwypX86KernelRoot *root, uint64_t physical) {
    if (root == NULL || root->hardware_ops == NULL || root->hardware_ops->physical_to_virtual == NULL ||
        !swyp_x86_kr_page_aligned(physical) || (physical & ~SWYP_X86_KR_ADDRESS_MASK) != 0u) {
        return NULL;
    }
    return (uint64_t *)root->hardware_ops->physical_to_virtual(root->hardware_context, physical);
}

static void swyp_x86_kr_zero(uint64_t *table) {
    uint32_t i;
    for (i = 0u; i < 512u; ++i) {
        table[i] = 0u;
    }
}

static SwypStatus swyp_x86_kr_allocate_table(SwypX86KernelRoot *root, uint64_t *physical, uint64_t **table) {
    SwypStatus status;
    uint64_t address = 0u;
    uint64_t *pointer;
    if (root == NULL || physical == NULL || table == NULL || root->allocator == NULL || root->allocator->ops == NULL ||
        root->allocator->ops->allocate == NULL || root->allocator->ops->release == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = root->allocator->ops->allocate(root->allocator->context, 1u, 1u, &address);
    if (status != SWYP_OK) {
        return status;
    }
    if (!swyp_x86_kr_page_aligned(address) || (address & ~SWYP_X86_KR_ADDRESS_MASK) != 0u) {
        (void)root->allocator->ops->release(root->allocator->context, address, 1u);
        return SWYP_ERR_CORRUPT;
    }
    pointer = swyp_x86_kr_table(root, address);
    if (pointer == NULL) {
        (void)root->allocator->ops->release(root->allocator->context, address, 1u);
        return SWYP_ERR_CORRUPT;
    }
    swyp_x86_kr_zero(pointer);
    *physical = address;
    *table = pointer;
    return SWYP_OK;
}

static SwypStatus swyp_x86_kr_ensure_child(SwypX86KernelRoot *root, uint64_t *parent, uint16_t index,
                                           uint64_t **child) {
    uint64_t entry = parent[index];
    if ((entry & SWYP_X86_KR_PRESENT) != 0u) {
        if ((entry & SWYP_X86_KR_PS) != 0u) {
            return SWYP_ERR_DENIED;
        }
        *child = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
        return *child == NULL ? SWYP_ERR_CORRUPT : SWYP_OK;
    }
    {
        uint64_t physical = 0u;
        uint64_t *table = NULL;
        SwypStatus status = swyp_x86_kr_allocate_table(root, &physical, &table);
        if (status != SWYP_OK) {
            return status;
        }
        parent[index] = physical | SWYP_X86_KR_TABLE_FLAGS;
        *child = table;
    }
    return SWYP_OK;
}

static SwypStatus swyp_x86_kr_map_2m(SwypX86KernelRoot *root, uint64_t virtual_address, uint64_t physical_address,
                                     uint64_t flags) {
    uint64_t *pml4 = swyp_x86_kr_table(root, root->pml4_physical);
    uint64_t *pdpt;
    uint64_t *pd;
    uint16_t index;
    SwypStatus status;
    if (pml4 == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    status = swyp_x86_kr_ensure_child(root, pml4, swyp_x86_kr_pml4_index(virtual_address), &pdpt);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_kr_ensure_child(root, pdpt, swyp_x86_kr_pdpt_index(virtual_address), &pd);
    if (status != SWYP_OK) {
        return status;
    }
    index = swyp_x86_kr_pd_index(virtual_address);
    if ((pd[index] & SWYP_X86_KR_PRESENT) != 0u) {
        return SWYP_ERR_DENIED;
    }
    pd[index] = (physical_address & SWYP_X86_KR_LARGE_ADDRESS_MASK) | swyp_x86_kr_leaf_bits(flags) | SWYP_X86_KR_PS;
    return SWYP_OK;
}

static SwypStatus swyp_x86_kr_map_4k(SwypX86KernelRoot *root, uint64_t virtual_address, uint64_t physical_address,
                                     uint64_t flags) {
    uint64_t *pml4 = swyp_x86_kr_table(root, root->pml4_physical);
    uint64_t *pdpt;
    uint64_t *pd;
    uint64_t *pt;
    uint16_t index;
    SwypStatus status;
    if (pml4 == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    status = swyp_x86_kr_ensure_child(root, pml4, swyp_x86_kr_pml4_index(virtual_address), &pdpt);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_kr_ensure_child(root, pdpt, swyp_x86_kr_pdpt_index(virtual_address), &pd);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_kr_ensure_child(root, pd, swyp_x86_kr_pd_index(virtual_address), &pt);
    if (status != SWYP_OK) {
        return status;
    }
    index = swyp_x86_kr_pt_index(virtual_address);
    if ((pt[index] & SWYP_X86_KR_PRESENT) != 0u) {
        return SWYP_ERR_DENIED;
    }
    pt[index] = (physical_address & SWYP_X86_KR_ADDRESS_MASK) | swyp_x86_kr_leaf_bits(flags);
    return SWYP_OK;
}

static int swyp_x86_kr_table_empty(const uint64_t *table) {
    uint32_t i;
    if (table == NULL) {
        return 0;
    }
    for (i = 0u; i < 512u; ++i) {
        if ((table[i] & SWYP_X86_KR_PRESENT) != 0u) {
            return 0;
        }
    }
    return 1;
}

static SwypStatus swyp_x86_kr_lookup_leaf(const SwypX86KernelRoot *root, uint64_t virtual_address,
                                          uint64_t **pml4_out, uint64_t **pdpt_out, uint64_t **pd_out,
                                          uint64_t **pt_out, uint64_t *page_size) {
    uint64_t *pml4;
    uint64_t *pdpt;
    uint64_t *pd;
    uint64_t *pt = NULL;
    uint64_t entry;
    if (root == NULL || page_size == NULL) {
        return SWYP_ERR_INVALID;
    }
    pml4 = swyp_x86_kr_table(root, root->pml4_physical);
    if (pml4 == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pml4[swyp_x86_kr_pml4_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u || (entry & SWYP_X86_KR_PS) != 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    pdpt = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
    if (pdpt == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pdpt[swyp_x86_kr_pdpt_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u || (entry & SWYP_X86_KR_PS) != 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    pd = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
    if (pd == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pd[swyp_x86_kr_pd_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if ((entry & SWYP_X86_KR_PS) != 0u) {
        *page_size = SWYP_X86_64_LARGE_PAGE_SIZE;
    } else {
        pt = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
        if (pt == NULL || (pt[swyp_x86_kr_pt_index(virtual_address)] & SWYP_X86_KR_PRESENT) == 0u) {
            return pt == NULL ? SWYP_ERR_CORRUPT : SWYP_ERR_NOT_FOUND;
        }
        *page_size = SWYP_X86_64_PAGE_SIZE;
    }
    if (pml4_out != NULL) {
        *pml4_out = pml4;
    }
    if (pdpt_out != NULL) {
        *pdpt_out = pdpt;
    }
    if (pd_out != NULL) {
        *pd_out = pd;
    }
    if (pt_out != NULL) {
        *pt_out = pt;
    }
    return SWYP_OK;
}

static SwypStatus swyp_x86_kr_release_child(SwypX86KernelRoot *root, uint64_t *parent, uint16_t index) {
    uint64_t physical;
    if (root == NULL || parent == NULL || root->allocator == NULL || root->allocator->ops == NULL ||
        root->allocator->ops->release == NULL || (parent[index] & SWYP_X86_KR_PRESENT) == 0u ||
        (parent[index] & SWYP_X86_KR_PS) != 0u) {
        return SWYP_ERR_INVALID;
    }
    physical = parent[index] & SWYP_X86_KR_ADDRESS_MASK;
    parent[index] = 0u;
    if (root->allocator->ops->release(root->allocator->context, physical, 1u) != SWYP_OK) {
        root->failed = 1u;
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_64_kernel_root_init(SwypX86KernelRoot *root, SwypPageAllocator *allocator,
                                        void *hardware_context, const SwypX86AddressSpaceHardwareOps *hardware_ops,
                                        uint64_t direct_map_base, uint64_t physical_limit) {
    uint64_t physical = 0u;
    uint64_t *table = NULL;
    SwypStatus status;
    if (root == NULL || allocator == NULL || hardware_ops == NULL || hardware_ops->physical_to_virtual == NULL ||
        hardware_ops->activate_root == NULL || hardware_ops->current_root == NULL ||
        hardware_ops->invalidate_page == NULL || !swyp_x86_kr_page_aligned(direct_map_base) ||
        direct_map_base < SWYP_X86_64_KERNEL_CANONICAL_MIN || physical_limit == 0u ||
        physical_limit > UINT64_C(0x0000800000000000) || direct_map_base > UINT64_MAX - (physical_limit - 1u)) {
        return SWYP_ERR_INVALID;
    }
    root->allocator = allocator;
    root->hardware_context = hardware_context;
    root->hardware_ops = hardware_ops;
    root->pml4_physical = 0u;
    root->direct_map_base = direct_map_base;
    root->physical_limit = physical_limit;
    root->failed = 0u;
    root->active = 0u;
    status = swyp_x86_kr_allocate_table(root, &physical, &table);
    if (status != SWYP_OK) {
        return status;
    }
    (void)table;
    root->pml4_physical = physical;
    return SWYP_OK;
}

static SwypStatus swyp_x86_64_kernel_root_map_internal(SwypX86KernelRoot *root, uint64_t virtual_address,
                                                       uint64_t physical_address, uint64_t length, uint64_t flags,
                                                       int allow_large_pages, int require_active) {
    uint64_t remaining = length;
    uint64_t va = virtual_address;
    uint64_t pa = physical_address;
    if (root == NULL || root->pml4_physical == 0u || root->failed != 0u ||
        (require_active ? root->active == 0u : root->active != 0u) ||
        !swyp_x86_kr_virtual_range_valid(virtual_address, length) ||
        !swyp_x86_kr_physical_range_valid(physical_address, length) || !swyp_x86_kr_flags_valid(flags)) {
        return SWYP_ERR_INVALID;
    }
    while (remaining != 0u) {
        SwypStatus status;
        uint64_t step = SWYP_X86_64_PAGE_SIZE;
        if (allow_large_pages && (va & (SWYP_X86_64_LARGE_PAGE_SIZE - 1u)) == 0u &&
            (pa & (SWYP_X86_64_LARGE_PAGE_SIZE - 1u)) == 0u && remaining >= SWYP_X86_64_LARGE_PAGE_SIZE) {
            step = SWYP_X86_64_LARGE_PAGE_SIZE;
            status = swyp_x86_kr_map_2m(root, va, pa, flags);
        } else {
            status = swyp_x86_kr_map_4k(root, va, pa, flags);
        }
        if (status != SWYP_OK) {
            root->failed = 1u;
            return status;
        }
        va += step;
        pa += step;
        remaining -= step;
    }
    if (require_active && root->hardware_ops != NULL && root->hardware_ops->invalidate_page != NULL) {
        uint64_t offset;
        for (offset = 0u; offset < length; offset += SWYP_X86_64_PAGE_SIZE) {
            root->hardware_ops->invalidate_page(root->hardware_context, virtual_address + offset);
        }
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_64_kernel_root_map(SwypX86KernelRoot *root, uint64_t virtual_address,
                                       uint64_t physical_address, uint64_t length, uint64_t flags,
                                       int allow_large_pages) {
    return swyp_x86_64_kernel_root_map_internal(root, virtual_address, physical_address, length, flags,
                                                allow_large_pages, 0);
}

SwypStatus swyp_x86_64_kernel_root_map_active(SwypX86KernelRoot *root, uint64_t virtual_address,
                                              uint64_t physical_address, uint64_t length, uint64_t flags,
                                              int allow_large_pages) {
    return swyp_x86_64_kernel_root_map_internal(root, virtual_address, physical_address, length, flags,
                                                 allow_large_pages, 1);
}

SwypStatus swyp_x86_64_kernel_root_unmap_active(SwypX86KernelRoot *root, uint64_t virtual_address, uint64_t length) {
    uint64_t offset = 0u;
    if (root == NULL || root->active == 0u || root->failed != 0u ||
        !swyp_x86_kr_virtual_range_valid(virtual_address, length)) {
        return SWYP_ERR_INVALID;
    }
    while (offset < length) {
        uint64_t page_size = 0u;
        SwypStatus status = swyp_x86_kr_lookup_leaf(root, virtual_address + offset, NULL, NULL, NULL, NULL, &page_size);
        if (status != SWYP_OK) {
            return status;
        }
        if (page_size == SWYP_X86_64_LARGE_PAGE_SIZE &&
            (((virtual_address + offset) & (SWYP_X86_64_LARGE_PAGE_SIZE - 1u)) != 0u ||
             length - offset < SWYP_X86_64_LARGE_PAGE_SIZE)) {
            return SWYP_ERR_DENIED;
        }
        offset += page_size;
    }
    offset = 0u;
    while (offset < length) {
        uint64_t *pml4 = NULL;
        uint64_t *pdpt = NULL;
        uint64_t *pd = NULL;
        uint64_t *pt = NULL;
        uint64_t page_size = 0u;
        uint64_t va = virtual_address + offset;
        uint16_t pml4_index = swyp_x86_kr_pml4_index(va);
        uint16_t pdpt_index = swyp_x86_kr_pdpt_index(va);
        uint16_t pd_index = swyp_x86_kr_pd_index(va);
        SwypStatus status = swyp_x86_kr_lookup_leaf(root, va, &pml4, &pdpt, &pd, &pt, &page_size);
        if (status != SWYP_OK) {
            root->failed = 1u;
            return SWYP_ERR_CORRUPT;
        }
        if (page_size == SWYP_X86_64_LARGE_PAGE_SIZE) {
            pd[pd_index] = 0u;
        } else {
            pt[swyp_x86_kr_pt_index(va)] = 0u;
            if (swyp_x86_kr_table_empty(pt) && swyp_x86_kr_release_child(root, pd, pd_index) != SWYP_OK) {
                return SWYP_ERR_CORRUPT;
            }
        }
        if (swyp_x86_kr_table_empty(pd) && swyp_x86_kr_release_child(root, pdpt, pdpt_index) != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
        if (swyp_x86_kr_table_empty(pdpt) && swyp_x86_kr_release_child(root, pml4, pml4_index) != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
        if (root->hardware_ops != NULL && root->hardware_ops->invalidate_page != NULL) {
            uint64_t invalidate;
            for (invalidate = 0u; invalidate < page_size; invalidate += SWYP_X86_64_PAGE_SIZE) {
                root->hardware_ops->invalidate_page(root->hardware_context, va + invalidate);
            }
        }
        offset += page_size;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_64_kernel_root_map_identity(SwypX86KernelRoot *root, uint64_t physical_address, uint64_t length,
                                                uint64_t flags, int allow_large_pages) {
    return swyp_x86_64_kernel_root_map(root, physical_address, physical_address, length, flags, allow_large_pages);
}

SwypStatus swyp_x86_64_kernel_root_map_direct(SwypX86KernelRoot *root, uint64_t physical_address, uint64_t length,
                                              uint64_t flags, int allow_large_pages) {
    uint64_t virtual_address;
    if (root == NULL || physical_address >= root->physical_limit || length == 0u ||
        length - 1u > root->physical_limit - 1u - physical_address ||
        root->direct_map_base > UINT64_MAX - physical_address) {
        return SWYP_ERR_INVALID;
    }
    virtual_address = root->direct_map_base + physical_address;
    return swyp_x86_64_kernel_root_map(root, virtual_address, physical_address, length, flags, allow_large_pages);
}

SwypStatus swyp_x86_64_kernel_root_query(const SwypX86KernelRoot *root, uint64_t virtual_address,
                                         uint64_t *physical_address, uint64_t *flags, uint64_t *page_size) {
    uint64_t *pml4;
    uint64_t *pdpt;
    uint64_t *pd;
    uint64_t *pt;
    uint64_t entry;
    if (root == NULL || root->pml4_physical == 0u || physical_address == NULL || flags == NULL || page_size == NULL ||
        !swyp_x86_kr_canonical(virtual_address)) {
        return SWYP_ERR_INVALID;
    }
    pml4 = swyp_x86_kr_table(root, root->pml4_physical);
    if (pml4 == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pml4[swyp_x86_kr_pml4_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u || (entry & SWYP_X86_KR_PS) != 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    pdpt = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
    if (pdpt == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pdpt[swyp_x86_kr_pdpt_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u || (entry & SWYP_X86_KR_PS) != 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    pd = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
    if (pd == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pd[swyp_x86_kr_pd_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if ((entry & SWYP_X86_KR_PS) != 0u) {
        *physical_address = (entry & SWYP_X86_KR_LARGE_ADDRESS_MASK) +
                            (virtual_address & (SWYP_X86_64_LARGE_PAGE_SIZE - 1u));
        *flags = swyp_x86_kr_abstract_flags(entry);
        *page_size = SWYP_X86_64_LARGE_PAGE_SIZE;
        return SWYP_OK;
    }
    pt = swyp_x86_kr_table(root, entry & SWYP_X86_KR_ADDRESS_MASK);
    if (pt == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pt[swyp_x86_kr_pt_index(virtual_address)];
    if ((entry & SWYP_X86_KR_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    *physical_address = (entry & SWYP_X86_KR_ADDRESS_MASK) + (virtual_address & (SWYP_X86_64_PAGE_SIZE - 1u));
    *flags = swyp_x86_kr_abstract_flags(entry);
    *page_size = SWYP_X86_64_PAGE_SIZE;
    return SWYP_OK;
}

SwypStatus swyp_x86_64_kernel_root_activate(SwypX86KernelRoot *root) {
    SwypStatus status;
    if (root == NULL || root->pml4_physical == 0u || root->failed != 0u || root->active != 0u ||
        root->hardware_ops == NULL || root->hardware_ops->activate_root == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = root->hardware_ops->activate_root(root->hardware_context, root->pml4_physical);
    if (status == SWYP_OK) {
        root->active = 1u;
    }
    return status;
}

static SwypStatus swyp_x86_kr_destroy_level(SwypX86KernelRoot *root, uint64_t physical, uint32_t level) {
    uint64_t *table = swyp_x86_kr_table(root, physical);
    uint32_t i;
    if (table == NULL || level == 0u || level > 4u) {
        return SWYP_ERR_CORRUPT;
    }
    if (level > 1u) {
        for (i = 0u; i < 512u; ++i) {
            uint64_t entry = table[i];
            if ((entry & SWYP_X86_KR_PRESENT) == 0u) {
                continue;
            }
            if ((entry & SWYP_X86_KR_PS) != 0u) {
                if (level != 2u) {
                    return SWYP_ERR_CORRUPT;
                }
                table[i] = 0u;
                continue;
            }
            if (swyp_x86_kr_destroy_level(root, entry & SWYP_X86_KR_ADDRESS_MASK, level - 1u) != SWYP_OK) {
                return SWYP_ERR_CORRUPT;
            }
            table[i] = 0u;
        }
    }
    if (root->allocator->ops->release(root->allocator->context, physical, 1u) != SWYP_OK) {
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_64_kernel_root_destroy(SwypX86KernelRoot *root) {
    if (root == NULL || root->allocator == NULL || root->allocator->ops == NULL || root->allocator->ops->release == NULL ||
        root->pml4_physical == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (root->active != 0u) {
        if (root->hardware_ops == NULL || root->hardware_ops->current_root == NULL) {
            return SWYP_ERR_CORRUPT;
        }
        if (root->hardware_ops->current_root(root->hardware_context) == root->pml4_physical) {
            return SWYP_ERR_DENIED;
        }
    }
    if (swyp_x86_kr_destroy_level(root, root->pml4_physical, 4u) != SWYP_OK) {
        root->failed = 1u;
        return SWYP_ERR_CORRUPT;
    }
    root->pml4_physical = 0u;
    root->active = 0u;
    return SWYP_OK;
}
