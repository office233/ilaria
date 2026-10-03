#ifndef SWYPIK_BOOT_UEFI_BOOTSTRAP_H
#define SWYPIK_BOOT_UEFI_BOOTSTRAP_H

#include "swypik/arch/x86_64/address_space.h"
#include "swypik/uefi/uefi.h"

#define SWYP_UEFI_BOOTSTRAP_MAX_TABLE_PAGES 512u
#define SWYP_UEFI_BOOTSTRAP_BITMAP_WORDS (SWYP_UEFI_BOOTSTRAP_MAX_TABLE_PAGES / 64u)
#define SWYP_UEFI_BOOTSTRAP_GUARD_PAGES 1u
#define SWYP_UEFI_BOOTSTRAP_IST_PAGES 2u
#define SWYP_UEFI_BOOTSTRAP_IST_GUARD_PAGES 1u

typedef struct SwypUefiBootstrapArena {
    SwypPageAllocator contract;
    uint64_t physical_base;
    uint32_t table_pages;
    uint32_t guard_pages;
    uint32_t ist_pages;
    uint32_t ist_guard_pages;
    uint32_t stack_pages;
    uint64_t table_bitmap[SWYP_UEFI_BOOTSTRAP_BITMAP_WORDS];
    uint32_t firmware_allocated;
    uint32_t reserved0;
} SwypUefiBootstrapArena;

SwypStatus swyp_uefi_bootstrap_arena_init(EFI_SYSTEM_TABLE *system_table, SwypUefiBootstrapArena *arena,
                                          uint32_t table_pages, uint32_t stack_pages);
SwypStatus swyp_uefi_bootstrap_arena_release(EFI_SYSTEM_TABLE *system_table, SwypUefiBootstrapArena *arena);
SwypPageAllocator *swyp_uefi_bootstrap_page_allocator(SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_arena_bytes(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_table_bytes(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_guard_base(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_ist_base(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_ist_top(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_ist_guard_base(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_stack_base(const SwypUefiBootstrapArena *arena);
uint64_t swyp_uefi_bootstrap_stack_top(const SwypUefiBootstrapArena *arena);
const SwypX86AddressSpaceHardwareOps *swyp_uefi_bootstrap_mmu_ops(void);

#endif
