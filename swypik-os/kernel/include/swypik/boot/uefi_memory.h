#ifndef SWYPIK_BOOT_UEFI_MEMORY_H
#define SWYPIK_BOOT_UEFI_MEMORY_H

#include "swypik/kernel/contracts.h"
#include "swypik/uefi/uefi.h"

#define SWYP_UEFI_PAGE_SIZE UINT64_C(4096)
#define SWYP_UEFI_ALLOCATOR_MIN_PHYSICAL UINT64_C(0x100000)
#define SWYP_UEFI_ALLOCATOR_MAX_EXTENTS 256u

typedef struct SwypUefiMemoryExtent {
    uint64_t base;
    uint64_t page_count;
} SwypUefiMemoryExtent;

typedef struct SwypUefiPageAllocator {
    SwypPageAllocator contract;
    uint32_t usable_extent_count;
    uint32_t free_extent_count;
    SwypUefiMemoryExtent usable_extents[SWYP_UEFI_ALLOCATOR_MAX_EXTENTS];
    SwypUefiMemoryExtent free_extents[SWYP_UEFI_ALLOCATOR_MAX_EXTENTS];
} SwypUefiPageAllocator;

SwypStatus swyp_uefi_page_allocator_init(SwypUefiPageAllocator *allocator, const SwypPhysicalMemoryMap *memory_map);
SwypPageAllocator *swyp_uefi_page_allocator_contract(SwypUefiPageAllocator *allocator);
uint64_t swyp_uefi_page_allocator_free_pages(const SwypUefiPageAllocator *allocator);

#endif
