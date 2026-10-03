#include "swypik/boot/uefi_memory.h"

static void swyp_uefi_extent_clear(SwypUefiMemoryExtent *extent) {
    if (extent != NULL) {
        extent->base = 0u;
        extent->page_count = 0u;
    }
}

static int swyp_uefi_range_end(uint64_t base, uint64_t page_count, uint64_t *end) {
    uint64_t bytes;
    if (end == NULL || page_count == 0u || page_count > UINT64_MAX / SWYP_UEFI_PAGE_SIZE) {
        return 0;
    }
    bytes = page_count * SWYP_UEFI_PAGE_SIZE;
    if (base > UINT64_MAX - bytes) {
        return 0;
    }
    *end = base + bytes;
    return 1;
}

static void swyp_uefi_copy_descriptor(EFI_MEMORY_DESCRIPTOR *dst, const uint8_t *src) {
    uint32_t i;
    uint8_t *out = (uint8_t *)(void *)dst;
    for (i = 0; i < (uint32_t)sizeof(*dst); ++i) {
        out[i] = src[i];
    }
}

static int swyp_uefi_extent_contains(const SwypUefiMemoryExtent *extent, uint64_t base, uint64_t page_count) {
    uint64_t extent_end;
    uint64_t range_end;
    return extent != NULL && swyp_uefi_range_end(extent->base, extent->page_count, &extent_end) &&
           swyp_uefi_range_end(base, page_count, &range_end) && base >= extent->base && range_end <= extent_end;
}

static int swyp_uefi_range_is_usable(const SwypUefiPageAllocator *allocator, uint64_t base, uint64_t page_count) {
    uint32_t i;
    for (i = 0; i < allocator->usable_extent_count; ++i) {
        if (swyp_uefi_extent_contains(&allocator->usable_extents[i], base, page_count)) {
            return 1;
        }
    }
    return 0;
}

static void swyp_uefi_remove_free_extent(SwypUefiPageAllocator *allocator, uint32_t index) {
    uint32_t i;
    for (i = index; i + 1u < allocator->free_extent_count; ++i) {
        allocator->free_extents[i] = allocator->free_extents[i + 1u];
    }
    if (allocator->free_extent_count != 0u) {
        allocator->free_extent_count -= 1u;
        swyp_uefi_extent_clear(&allocator->free_extents[allocator->free_extent_count]);
    }
}

static SwypStatus swyp_uefi_insert_free_extent(SwypUefiPageAllocator *allocator, uint64_t base, uint64_t page_count) {
    uint64_t range_end;
    uint32_t position = 0u;
    uint32_t i;
    if (allocator == NULL || (base & (SWYP_UEFI_PAGE_SIZE - 1u)) != 0u ||
        !swyp_uefi_range_end(base, page_count, &range_end)) {
        return SWYP_ERR_INVALID;
    }
    while (position < allocator->free_extent_count && allocator->free_extents[position].base < base) {
        position += 1u;
    }
    if (position > 0u) {
        uint64_t previous_end;
        const SwypUefiMemoryExtent *previous = &allocator->free_extents[position - 1u];
        if (!swyp_uefi_range_end(previous->base, previous->page_count, &previous_end) || base < previous_end) {
            return SWYP_ERR_INVALID;
        }
        if (base == previous_end) {
            uint64_t combined = previous->page_count + page_count;
            if (combined < previous->page_count) {
                return SWYP_ERR_INVALID;
            }
            allocator->free_extents[position - 1u].page_count = combined;
            if (position < allocator->free_extent_count && range_end == allocator->free_extents[position].base) {
                uint64_t next_pages = allocator->free_extents[position].page_count;
                if (combined > UINT64_MAX - next_pages) {
                    return SWYP_ERR_INVALID;
                }
                allocator->free_extents[position - 1u].page_count = combined + next_pages;
                swyp_uefi_remove_free_extent(allocator, position);
            }
            return SWYP_OK;
        }
    }
    if (position < allocator->free_extent_count) {
        const SwypUefiMemoryExtent *next = &allocator->free_extents[position];
        if (range_end > next->base) {
            return SWYP_ERR_INVALID;
        }
        if (range_end == next->base) {
            allocator->free_extents[position].base = base;
            if (page_count > UINT64_MAX - allocator->free_extents[position].page_count) {
                return SWYP_ERR_INVALID;
            }
            allocator->free_extents[position].page_count += page_count;
            return SWYP_OK;
        }
    }
    if (allocator->free_extent_count >= SWYP_UEFI_ALLOCATOR_MAX_EXTENTS) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = allocator->free_extent_count; i > position; --i) {
        allocator->free_extents[i] = allocator->free_extents[i - 1u];
    }
    allocator->free_extents[position].base = base;
    allocator->free_extents[position].page_count = page_count;
    allocator->free_extent_count += 1u;
    return SWYP_OK;
}

static int swyp_uefi_alignment_valid(uint64_t alignment_pages) {
    return alignment_pages != 0u && (alignment_pages & (alignment_pages - 1u)) == 0u;
}

static int swyp_uefi_align_up(uint64_t value, uint64_t alignment, uint64_t *aligned) {
    uint64_t mask;
    if (aligned == NULL || alignment == 0u || (alignment & (alignment - 1u)) != 0u) {
        return 0;
    }
    mask = alignment - 1u;
    if (value > UINT64_MAX - mask) {
        return 0;
    }
    *aligned = (value + mask) & ~mask;
    return 1;
}

static SwypStatus swyp_uefi_allocate_pages(void *context, uint64_t page_count, uint64_t alignment_pages,
                                           uint64_t *physical_address) {
    SwypUefiPageAllocator *allocator = (SwypUefiPageAllocator *)context;
    uint64_t alignment_bytes;
    uint32_t i;
    if (allocator == NULL || physical_address == NULL || page_count == 0u ||
        !swyp_uefi_alignment_valid(alignment_pages) || alignment_pages > UINT64_MAX / SWYP_UEFI_PAGE_SIZE) {
        return SWYP_ERR_INVALID;
    }
    alignment_bytes = alignment_pages * SWYP_UEFI_PAGE_SIZE;
    for (i = 0; i < allocator->free_extent_count; ++i) {
        SwypUefiMemoryExtent extent = allocator->free_extents[i];
        uint64_t extent_end;
        uint64_t aligned_base;
        uint64_t allocation_end;
        uint64_t prefix_pages;
        uint64_t suffix_pages;
        if (!swyp_uefi_range_end(extent.base, extent.page_count, &extent_end) ||
            !swyp_uefi_align_up(extent.base, alignment_bytes, &aligned_base) || aligned_base < extent.base ||
            aligned_base > extent_end || !swyp_uefi_range_end(aligned_base, page_count, &allocation_end) ||
            allocation_end > extent_end) {
            continue;
        }
        prefix_pages = (aligned_base - extent.base) / SWYP_UEFI_PAGE_SIZE;
        suffix_pages = (extent_end - allocation_end) / SWYP_UEFI_PAGE_SIZE;
        if (prefix_pages != 0u && suffix_pages != 0u &&
            allocator->free_extent_count >= SWYP_UEFI_ALLOCATOR_MAX_EXTENTS) {
            continue;
        }
        if (prefix_pages == 0u && suffix_pages == 0u) {
            swyp_uefi_remove_free_extent(allocator, i);
        } else if (prefix_pages == 0u) {
            allocator->free_extents[i].base = allocation_end;
            allocator->free_extents[i].page_count = suffix_pages;
        } else if (suffix_pages == 0u) {
            allocator->free_extents[i].page_count = prefix_pages;
        } else {
            uint32_t j;
            for (j = allocator->free_extent_count; j > i + 1u; --j) {
                allocator->free_extents[j] = allocator->free_extents[j - 1u];
            }
            allocator->free_extents[i].page_count = prefix_pages;
            allocator->free_extents[i + 1u].base = allocation_end;
            allocator->free_extents[i + 1u].page_count = suffix_pages;
            allocator->free_extent_count += 1u;
        }
        *physical_address = aligned_base;
        return SWYP_OK;
    }
    return SWYP_ERR_NO_SPACE;
}

static SwypStatus swyp_uefi_release_pages(void *context, uint64_t physical_address, uint64_t page_count) {
    SwypUefiPageAllocator *allocator = (SwypUefiPageAllocator *)context;
    if (allocator == NULL || (physical_address & (SWYP_UEFI_PAGE_SIZE - 1u)) != 0u || page_count == 0u ||
        !swyp_uefi_range_is_usable(allocator, physical_address, page_count)) {
        return SWYP_ERR_INVALID;
    }
    return swyp_uefi_insert_free_extent(allocator, physical_address, page_count);
}

static const SwypPageAllocatorOps swyp_uefi_allocator_ops = {
    .allocate = swyp_uefi_allocate_pages,
    .release = swyp_uefi_release_pages,
};

static SwypStatus swyp_uefi_add_usable_extent(SwypUefiPageAllocator *allocator, uint64_t base, uint64_t page_count) {
    uint64_t end;
    uint64_t trimmed_base = base;
    uint64_t trimmed_pages = page_count;
    SwypStatus status;
    if ((base & (SWYP_UEFI_PAGE_SIZE - 1u)) != 0u || !swyp_uefi_range_end(base, page_count, &end)) {
        return SWYP_ERR_CORRUPT;
    }
    if (end <= SWYP_UEFI_ALLOCATOR_MIN_PHYSICAL) {
        return SWYP_OK;
    }
    if (trimmed_base < SWYP_UEFI_ALLOCATOR_MIN_PHYSICAL) {
        uint64_t removed_pages = (SWYP_UEFI_ALLOCATOR_MIN_PHYSICAL - trimmed_base) / SWYP_UEFI_PAGE_SIZE;
        trimmed_base = SWYP_UEFI_ALLOCATOR_MIN_PHYSICAL;
        if (removed_pages >= trimmed_pages) {
            return SWYP_OK;
        }
        trimmed_pages -= removed_pages;
    }
    if (allocator->usable_extent_count >= SWYP_UEFI_ALLOCATOR_MAX_EXTENTS) {
        return SWYP_ERR_NO_SPACE;
    }
    status = swyp_uefi_insert_free_extent(allocator, trimmed_base, trimmed_pages);
    if (status != SWYP_OK) {
        return status == SWYP_ERR_INVALID ? SWYP_ERR_CORRUPT : status;
    }
    allocator->usable_extents[allocator->usable_extent_count].base = trimmed_base;
    allocator->usable_extents[allocator->usable_extent_count].page_count = trimmed_pages;
    allocator->usable_extent_count += 1u;
    return SWYP_OK;
}

SwypStatus swyp_uefi_page_allocator_init(SwypUefiPageAllocator *allocator, const SwypPhysicalMemoryMap *memory_map) {
    const uint8_t *bytes;
    uint32_t i;
    if (allocator == NULL || memory_map == NULL || memory_map->source != SWYP_MEMORY_MAP_UEFI ||
        memory_map->entries_address == 0u || memory_map->entry_stride < sizeof(EFI_MEMORY_DESCRIPTOR) ||
        memory_map->entry_count == 0u || memory_map->entry_count > memory_map->buffer_bytes / memory_map->entry_stride) {
        return SWYP_ERR_INVALID;
    }
    allocator->contract.context = NULL;
    allocator->contract.ops = NULL;
    allocator->usable_extent_count = 0u;
    allocator->free_extent_count = 0u;
    for (i = 0; i < SWYP_UEFI_ALLOCATOR_MAX_EXTENTS; ++i) {
        swyp_uefi_extent_clear(&allocator->usable_extents[i]);
        swyp_uefi_extent_clear(&allocator->free_extents[i]);
    }
    bytes = (const uint8_t *)(uintptr_t)memory_map->entries_address;
    for (i = 0; i < memory_map->entry_count; ++i) {
        EFI_MEMORY_DESCRIPTOR descriptor;
        SwypStatus status;
        swyp_uefi_copy_descriptor(&descriptor, bytes + (uint64_t)i * memory_map->entry_stride);
        if (descriptor.Type != (EFI_UINT32)EfiConventionalMemory || descriptor.NumberOfPages == 0u) {
            continue;
        }
        status = swyp_uefi_add_usable_extent(allocator, descriptor.PhysicalStart, descriptor.NumberOfPages);
        if (status != SWYP_OK) {
            allocator->usable_extent_count = 0u;
            allocator->free_extent_count = 0u;
            return status;
        }
    }
    if (allocator->free_extent_count == 0u) {
        return SWYP_ERR_NO_SPACE;
    }
    allocator->contract.context = allocator;
    allocator->contract.ops = &swyp_uefi_allocator_ops;
    return SWYP_OK;
}

SwypPageAllocator *swyp_uefi_page_allocator_contract(SwypUefiPageAllocator *allocator) {
    if (allocator == NULL || allocator->contract.ops == NULL) {
        return NULL;
    }
    return &allocator->contract;
}

uint64_t swyp_uefi_page_allocator_free_pages(const SwypUefiPageAllocator *allocator) {
    uint64_t pages = 0u;
    uint32_t i;
    if (allocator == NULL) {
        return 0u;
    }
    for (i = 0; i < allocator->free_extent_count; ++i) {
        if (pages > UINT64_MAX - allocator->free_extents[i].page_count) {
            return UINT64_MAX;
        }
        pages += allocator->free_extents[i].page_count;
    }
    return pages;
}
