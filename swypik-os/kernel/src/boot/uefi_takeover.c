#include "swypik/boot/uefi_takeover.h"
#include "swypik/arch/x86_64/driver_image.h"

static const EFI_GUID kLoadedImageProtocolGuid = {
    UINT32_C(0x5b1b31a1), UINT16_C(0x9562), UINT16_C(0x11d2),
    {0x8e, 0x3f, 0x00, 0xa0, 0xc9, 0x69, 0x72, 0x3b}
};

static void swyp_uefi_takeover_copy_descriptor(EFI_MEMORY_DESCRIPTOR *dst, const uint8_t *src) {
    uint32_t i;
    uint8_t *out = (uint8_t *)(void *)dst;
    for (i = 0u; i < (uint32_t)sizeof(*dst); ++i) {
        out[i] = src[i];
    }
}

static int swyp_uefi_takeover_range_covered(const SwypPhysicalMemoryMap *memory_map, uint64_t base, uint64_t length,
                                             int loader_data_only) {
    const uint8_t *bytes;
    uint64_t cursor = base;
    uint64_t end;
    if (memory_map == NULL || length == 0u || length - 1u > UINT64_MAX - base ||
        memory_map->entries_address == 0u || memory_map->entry_stride < sizeof(EFI_MEMORY_DESCRIPTOR)) {
        return 0;
    }
    end = base + length;
    bytes = (const uint8_t *)(uintptr_t)memory_map->entries_address;
    while (cursor < end) {
        uint64_t best_end = cursor;
        uint32_t i;
        for (i = 0u; i < memory_map->entry_count; ++i) {
            EFI_MEMORY_DESCRIPTOR descriptor;
            uint64_t descriptor_bytes;
            uint64_t descriptor_end;
            swyp_uefi_takeover_copy_descriptor(&descriptor, bytes + (uint64_t)i * memory_map->entry_stride);
            if (descriptor.NumberOfPages == 0u || descriptor.NumberOfPages > UINT64_MAX / SWYP_X86_64_PAGE_SIZE ||
                (loader_data_only && descriptor.Type != (EFI_UINT32)EfiLoaderData) ||
                (!loader_data_only && descriptor.Type != (EFI_UINT32)EfiLoaderCode &&
                 descriptor.Type != (EFI_UINT32)EfiLoaderData)) {
                continue;
            }
            descriptor_bytes = descriptor.NumberOfPages * SWYP_X86_64_PAGE_SIZE;
            if (descriptor.PhysicalStart > UINT64_MAX - descriptor_bytes) {
                continue;
            }
            descriptor_end = descriptor.PhysicalStart + descriptor_bytes;
            if (descriptor.PhysicalStart <= cursor && cursor < descriptor_end && descriptor_end > best_end) {
                best_end = descriptor_end;
            }
        }
        if (best_end == cursor) {
            return 0;
        }
        cursor = best_end > end ? end : best_end;
    }
    return 1;
}

static int swyp_uefi_takeover_acpi_range_covered(const SwypPhysicalMemoryMap *memory_map, uint64_t base,
                                                 uint64_t length) {
    const uint8_t *bytes;
    uint64_t end;
    uint32_t i;
    if (memory_map == NULL || base == 0u || length == 0u || length - 1u > UINT64_MAX - base ||
        memory_map->entries_address == 0u || memory_map->entry_stride < sizeof(EFI_MEMORY_DESCRIPTOR)) {
        return 0;
    }
    end = base + length;
    bytes = (const uint8_t *)(uintptr_t)memory_map->entries_address;
    for (i = 0u; i < memory_map->entry_count; ++i) {
        EFI_MEMORY_DESCRIPTOR descriptor;
        uint64_t descriptor_bytes;
        uint64_t descriptor_end;
        swyp_uefi_takeover_copy_descriptor(&descriptor, bytes + (uint64_t)i * memory_map->entry_stride);
        if ((descriptor.Type != (EFI_UINT32)EfiACPIReclaimMemory &&
             descriptor.Type != (EFI_UINT32)EfiACPIMemoryNVS) ||
            descriptor.NumberOfPages == 0u || descriptor.NumberOfPages > UINT64_MAX / SWYP_X86_64_PAGE_SIZE) {
            continue;
        }
        descriptor_bytes = descriptor.NumberOfPages * SWYP_X86_64_PAGE_SIZE;
        if (descriptor.PhysicalStart > UINT64_MAX - descriptor_bytes) {
            continue;
        }
        descriptor_end = descriptor.PhysicalStart + descriptor_bytes;
        if (descriptor.PhysicalStart <= base && end <= descriptor_end) {
            return 1;
        }
    }
    return 0;
}

static SwypStatus swyp_uefi_takeover_add_direct(SwypUefiTakeover *takeover, uint64_t base, uint64_t length,
                                                uint64_t flags) {
    uint64_t end;
    uint32_t position = 0u;
    uint32_t i;
    if (takeover == NULL || length == 0u || (base & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u ||
        (length & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u || length - 1u > UINT64_MAX - base) {
        return SWYP_ERR_INVALID;
    }
    end = base + length;
    while (position < takeover->direct_range_count && takeover->direct_ranges[position].base < base) {
        position += 1u;
    }
    if (position > 0u) {
        SwypKernelPhysicalRange *previous = &takeover->direct_ranges[position - 1u];
        uint64_t previous_end = previous->base + previous->length;
        if (base < previous_end) {
            return SWYP_ERR_DENIED;
        }
        if (base == previous_end && previous->flags == flags) {
            previous->length += length;
            if (position < takeover->direct_range_count &&
                previous->base + previous->length == takeover->direct_ranges[position].base &&
                takeover->direct_ranges[position].flags == flags) {
                previous->length += takeover->direct_ranges[position].length;
                for (i = position; i + 1u < takeover->direct_range_count; ++i) {
                    takeover->direct_ranges[i] = takeover->direct_ranges[i + 1u];
                }
                takeover->direct_range_count -= 1u;
            }
            return SWYP_OK;
        }
    }
    if (position < takeover->direct_range_count) {
        SwypKernelPhysicalRange *next = &takeover->direct_ranges[position];
        if (end > next->base) {
            return SWYP_ERR_DENIED;
        }
        if (end == next->base && next->flags == flags) {
            next->base = base;
            next->length += length;
            return SWYP_OK;
        }
    }
    if (takeover->direct_range_count >= SWYP_KERNEL_TAKEOVER_MAX_DIRECT_RANGES) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = takeover->direct_range_count; i > position; --i) {
        takeover->direct_ranges[i] = takeover->direct_ranges[i - 1u];
    }
    takeover->direct_ranges[position].base = base;
    takeover->direct_ranges[position].length = length;
    takeover->direct_ranges[position].flags = flags;
    takeover->direct_range_count += 1u;
    return SWYP_OK;
}

static SwypStatus swyp_uefi_takeover_collect_direct(SwypUefiTakeover *takeover,
                                                    const SwypPhysicalMemoryMap *memory_map) {
    const uint8_t *bytes;
    uint32_t i;
    uint64_t arena_bytes;
    SwypStatus status;
    if (takeover == NULL || memory_map == NULL || memory_map->source != SWYP_MEMORY_MAP_UEFI ||
        memory_map->entries_address == 0u || memory_map->entry_stride < sizeof(EFI_MEMORY_DESCRIPTOR) ||
        memory_map->entry_count == 0u || memory_map->entry_count > memory_map->buffer_bytes / memory_map->entry_stride) {
        return SWYP_ERR_INVALID;
    }
    takeover->direct_range_count = 0u;
    bytes = (const uint8_t *)(uintptr_t)memory_map->entries_address;
    for (i = 0u; i < memory_map->entry_count; ++i) {
        EFI_MEMORY_DESCRIPTOR descriptor;
        uint64_t length;
        swyp_uefi_takeover_copy_descriptor(&descriptor, bytes + (uint64_t)i * memory_map->entry_stride);
        uint64_t flags;
        if (descriptor.NumberOfPages == 0u || descriptor.NumberOfPages > UINT64_MAX / SWYP_X86_64_PAGE_SIZE) {
            continue;
        }
        if (descriptor.Type == (EFI_UINT32)EfiConventionalMemory) {
            flags = SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL;
        } else if (descriptor.Type == (EFI_UINT32)EfiACPIReclaimMemory ||
                   descriptor.Type == (EFI_UINT32)EfiACPIMemoryNVS) {
            flags = SWYP_MMU_READ | SWYP_MMU_GLOBAL;
        } else {
            continue;
        }
        length = descriptor.NumberOfPages * SWYP_X86_64_PAGE_SIZE;
        status = swyp_uefi_takeover_add_direct(takeover, descriptor.PhysicalStart, length, flags);
        if (status != SWYP_OK) {
            return status;
        }
    }
    arena_bytes = swyp_uefi_bootstrap_arena_bytes(takeover->arena);
    if (arena_bytes == 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_uefi_takeover_add_direct(takeover, takeover->arena->physical_base, arena_bytes,
                                           SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL);
    if (status != SWYP_OK) {
        return status;
    }
    return takeover->direct_range_count == 0u ? SWYP_ERR_NO_SPACE : SWYP_OK;
}

static SwypStatus swyp_uefi_takeover_collect_identity(SwypUefiTakeover *takeover,
                                                      const SwypPhysicalMemoryMap *memory_map) {
    uint64_t arena_bytes;
    uint64_t table_bytes;
    uint64_t ist_base;
    uint64_t ist_bytes;
    uint64_t stack_base;
    uint64_t stack_bytes;
    uint32_t i;
    SwypStatus status;
    if (takeover == NULL || takeover->image_base == NULL || takeover->image_size == 0u) {
        return SWYP_ERR_INVALID;
    }
    takeover->identity_range_count = 0u;
    takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_PE_RANGES;
    status = swyp_pe_collect_identity_ranges(takeover->image_base, takeover->image_size, takeover->identity_ranges,
                                             SWYP_KERNEL_TAKEOVER_MAX_IDENTITY_RANGES - 3u,
                                             &takeover->identity_range_count);
    if (status != SWYP_OK) {
        return status;
    }
    takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_IMAGE_COVERAGE;
    for (i = 0u; i < takeover->identity_range_count; ++i) {
        if (!swyp_uefi_takeover_range_covered(memory_map, takeover->identity_ranges[i].base,
                                              takeover->identity_ranges[i].length, 0)) {
            return SWYP_ERR_CORRUPT;
        }
    }
    arena_bytes = swyp_uefi_bootstrap_arena_bytes(takeover->arena);
    table_bytes = swyp_uefi_bootstrap_table_bytes(takeover->arena);
    ist_base = swyp_uefi_bootstrap_ist_base(takeover->arena);
    ist_bytes = (uint64_t)takeover->arena->ist_pages * SWYP_X86_64_PAGE_SIZE;
    stack_base = swyp_uefi_bootstrap_stack_base(takeover->arena);
    stack_bytes = (uint64_t)takeover->arena->stack_pages * SWYP_X86_64_PAGE_SIZE;
    if (arena_bytes == 0u || table_bytes == 0u || ist_base == 0u || ist_bytes == 0u || stack_base == 0u ||
        stack_bytes == 0u || takeover->identity_range_count > SWYP_KERNEL_TAKEOVER_MAX_IDENTITY_RANGES - 3u) {
        return SWYP_ERR_NO_SPACE;
    }
    takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_ARENA_COVERAGE;
    if (!swyp_uefi_takeover_range_covered(memory_map, takeover->arena->physical_base, arena_bytes, 1)) {
        return SWYP_ERR_CORRUPT;
    }
    takeover->identity_ranges[takeover->identity_range_count++] = (SwypKernelIdentityRange){
        takeover->arena->physical_base,
        table_bytes,
        SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL,
    };
    takeover->identity_ranges[takeover->identity_range_count++] = (SwypKernelIdentityRange){
        ist_base,
        ist_bytes,
        SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL,
    };
    takeover->identity_ranges[takeover->identity_range_count++] = (SwypKernelIdentityRange){
        stack_base,
        stack_bytes,
        SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL,
    };
    return SWYP_OK;
}

SwypStatus swyp_uefi_takeover_init(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table,
                                   SwypUefiBootstrapArena *arena, SwypUefiTakeover *takeover) {
    EFI_LOADED_IMAGE_PROTOCOL *loaded_image = NULL;
    EFI_STATUS status;
    if (image_handle == NULL || system_table == NULL || system_table->BootServices == NULL ||
        system_table->BootServices->HandleProtocol == NULL || arena == NULL ||
        swyp_uefi_bootstrap_page_allocator(arena) == NULL || takeover == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = system_table->BootServices->HandleProtocol(image_handle, &kLoadedImageProtocolGuid,
                                                        (void **)(void *)&loaded_image);
    if (status != EFI_SUCCESS || loaded_image == NULL || loaded_image->ImageBase == NULL || loaded_image->ImageSize == 0u) {
        return SWYP_ERR_CORRUPT;
    }
    takeover->arena = arena;
    takeover->image_base = loaded_image->ImageBase;
    takeover->image_size = loaded_image->ImageSize;
    takeover->direct_range_count = 0u;
    takeover->identity_range_count = 0u;
    takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_NONE;
    takeover->last_status = SWYP_OK;
    takeover->takeover.prepared = 0u;
    takeover->takeover.activated = 0u;
    return SWYP_OK;
}

SwypStatus swyp_uefi_takeover_prepare_exit(void *context, const SwypBootInfo *boot_info) {
    SwypUefiTakeover *takeover = (SwypUefiTakeover *)context;
    SwypStatus status;
    if (takeover == NULL || boot_info == NULL || takeover->arena == NULL || takeover->takeover.activated != 0u) {
        return SWYP_ERR_INVALID;
    }
    if (takeover->takeover.prepared != 0u) {
        status = swyp_kernel_takeover_destroy_unactivated(&takeover->takeover);
        if (status != SWYP_OK) {
            return status;
        }
    }
    takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_DIRECT_RANGES;
    status = swyp_uefi_takeover_collect_direct(takeover, &boot_info->physical_memory);
    if (status != SWYP_OK) {
        takeover->last_status = status;
        return status;
    }
    if ((boot_info->boot_flags & SWYP_BOOT_FLAG_INIT_IMAGE_READY) != 0u) {
        uint64_t bytes = boot_info->init_image_pages * SWYP_X86_64_PAGE_SIZE;
        if (boot_info->init_image_pages == 0u || boot_info->init_image_pages > SWYP_X86_DRIVER_IMAGE_MAX_PAGES ||
            boot_info->init_image_bytes == 0u || boot_info->init_image_bytes > bytes ||
            !swyp_uefi_takeover_range_covered(&boot_info->physical_memory, boot_info->init_image_address, bytes, 1)) {
            return SWYP_ERR_CORRUPT;
        }
        status = swyp_uefi_takeover_add_direct(takeover, boot_info->init_image_address, bytes,
                                                SWYP_MMU_READ | SWYP_MMU_GLOBAL);
        if (status != SWYP_OK) {
            return status;
        }
    }
    if (boot_info->acpi_rsdp_address != 0u &&
        (boot_info->acpi_rsdp_length < 20u ||
         !swyp_uefi_takeover_acpi_range_covered(&boot_info->physical_memory, boot_info->acpi_rsdp_address,
                                                boot_info->acpi_rsdp_length))) {
        takeover->last_status = SWYP_ERR_CORRUPT;
        return SWYP_ERR_CORRUPT;
    }
    status = swyp_uefi_takeover_collect_identity(takeover, &boot_info->physical_memory);
    if (status != SWYP_OK) {
        takeover->last_status = status;
        return status;
    }
    takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_ROOT;
    status = swyp_kernel_takeover_prepare(&takeover->takeover, swyp_uefi_bootstrap_page_allocator(takeover->arena),
                                          takeover->arena, swyp_uefi_bootstrap_mmu_ops(), takeover->direct_ranges,
                                          takeover->direct_range_count, takeover->identity_ranges,
                                          takeover->identity_range_count);
    takeover->last_status = status;
    if (status == SWYP_OK) {
        takeover->stage = SWYP_UEFI_TAKEOVER_STAGE_PREPARED;
    }
    return status;
}

uint64_t swyp_uefi_takeover_root_physical(const SwypUefiTakeover *takeover) {
    if (takeover == NULL) {
        return 0u;
    }
    return swyp_kernel_takeover_root_physical(&takeover->takeover);
}

uint64_t swyp_uefi_takeover_stack_top(const SwypUefiTakeover *takeover) {
    if (takeover == NULL || takeover->arena == NULL) {
        return 0u;
    }
    return swyp_uefi_bootstrap_stack_top(takeover->arena);
}

SwypStatus swyp_uefi_takeover_confirm_active(SwypUefiTakeover *takeover) {
    if (takeover == NULL) {
        return SWYP_ERR_INVALID;
    }
    return swyp_kernel_takeover_confirm_external_activation(&takeover->takeover);
}
