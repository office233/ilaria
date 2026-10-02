#include "swypik/boot/uefi_bootstrap.h"

#include <stdint.h>

#define SWYP_UEFI_BOOTSTRAP_PAGE_SIZE UINT64_C(4096)

static int swyp_uefi_bootstrap_alignment_valid(uint64_t alignment_pages) {
    return alignment_pages != 0u && (alignment_pages & (alignment_pages - 1u)) == 0u;
}

static int swyp_uefi_bootstrap_page_used(const SwypUefiBootstrapArena *arena, uint32_t page) {
    return (arena->table_bitmap[page / 64u] & (UINT64_C(1) << (page % 64u))) != 0u;
}

static void swyp_uefi_bootstrap_set_page(SwypUefiBootstrapArena *arena, uint32_t page, int used) {
    uint64_t mask = UINT64_C(1) << (page % 64u);
    if (used) {
        arena->table_bitmap[page / 64u] |= mask;
    } else {
        arena->table_bitmap[page / 64u] &= ~mask;
    }
}

static SwypStatus swyp_uefi_bootstrap_allocate(void *context, uint64_t page_count, uint64_t alignment_pages,
                                               uint64_t *physical_address) {
    SwypUefiBootstrapArena *arena = (SwypUefiBootstrapArena *)context;
    uint32_t count;
    uint32_t alignment;
    uint32_t start;
    if (arena == NULL || physical_address == NULL || page_count == 0u ||
        page_count > arena->table_pages || !swyp_uefi_bootstrap_alignment_valid(alignment_pages) ||
        alignment_pages > arena->table_pages || page_count > UINT32_MAX || alignment_pages > UINT32_MAX) {
        return SWYP_ERR_INVALID;
    }
    count = (uint32_t)page_count;
    alignment = (uint32_t)alignment_pages;
    for (start = 0u; start + count <= arena->table_pages; ++start) {
        uint32_t page;
        int free = 1;
        if ((start & (alignment - 1u)) != 0u) {
            continue;
        }
        for (page = start; page < start + count; ++page) {
            if (swyp_uefi_bootstrap_page_used(arena, page)) {
                free = 0;
                break;
            }
        }
        if (!free) {
            continue;
        }
        for (page = start; page < start + count; ++page) {
            swyp_uefi_bootstrap_set_page(arena, page, 1);
        }
        *physical_address = arena->physical_base + (uint64_t)start * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
        return SWYP_OK;
    }
    return SWYP_ERR_NO_SPACE;
}

static SwypStatus swyp_uefi_bootstrap_release(void *context, uint64_t physical_address, uint64_t page_count) {
    SwypUefiBootstrapArena *arena = (SwypUefiBootstrapArena *)context;
    uint64_t offset;
    uint64_t start64;
    uint32_t start;
    uint32_t count;
    uint32_t page;
    if (arena == NULL || page_count == 0u || page_count > UINT32_MAX || physical_address < arena->physical_base ||
        (physical_address & (SWYP_UEFI_BOOTSTRAP_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    offset = physical_address - arena->physical_base;
    start64 = offset / SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
    if (start64 > UINT32_MAX || start64 + page_count > arena->table_pages) {
        return SWYP_ERR_INVALID;
    }
    start = (uint32_t)start64;
    count = (uint32_t)page_count;
    for (page = start; page < start + count; ++page) {
        if (!swyp_uefi_bootstrap_page_used(arena, page)) {
            return SWYP_ERR_INVALID;
        }
    }
    for (page = start; page < start + count; ++page) {
        swyp_uefi_bootstrap_set_page(arena, page, 0);
    }
    return SWYP_OK;
}

static const SwypPageAllocatorOps swyp_uefi_bootstrap_allocator_ops = {
    .allocate = swyp_uefi_bootstrap_allocate,
    .release = swyp_uefi_bootstrap_release,
};

static void *swyp_uefi_bootstrap_physical_to_virtual(void *context, uint64_t physical_address) {
    SwypUefiBootstrapArena *arena = (SwypUefiBootstrapArena *)context;
    uint64_t bytes;
    if (arena == NULL) {
        return NULL;
    }
    bytes = swyp_uefi_bootstrap_arena_bytes(arena);
    if (physical_address < arena->physical_base || physical_address - arena->physical_base >= bytes) {
        return NULL;
    }
    return (void *)(uintptr_t)physical_address;
}

static SwypStatus swyp_uefi_bootstrap_activate_root(void *context, uint64_t pml4_physical) {
    SwypUefiBootstrapArena *arena = (SwypUefiBootstrapArena *)context;
    if (swyp_uefi_bootstrap_physical_to_virtual(arena, pml4_physical) == NULL ||
        (pml4_physical & (SWYP_UEFI_BOOTSTRAP_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    __asm__ volatile("mov %0, %%cr3" : : "r"(pml4_physical) : "memory");
    return SWYP_OK;
}

static uint64_t swyp_uefi_bootstrap_current_root(void *context) {
    uint64_t value = 0u;
    if (context == NULL) {
        return 0u;
    }
    __asm__ volatile("mov %%cr3, %0" : "=r"(value) : : "memory");
    return value & UINT64_C(0x000ffffffffff000);
}

static void swyp_uefi_bootstrap_invalidate_page(void *context, uint64_t virtual_address) {
    if (context != NULL) {
        __asm__ volatile("invlpg (%0)" : : "r"((uintptr_t)virtual_address) : "memory");
    }
}

static const SwypX86AddressSpaceHardwareOps swyp_uefi_bootstrap_mmu_ops_value = {
    .physical_to_virtual = swyp_uefi_bootstrap_physical_to_virtual,
    .activate_root = swyp_uefi_bootstrap_activate_root,
    .current_root = swyp_uefi_bootstrap_current_root,
    .invalidate_page = swyp_uefi_bootstrap_invalidate_page,
};

static void swyp_uefi_bootstrap_zero(SwypUefiBootstrapArena *arena) {
    uint32_t i;
    arena->contract.context = NULL;
    arena->contract.ops = NULL;
    arena->physical_base = 0u;
    arena->table_pages = 0u;
    arena->guard_pages = 0u;
    arena->ist_pages = 0u;
    arena->ist_guard_pages = 0u;
    arena->stack_pages = 0u;
    arena->firmware_allocated = 0u;
    arena->reserved0 = 0u;
    for (i = 0u; i < SWYP_UEFI_BOOTSTRAP_BITMAP_WORDS; ++i) {
        arena->table_bitmap[i] = 0u;
    }
}

SwypStatus swyp_uefi_bootstrap_arena_init(EFI_SYSTEM_TABLE *system_table, SwypUefiBootstrapArena *arena,
                                          uint32_t table_pages, uint32_t stack_pages) {
    EFI_PHYSICAL_ADDRESS address = 0u;
    uint64_t total_pages;
    uint64_t total_bytes;
    uint64_t i;
    uint8_t *bytes;
    EFI_STATUS status;
    if (system_table == NULL || system_table->BootServices == NULL || system_table->BootServices->AllocatePages == NULL ||
        system_table->BootServices->FreePages == NULL || arena == NULL || table_pages == 0u ||
        table_pages > SWYP_UEFI_BOOTSTRAP_MAX_TABLE_PAGES || stack_pages == 0u) {
        return SWYP_ERR_INVALID;
    }
    swyp_uefi_bootstrap_zero(arena);
    total_pages = (uint64_t)table_pages + SWYP_UEFI_BOOTSTRAP_GUARD_PAGES + SWYP_UEFI_BOOTSTRAP_IST_PAGES +
                  SWYP_UEFI_BOOTSTRAP_IST_GUARD_PAGES + stack_pages;
    if (total_pages > UINT64_MAX / SWYP_UEFI_BOOTSTRAP_PAGE_SIZE) {
        return SWYP_ERR_INVALID;
    }
    total_bytes = total_pages * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
    status = system_table->BootServices->AllocatePages(AllocateAnyPages, EfiLoaderData, (EFI_UINTN)total_pages, &address);
    if (status != EFI_SUCCESS || address == 0u || (address & (SWYP_UEFI_BOOTSTRAP_PAGE_SIZE - 1u)) != 0u ||
        address > UINT64_MAX - total_bytes) {
        if (status == EFI_SUCCESS && address != 0u) {
            (void)system_table->BootServices->FreePages(address, (EFI_UINTN)total_pages);
        }
        return status == EFI_SUCCESS ? SWYP_ERR_CORRUPT : SWYP_ERR_NO_SPACE;
    }
    arena->physical_base = address;
    arena->table_pages = table_pages;
    arena->guard_pages = SWYP_UEFI_BOOTSTRAP_GUARD_PAGES;
    arena->ist_pages = SWYP_UEFI_BOOTSTRAP_IST_PAGES;
    arena->ist_guard_pages = SWYP_UEFI_BOOTSTRAP_IST_GUARD_PAGES;
    arena->stack_pages = stack_pages;
    arena->firmware_allocated = 1u;
    arena->contract.context = arena;
    arena->contract.ops = &swyp_uefi_bootstrap_allocator_ops;
    bytes = (uint8_t *)(uintptr_t)address;
    for (i = 0u; i < total_bytes; ++i) {
        bytes[i] = 0u;
    }
    return SWYP_OK;
}

SwypStatus swyp_uefi_bootstrap_arena_release(EFI_SYSTEM_TABLE *system_table, SwypUefiBootstrapArena *arena) {
    EFI_STATUS status;
    uint64_t total_pages;
    if (system_table == NULL || system_table->BootServices == NULL || system_table->BootServices->FreePages == NULL ||
        arena == NULL || arena->firmware_allocated == 0u) {
        return SWYP_ERR_INVALID;
    }
    total_pages = (uint64_t)arena->table_pages + arena->guard_pages + arena->ist_pages + arena->ist_guard_pages +
                  arena->stack_pages;
    status = system_table->BootServices->FreePages(arena->physical_base, (EFI_UINTN)total_pages);
    if (status != EFI_SUCCESS) {
        return SWYP_ERR_CORRUPT;
    }
    swyp_uefi_bootstrap_zero(arena);
    return SWYP_OK;
}

SwypPageAllocator *swyp_uefi_bootstrap_page_allocator(SwypUefiBootstrapArena *arena) {
    if (arena == NULL || arena->contract.ops == NULL || arena->firmware_allocated == 0u) {
        return NULL;
    }
    return &arena->contract;
}

uint64_t swyp_uefi_bootstrap_arena_bytes(const SwypUefiBootstrapArena *arena) {
    if (arena == NULL) {
        return 0u;
    }
    return ((uint64_t)arena->table_pages + arena->guard_pages + arena->ist_pages + arena->ist_guard_pages +
            arena->stack_pages) * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
}

uint64_t swyp_uefi_bootstrap_table_bytes(const SwypUefiBootstrapArena *arena) {
    if (arena == NULL) {
        return 0u;
    }
    return (uint64_t)arena->table_pages * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
}

uint64_t swyp_uefi_bootstrap_guard_base(const SwypUefiBootstrapArena *arena) {
    if (arena == NULL || arena->firmware_allocated == 0u || arena->guard_pages == 0u) {
        return 0u;
    }
    return arena->physical_base + swyp_uefi_bootstrap_table_bytes(arena);
}

uint64_t swyp_uefi_bootstrap_ist_base(const SwypUefiBootstrapArena *arena) {
    if (arena == NULL || arena->firmware_allocated == 0u || arena->ist_pages == 0u) {
        return 0u;
    }
    return arena->physical_base + ((uint64_t)arena->table_pages + arena->guard_pages) * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
}

uint64_t swyp_uefi_bootstrap_ist_top(const SwypUefiBootstrapArena *arena) {
    uint64_t base = swyp_uefi_bootstrap_ist_base(arena);
    if (base == 0u) {
        return 0u;
    }
    return base + (uint64_t)arena->ist_pages * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
}

uint64_t swyp_uefi_bootstrap_ist_guard_base(const SwypUefiBootstrapArena *arena) {
    if (arena == NULL || arena->firmware_allocated == 0u || arena->ist_guard_pages == 0u) {
        return 0u;
    }
    return swyp_uefi_bootstrap_ist_top(arena);
}

uint64_t swyp_uefi_bootstrap_stack_base(const SwypUefiBootstrapArena *arena) {
    if (arena == NULL || arena->firmware_allocated == 0u) {
        return 0u;
    }
    return arena->physical_base +
           ((uint64_t)arena->table_pages + arena->guard_pages + arena->ist_pages + arena->ist_guard_pages) *
               SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
}

uint64_t swyp_uefi_bootstrap_stack_top(const SwypUefiBootstrapArena *arena) {
    uint64_t base = swyp_uefi_bootstrap_stack_base(arena);
    if (base == 0u) {
        return 0u;
    }
    return base + (uint64_t)arena->stack_pages * SWYP_UEFI_BOOTSTRAP_PAGE_SIZE;
}

const SwypX86AddressSpaceHardwareOps *swyp_uefi_bootstrap_mmu_ops(void) {
    return &swyp_uefi_bootstrap_mmu_ops_value;
}
