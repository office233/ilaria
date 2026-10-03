#include "swypik/arch/x86_64/address_space.h"

#define SWYP_X86_PTE_PRESENT (UINT64_C(1) << 0)
#define SWYP_X86_PTE_WRITE (UINT64_C(1) << 1)
#define SWYP_X86_PTE_USER (UINT64_C(1) << 2)
#define SWYP_X86_PTE_PWT (UINT64_C(1) << 3)
#define SWYP_X86_PTE_PCD (UINT64_C(1) << 4)
#define SWYP_X86_PTE_PS (UINT64_C(1) << 7)
#define SWYP_X86_PTE_GLOBAL (UINT64_C(1) << 8)
#define SWYP_X86_PTE_NX (UINT64_C(1) << 63)
#define SWYP_X86_PTE_ADDRESS_MASK UINT64_C(0x000ffffffffff000)
#define SWYP_X86_TABLE_FLAGS (SWYP_X86_PTE_PRESENT | SWYP_X86_PTE_WRITE | SWYP_X86_PTE_USER)
#define SWYP_X86_MMU_ALLOWED                                                                                      \
    (SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_EXECUTE | SWYP_MMU_USER | SWYP_MMU_DEVICE | SWYP_MMU_GLOBAL)

static void swyp_x86_zero_page(uint64_t *page) {
    uint32_t i;
    for (i = 0; i < 512u; ++i) {
        page[i] = 0u;
    }
}

static uint16_t swyp_x86_pml4_index(uint64_t virtual_address) {
    return (uint16_t)((virtual_address >> 39) & UINT64_C(0x1ff));
}

static uint16_t swyp_x86_pdpt_index(uint64_t virtual_address) {
    return (uint16_t)((virtual_address >> 30) & UINT64_C(0x1ff));
}

static uint16_t swyp_x86_pd_index(uint64_t virtual_address) {
    return (uint16_t)((virtual_address >> 21) & UINT64_C(0x1ff));
}

static uint16_t swyp_x86_pt_index(uint64_t virtual_address) {
    return (uint16_t)((virtual_address >> 12) & UINT64_C(0x1ff));
}

int swyp_x86_64_address_space_pml4_shared(const SwypX86AddressSpace *space, uint16_t index) {
    if (space == NULL || index >= SWYP_X86_64_PML4_ENTRIES) {
        return 0;
    }
    return (space->shared_pml4_bitmap[index / 64u] & (UINT64_C(1) << (index % 64u))) != 0u;
}

static void swyp_x86_set_pml4_shared(SwypX86AddressSpace *space, uint16_t index, int shared) {
    uint64_t mask;
    if (space == NULL || index >= SWYP_X86_64_PML4_ENTRIES) {
        return;
    }
    mask = UINT64_C(1) << (index % 64u);
    if (shared) {
        space->shared_pml4_bitmap[index / 64u] |= mask;
    } else {
        space->shared_pml4_bitmap[index / 64u] &= ~mask;
    }
}

static int swyp_x86_range_touches_shared_pml4(const SwypX86AddressSpace *space, uint64_t virtual_address,
                                               uint64_t page_count) {
    uint64_t last;
    uint16_t first_index;
    uint16_t last_index;
    uint16_t index;
    if (space == NULL || page_count == 0u || page_count - 1u > (UINT64_MAX - virtual_address) / SWYP_X86_64_PAGE_SIZE) {
        return 1;
    }
    last = virtual_address + (page_count - 1u) * SWYP_X86_64_PAGE_SIZE;
    first_index = swyp_x86_pml4_index(virtual_address);
    last_index = swyp_x86_pml4_index(last);
    for (index = first_index; index <= last_index; ++index) {
        if (swyp_x86_64_address_space_pml4_shared(space, index)) {
            return 1;
        }
    }
    return 0;
}

static int swyp_x86_address_is_page_aligned(uint64_t address) {
    return (address & (SWYP_X86_64_PAGE_SIZE - 1u)) == 0u;
}

static int swyp_x86_physical_is_valid(uint64_t physical_address) {
    return swyp_x86_address_is_page_aligned(physical_address) &&
           (physical_address & ~SWYP_X86_PTE_ADDRESS_MASK) == 0u;
}

static int swyp_x86_virtual_range_valid(uint64_t virtual_address, uint64_t page_count) {
    uint64_t last;
    if (page_count == 0u || !swyp_x86_address_is_page_aligned(virtual_address) ||
        virtual_address > SWYP_X86_64_USER_CANONICAL_MAX) {
        return 0;
    }
    if (page_count - 1u > (UINT64_MAX - virtual_address) / SWYP_X86_64_PAGE_SIZE) {
        return 0;
    }
    last = virtual_address + (page_count - 1u) * SWYP_X86_64_PAGE_SIZE;
    return last <= SWYP_X86_64_USER_CANONICAL_MAX;
}

static int swyp_x86_physical_range_valid(uint64_t physical_address, uint64_t page_count) {
    uint64_t last;
    if (page_count == 0u || !swyp_x86_physical_is_valid(physical_address)) {
        return 0;
    }
    if (page_count - 1u > (UINT64_MAX - physical_address) / SWYP_X86_64_PAGE_SIZE) {
        return 0;
    }
    last = physical_address + (page_count - 1u) * SWYP_X86_64_PAGE_SIZE;
    return swyp_x86_physical_is_valid(last);
}

static int swyp_x86_flags_valid(uint64_t flags) {
    if ((flags & ~SWYP_X86_MMU_ALLOWED) != 0u || (flags & SWYP_MMU_READ) == 0u) {
        return 0;
    }
    if ((flags & SWYP_MMU_USER) != 0u && (flags & SWYP_MMU_GLOBAL) != 0u) {
        return 0;
    }
    return 1;
}

static uint64_t swyp_x86_leaf_bits(uint64_t flags) {
    uint64_t entry = SWYP_X86_PTE_PRESENT;
    if ((flags & SWYP_MMU_WRITE) != 0u) {
        entry |= SWYP_X86_PTE_WRITE;
    }
    if ((flags & SWYP_MMU_USER) != 0u) {
        entry |= SWYP_X86_PTE_USER;
    }
    if ((flags & SWYP_MMU_DEVICE) != 0u) {
        entry |= SWYP_X86_PTE_PWT | SWYP_X86_PTE_PCD;
    }
    if ((flags & SWYP_MMU_GLOBAL) != 0u) {
        entry |= SWYP_X86_PTE_GLOBAL;
    }
    if ((flags & SWYP_MMU_EXECUTE) == 0u) {
        entry |= SWYP_X86_PTE_NX;
    }
    return entry;
}

static uint64_t swyp_x86_abstract_flags(uint64_t entry) {
    uint64_t flags = SWYP_MMU_READ;
    if ((entry & SWYP_X86_PTE_WRITE) != 0u) {
        flags |= SWYP_MMU_WRITE;
    }
    if ((entry & SWYP_X86_PTE_USER) != 0u) {
        flags |= SWYP_MMU_USER;
    }
    if ((entry & (SWYP_X86_PTE_PWT | SWYP_X86_PTE_PCD)) != 0u) {
        flags |= SWYP_MMU_DEVICE;
    }
    if ((entry & SWYP_X86_PTE_GLOBAL) != 0u) {
        flags |= SWYP_MMU_GLOBAL;
    }
    if ((entry & SWYP_X86_PTE_NX) == 0u) {
        flags |= SWYP_MMU_EXECUTE;
    }
    return flags;
}

static uint64_t *swyp_x86_table_pointer(const SwypX86AddressSpace *space, uint64_t physical_address) {
    if (space == NULL || space->hardware_ops == NULL || space->hardware_ops->physical_to_virtual == NULL ||
        !swyp_x86_physical_is_valid(physical_address)) {
        return NULL;
    }
    return (uint64_t *)space->hardware_ops->physical_to_virtual(space->hardware_context, physical_address);
}

static SwypStatus swyp_x86_allocate_table(SwypX86AddressSpace *space, uint64_t *physical_address,
                                          uint64_t **table) {
    uint64_t physical = 0u;
    uint64_t *pointer;
    SwypStatus status;
    if (space == NULL || space->allocator == NULL || space->allocator->ops == NULL ||
        space->allocator->ops->allocate == NULL || space->allocator->ops->release == NULL || physical_address == NULL ||
        table == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = space->allocator->ops->allocate(space->allocator->context, 1u, 1u, &physical);
    if (status != SWYP_OK) {
        return status;
    }
    if (!swyp_x86_physical_is_valid(physical)) {
        (void)space->allocator->ops->release(space->allocator->context, physical, 1u);
        return SWYP_ERR_CORRUPT;
    }
    pointer = swyp_x86_table_pointer(space, physical);
    if (pointer == NULL) {
        (void)space->allocator->ops->release(space->allocator->context, physical, 1u);
        return SWYP_ERR_CORRUPT;
    }
    swyp_x86_zero_page(pointer);
    *physical_address = physical;
    *table = pointer;
    return SWYP_OK;
}

static int swyp_x86_table_empty(const uint64_t *table) {
    uint32_t i;
    if (table == NULL) {
        return 0;
    }
    for (i = 0; i < 512u; ++i) {
        if ((table[i] & SWYP_X86_PTE_PRESENT) != 0u) {
            return 0;
        }
    }
    return 1;
}

static SwypStatus swyp_x86_follow_existing(const SwypX86AddressSpace *space, uint64_t virtual_address,
                                           uint64_t **pml4_out, uint64_t **pdpt_out, uint64_t **pd_out,
                                           uint64_t **pt_out) {
    uint64_t *pml4;
    uint64_t *pdpt;
    uint64_t *pd;
    uint64_t *pt;
    uint64_t entry;
    pml4 = swyp_x86_table_pointer(space, space->pml4_physical);
    if (pml4 == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pml4[swyp_x86_pml4_index(virtual_address)];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if ((entry & SWYP_X86_PTE_PS) != 0u) {
        return SWYP_ERR_CORRUPT;
    }
    pdpt = swyp_x86_table_pointer(space, entry & SWYP_X86_PTE_ADDRESS_MASK);
    if (pdpt == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pdpt[swyp_x86_pdpt_index(virtual_address)];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if ((entry & SWYP_X86_PTE_PS) != 0u) {
        return SWYP_ERR_CORRUPT;
    }
    pd = swyp_x86_table_pointer(space, entry & SWYP_X86_PTE_ADDRESS_MASK);
    if (pd == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    entry = pd[swyp_x86_pd_index(virtual_address)];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if ((entry & SWYP_X86_PTE_PS) != 0u) {
        return SWYP_ERR_CORRUPT;
    }
    pt = swyp_x86_table_pointer(space, entry & SWYP_X86_PTE_ADDRESS_MASK);
    if (pt == NULL) {
        return SWYP_ERR_CORRUPT;
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

static SwypStatus swyp_x86_ensure_child(SwypX86AddressSpace *space, uint64_t *parent, uint16_t index,
                                        uint64_t **child) {
    uint64_t entry = parent[index];
    uint64_t physical;
    SwypStatus status;
    if ((entry & SWYP_X86_PTE_PRESENT) != 0u) {
        if ((entry & SWYP_X86_PTE_PS) != 0u) {
            return SWYP_ERR_CORRUPT;
        }
        *child = swyp_x86_table_pointer(space, entry & SWYP_X86_PTE_ADDRESS_MASK);
        return *child == NULL ? SWYP_ERR_CORRUPT : SWYP_OK;
    }
    status = swyp_x86_allocate_table(space, &physical, child);
    if (status != SWYP_OK) {
        return status;
    }
    parent[index] = physical | SWYP_X86_TABLE_FLAGS;
    return SWYP_OK;
}

static SwypStatus swyp_x86_ensure_leaf_table(SwypX86AddressSpace *space, uint64_t virtual_address,
                                             uint64_t **pt_out) {
    uint64_t *pml4 = swyp_x86_table_pointer(space, space->pml4_physical);
    uint64_t *pdpt;
    uint64_t *pd;
    uint64_t *pt;
    SwypStatus status;
    if (pml4 == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    status = swyp_x86_ensure_child(space, pml4, swyp_x86_pml4_index(virtual_address), &pdpt);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_ensure_child(space, pdpt, swyp_x86_pdpt_index(virtual_address), &pd);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_ensure_child(space, pd, swyp_x86_pd_index(virtual_address), &pt);
    if (status != SWYP_OK) {
        return status;
    }
    *pt_out = pt;
    return SWYP_OK;
}

static int swyp_x86_is_active(const SwypX86AddressSpace *space) {
    return space != NULL && space->hardware_ops != NULL && space->hardware_ops->current_root != NULL &&
           space->hardware_ops->current_root(space->hardware_context) == space->pml4_physical;
}

static void swyp_x86_invalidate_if_active(const SwypX86AddressSpace *space, uint64_t virtual_address) {
    if (swyp_x86_is_active(space) && space->hardware_ops->invalidate_page != NULL) {
        space->hardware_ops->invalidate_page(space->hardware_context, virtual_address);
    }
}

static void swyp_x86_prune_empty_path(SwypX86AddressSpace *space, uint64_t virtual_address) {
    uint64_t *pml4 = swyp_x86_table_pointer(space, space->pml4_physical);
    uint64_t *pdpt;
    uint64_t *pd;
    uint64_t *pt;
    uint16_t pml4_index = swyp_x86_pml4_index(virtual_address);
    uint16_t pdpt_index = swyp_x86_pdpt_index(virtual_address);
    uint16_t pd_index = swyp_x86_pd_index(virtual_address);
    uint64_t pt_physical;
    uint64_t pd_physical;
    uint64_t pdpt_physical;
    uint64_t entry;
    if (swyp_x86_64_address_space_pml4_shared(space, pml4_index)) {
        return;
    }
    if (pml4 == NULL) {
        return;
    }
    entry = pml4[pml4_index];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u || (entry & SWYP_X86_PTE_PS) != 0u) {
        return;
    }
    pdpt_physical = entry & SWYP_X86_PTE_ADDRESS_MASK;
    pdpt = swyp_x86_table_pointer(space, pdpt_physical);
    if (pdpt == NULL) {
        return;
    }
    entry = pdpt[pdpt_index];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
        if (swyp_x86_table_empty(pdpt) &&
            space->allocator->ops->release(space->allocator->context, pdpt_physical, 1u) == SWYP_OK) {
            pml4[pml4_index] = 0u;
        }
        return;
    }
    if ((entry & SWYP_X86_PTE_PS) != 0u) {
        return;
    }
    pd_physical = entry & SWYP_X86_PTE_ADDRESS_MASK;
    pd = swyp_x86_table_pointer(space, pd_physical);
    if (pd == NULL) {
        return;
    }
    entry = pd[pd_index];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
        if (swyp_x86_table_empty(pd) &&
            space->allocator->ops->release(space->allocator->context, pd_physical, 1u) == SWYP_OK) {
            pdpt[pdpt_index] = 0u;
        }
        if (swyp_x86_table_empty(pdpt) &&
            space->allocator->ops->release(space->allocator->context, pdpt_physical, 1u) == SWYP_OK) {
            pml4[pml4_index] = 0u;
        }
        return;
    }
    if ((entry & SWYP_X86_PTE_PS) != 0u) {
        return;
    }
    pt_physical = entry & SWYP_X86_PTE_ADDRESS_MASK;
    pt = swyp_x86_table_pointer(space, pt_physical);
    if (pt == NULL) {
        return;
    }
    if (!swyp_x86_table_empty(pt)) {
        return;
    }
    if (space->allocator->ops->release(space->allocator->context, pt_physical, 1u) != SWYP_OK) {
        return;
    }
    pd[pd_index] = 0u;
    if (!swyp_x86_table_empty(pd)) {
        return;
    }
    if (space->allocator->ops->release(space->allocator->context, pd_physical, 1u) != SWYP_OK) {
        return;
    }
    pdpt[pdpt_index] = 0u;
    if (!swyp_x86_table_empty(pdpt)) {
        return;
    }
    if (space->allocator->ops->release(space->allocator->context, pdpt_physical, 1u) != SWYP_OK) {
        return;
    }
    pml4[pml4_index] = 0u;
}

static void swyp_x86_rollback_map(SwypX86AddressSpace *space, uint64_t virtual_address, uint64_t pages_touched) {
    uint64_t i;
    for (i = 0; i < pages_touched; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        if (swyp_x86_follow_existing(space, va, NULL, NULL, NULL, &pt) == SWYP_OK) {
            uint16_t index = swyp_x86_pt_index(va);
            if ((pt[index] & SWYP_X86_PTE_PRESENT) != 0u) {
                pt[index] = 0u;
                swyp_x86_invalidate_if_active(space, va);
            }
            swyp_x86_prune_empty_path(space, va);
        }
    }
}

static SwypStatus swyp_x86_map(void *context, uint64_t virtual_address, uint64_t physical_address,
                               uint64_t page_count, uint64_t flags) {
    SwypX86AddressSpace *space = (SwypX86AddressSpace *)context;
    uint64_t i;
    if (space == NULL || space->failed != 0u || !swyp_x86_virtual_range_valid(virtual_address, page_count) ||
        !swyp_x86_physical_range_valid(physical_address, page_count) || !swyp_x86_flags_valid(flags) ||
        swyp_x86_range_touches_shared_pml4(space, virtual_address, page_count)) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0; i < page_count; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        SwypStatus status = swyp_x86_follow_existing(space, va, NULL, NULL, NULL, &pt);
        if (status == SWYP_OK && (pt[swyp_x86_pt_index(va)] & SWYP_X86_PTE_PRESENT) != 0u) {
            return SWYP_ERR_DENIED;
        }
        if (status != SWYP_OK && status != SWYP_ERR_NOT_FOUND) {
            return status;
        }
    }
    for (i = 0; i < page_count; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t pa = physical_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        SwypStatus status = swyp_x86_ensure_leaf_table(space, va, &pt);
        if (status != SWYP_OK) {
            swyp_x86_rollback_map(space, virtual_address, i + 1u);
            return status;
        }
        pt[swyp_x86_pt_index(va)] = pa | swyp_x86_leaf_bits(flags);
        swyp_x86_invalidate_if_active(space, va);
    }
    return SWYP_OK;
}

static SwypStatus swyp_x86_unmap(void *context, uint64_t virtual_address, uint64_t page_count) {
    SwypX86AddressSpace *space = (SwypX86AddressSpace *)context;
    uint64_t i;
    if (space == NULL || space->failed != 0u || !swyp_x86_virtual_range_valid(virtual_address, page_count) ||
        swyp_x86_range_touches_shared_pml4(space, virtual_address, page_count)) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0; i < page_count; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        if (swyp_x86_follow_existing(space, va, NULL, NULL, NULL, &pt) != SWYP_OK ||
            (pt[swyp_x86_pt_index(va)] & SWYP_X86_PTE_PRESENT) == 0u) {
            return SWYP_ERR_NOT_FOUND;
        }
    }
    for (i = 0; i < page_count; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        if (swyp_x86_follow_existing(space, va, NULL, NULL, NULL, &pt) != SWYP_OK) {
            space->failed = 1u;
            return SWYP_ERR_CORRUPT;
        }
        pt[swyp_x86_pt_index(va)] = 0u;
        swyp_x86_invalidate_if_active(space, va);
        swyp_x86_prune_empty_path(space, va);
    }
    return SWYP_OK;
}

static SwypStatus swyp_x86_protect(void *context, uint64_t virtual_address, uint64_t page_count, uint64_t flags) {
    SwypX86AddressSpace *space = (SwypX86AddressSpace *)context;
    uint64_t i;
    if (space == NULL || space->failed != 0u || !swyp_x86_virtual_range_valid(virtual_address, page_count) ||
        !swyp_x86_flags_valid(flags) || swyp_x86_range_touches_shared_pml4(space, virtual_address, page_count)) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0; i < page_count; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        if (swyp_x86_follow_existing(space, va, NULL, NULL, NULL, &pt) != SWYP_OK ||
            (pt[swyp_x86_pt_index(va)] & SWYP_X86_PTE_PRESENT) == 0u) {
            return SWYP_ERR_NOT_FOUND;
        }
    }
    for (i = 0; i < page_count; ++i) {
        uint64_t va = virtual_address + i * SWYP_X86_64_PAGE_SIZE;
        uint64_t *pt;
        uint16_t index = swyp_x86_pt_index(va);
        uint64_t physical;
        if (swyp_x86_follow_existing(space, va, NULL, NULL, NULL, &pt) != SWYP_OK) {
            space->failed = 1u;
            return SWYP_ERR_CORRUPT;
        }
        physical = pt[index] & SWYP_X86_PTE_ADDRESS_MASK;
        pt[index] = physical | swyp_x86_leaf_bits(flags);
        swyp_x86_invalidate_if_active(space, va);
    }
    return SWYP_OK;
}

static SwypStatus swyp_x86_activate(void *context) {
    SwypX86AddressSpace *space = (SwypX86AddressSpace *)context;
    if (space == NULL || space->failed != 0u || space->hardware_ops == NULL ||
        space->hardware_ops->activate_root == NULL) {
        return SWYP_ERR_INVALID;
    }
    return space->hardware_ops->activate_root(space->hardware_context, space->pml4_physical);
}

static const SwypAddressSpaceOps swyp_x86_address_space_ops = {
    .map = swyp_x86_map,
    .unmap = swyp_x86_unmap,
    .protect = swyp_x86_protect,
    .activate = swyp_x86_activate,
};

SwypStatus swyp_x86_64_address_space_init(SwypX86AddressSpace *space, SwypPageAllocator *allocator,
                                          void *hardware_context, const SwypX86AddressSpaceHardwareOps *hardware_ops,
                                          uint64_t domain_id) {
    uint64_t root_physical;
    uint64_t *root;
    SwypStatus status;
    if (space == NULL || allocator == NULL || allocator->ops == NULL || allocator->ops->allocate == NULL ||
        allocator->ops->release == NULL || hardware_ops == NULL || hardware_ops->physical_to_virtual == NULL ||
        hardware_ops->activate_root == NULL || hardware_ops->current_root == NULL ||
        hardware_ops->invalidate_page == NULL || domain_id == 0u) {
        return SWYP_ERR_INVALID;
    }
    space->contract.context = NULL;
    space->contract.ops = NULL;
    space->allocator = allocator;
    space->hardware_context = hardware_context;
    space->hardware_ops = hardware_ops;
    space->domain_id = domain_id;
    space->pml4_physical = 0u;
    space->failed = 0u;
    space->reserved0 = 0u;
    {
        uint32_t i;
        for (i = 0u; i < SWYP_X86_64_SHARED_PML4_WORDS; ++i) {
            space->shared_pml4_bitmap[i] = 0u;
        }
    }
    status = swyp_x86_allocate_table(space, &root_physical, &root);
    if (status != SWYP_OK) {
        return status;
    }
    (void)root;
    space->pml4_physical = root_physical;
    space->contract.context = space;
    space->contract.ops = &swyp_x86_address_space_ops;
    return SWYP_OK;
}

SwypAddressSpace *swyp_x86_64_address_space_contract(SwypX86AddressSpace *space) {
    if (space == NULL || space->failed != 0u || space->pml4_physical == 0u) {
        return NULL;
    }
    return &space->contract;
}

SwypStatus swyp_x86_64_address_space_inherit_supervisor_root(SwypX86AddressSpace *space,
                                                             uint64_t source_pml4_physical) {
    uint64_t *destination;
    uint64_t *source;
    uint32_t i;
    if (space == NULL || space->failed != 0u || space->pml4_physical == 0u || source_pml4_physical == 0u ||
        source_pml4_physical == space->pml4_physical || !swyp_x86_physical_is_valid(source_pml4_physical)) {
        return SWYP_ERR_INVALID;
    }
    destination = swyp_x86_table_pointer(space, space->pml4_physical);
    source = swyp_x86_table_pointer(space, source_pml4_physical);
    if (destination == NULL || source == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    for (i = 0u; i < SWYP_X86_64_PML4_ENTRIES; ++i) {
        if (destination[i] != 0u || swyp_x86_64_address_space_pml4_shared(space, (uint16_t)i)) {
            return SWYP_ERR_DENIED;
        }
    }
    for (i = 0u; i < SWYP_X86_64_PML4_ENTRIES; ++i) {
        uint64_t entry = source[i];
        if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
            continue;
        }
        if ((entry & (SWYP_X86_PTE_USER | SWYP_X86_PTE_PS)) != 0u) {
            return SWYP_ERR_DENIED;
        }
    }
    for (i = 0u; i < SWYP_X86_64_PML4_ENTRIES; ++i) {
        uint64_t entry = source[i];
        if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
            continue;
        }
        destination[i] = entry;
        swyp_x86_set_pml4_shared(space, (uint16_t)i, 1);
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_64_address_space_query(const SwypX86AddressSpace *space, uint64_t virtual_address,
                                           uint64_t *physical_address, uint64_t *flags) {
    uint64_t *pt;
    uint64_t entry;
    uint64_t page_offset;
    SwypStatus status;
    if (space == NULL || space->failed != 0u || physical_address == NULL || flags == NULL ||
        virtual_address > SWYP_X86_64_USER_CANONICAL_MAX) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_follow_existing(space, virtual_address, NULL, NULL, NULL, &pt);
    if (status != SWYP_OK) {
        return status;
    }
    entry = pt[swyp_x86_pt_index(virtual_address)];
    if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    page_offset = virtual_address & (SWYP_X86_64_PAGE_SIZE - 1u);
    *physical_address = (entry & SWYP_X86_PTE_ADDRESS_MASK) + page_offset;
    *flags = swyp_x86_abstract_flags(entry);
    return SWYP_OK;
}

static SwypStatus swyp_x86_destroy_table_level(SwypX86AddressSpace *space, uint64_t physical_address, uint32_t level) {
    uint64_t *table = swyp_x86_table_pointer(space, physical_address);
    uint32_t i;
    if (table == NULL || level == 0u || level > 4u) {
        return SWYP_ERR_CORRUPT;
    }
    if (level > 1u) {
        for (i = 0; i < 512u; ++i) {
            uint64_t entry = table[i];
            uint64_t child_physical;
            SwypStatus status;
            if ((entry & SWYP_X86_PTE_PRESENT) == 0u) {
                continue;
            }
            if (level == 4u && swyp_x86_64_address_space_pml4_shared(space, (uint16_t)i)) {
                table[i] = 0u;
                continue;
            }
            if ((entry & SWYP_X86_PTE_PS) != 0u) {
                return SWYP_ERR_CORRUPT;
            }
            child_physical = entry & SWYP_X86_PTE_ADDRESS_MASK;
            status = swyp_x86_destroy_table_level(space, child_physical, level - 1u);
            if (status != SWYP_OK) {
                return status;
            }
            table[i] = 0u;
        }
    }
    if (space->allocator->ops->release(space->allocator->context, physical_address, 1u) != SWYP_OK) {
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_64_address_space_destroy(SwypX86AddressSpace *space) {
    SwypStatus status;
    if (space == NULL || space->allocator == NULL || space->allocator->ops == NULL ||
        space->allocator->ops->release == NULL || space->pml4_physical == 0u || space->failed != 0u) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_x86_is_active(space)) {
        return SWYP_ERR_DENIED;
    }
    status = swyp_x86_destroy_table_level(space, space->pml4_physical, 4u);
    if (status != SWYP_OK) {
        space->failed = 1u;
        return status;
    }
    space->pml4_physical = 0u;
    space->contract.context = NULL;
    space->contract.ops = NULL;
    {
        uint32_t i;
        for (i = 0u; i < SWYP_X86_64_SHARED_PML4_WORDS; ++i) {
            space->shared_pml4_bitmap[i] = 0u;
        }
    }
    return SWYP_OK;
}
