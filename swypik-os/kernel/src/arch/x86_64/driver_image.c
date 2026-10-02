#include "swypik/arch/x86_64/driver_image.h"

#define SWYP_X86_DRIVER_IMAGE_MAX_SPAN UINT64_C(0x10000000)

static const uint8_t swyp_x86_driver_image_magic[8] = {'S', 'W', 'Y', 'D', 'R', 'V', '1', 0};

static uint16_t swyp_driver_u16(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t swyp_driver_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t swyp_driver_u64(const uint8_t *p) {
    return (uint64_t)swyp_driver_u32(p) | ((uint64_t)swyp_driver_u32(p + 4u) << 32);
}

static int swyp_driver_magic_ok(const uint8_t *image) {
    uint32_t i;
    for (i = 0u; i < 8u; ++i) {
        if (image[i] != swyp_x86_driver_image_magic[i]) {
            return 0;
        }
    }
    return 1;
}

static int swyp_driver_range(uint64_t offset, uint64_t size, uint64_t total) {
    return offset <= total && size <= total - offset;
}

static int swyp_driver_page_aligned(uint64_t value) {
    return (value & (SWYP_X86_64_PAGE_SIZE - 1u)) == 0u;
}

static uint64_t swyp_driver_segment_mmu_flags(uint64_t flags) {
    uint64_t mmu = SWYP_MMU_READ | SWYP_MMU_USER;
    if ((flags & SWYP_X86_DRIVER_SEGMENT_WRITE) != 0u) {
        mmu |= SWYP_MMU_WRITE;
    }
    if ((flags & SWYP_X86_DRIVER_SEGMENT_EXECUTE) != 0u) {
        mmu |= SWYP_MMU_EXECUTE;
    }
    return mmu;
}

static void swyp_driver_loaded_clear(SwypX86LoadedDriverImage *loaded) {
    uint32_t i;
    if (loaded == NULL) {
        return;
    }
    loaded->domain_id = 0u;
    loaded->lease_fence = 0u;
    loaded->entry_address = 0u;
    loaded->stack_pointer = 0u;
    loaded->image_page_count = 0u;
    loaded->stack_page_count = 0u;
    loaded->active = 0u;
    loaded->reserved0 = 0u;
    for (i = 0u; i < SWYP_X86_DRIVER_IMAGE_MAX_PAGES; ++i) {
        loaded->image_pages[i] = (SwypX86DriverLoadedPage){0};
    }
    for (i = 0u; i < SWYP_X86_DRIVER_STACK_MAX_PAGES; ++i) {
        loaded->stack_pages[i] = (SwypX86DriverLoadedPage){0};
    }
}

int swyp_x86_driver_image_executable_address(const SwypX86LoadedDriverImage *loaded, uint64_t virtual_address) {
    uint32_t i;
    if (loaded == NULL || loaded->active == 0u || virtual_address == 0u) {
        return 0;
    }
    for (i = 0u; i < loaded->image_page_count; ++i) {
        const SwypX86DriverLoadedPage *page = &loaded->image_pages[i];
        if (page->mapped != 0u && (page->final_flags & (SWYP_MMU_USER | SWYP_MMU_EXECUTE)) ==
                                     (SWYP_MMU_USER | SWYP_MMU_EXECUTE) &&
            virtual_address >= page->virtual_address && virtual_address - page->virtual_address < SWYP_X86_64_PAGE_SIZE) {
            return 1;
        }
    }
    return 0;
}

int swyp_x86_driver_image_stack_pointer(const SwypX86LoadedDriverImage *loaded, uint64_t stack_pointer) {
    uint32_t i;
    if (loaded == NULL || loaded->active == 0u || stack_pointer == 0u || (stack_pointer & UINT64_C(0xf)) != 0u) {
        return 0;
    }
    if (stack_pointer == loaded->stack_pointer) {
        return loaded->stack_page_count != 0u;
    }
    for (i = 0u; i < loaded->stack_page_count; ++i) {
        const SwypX86DriverLoadedPage *page = &loaded->stack_pages[i];
        if (page->mapped != 0u && (page->final_flags & (SWYP_MMU_USER | SWYP_MMU_WRITE)) ==
                                     (SWYP_MMU_USER | SWYP_MMU_WRITE) &&
            stack_pointer > page->virtual_address && stack_pointer - page->virtual_address <= SWYP_X86_64_PAGE_SIZE) {
            return 1;
        }
    }
    return 0;
}

static void swyp_driver_zero_page(uint8_t *page) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_64_PAGE_SIZE; ++i) {
        page[i] = 0u;
    }
}

static void swyp_driver_copy(uint8_t *dst, const uint8_t *src, uint64_t bytes) {
    uint64_t i;
    for (i = 0u; i < bytes; ++i) {
        dst[i] = src[i];
    }
}

static int swyp_driver_segments_overlap(const SwypX86DriverImageSegment *left,
                                        const SwypX86DriverImageSegment *right) {
    uint64_t left_end = left->virtual_offset + left->memory_size;
    uint64_t right_end = right->virtual_offset + right->memory_size;
    return left->virtual_offset < right_end && right->virtual_offset < left_end;
}

SwypStatus swyp_x86_driver_image_parse(const uint8_t *image, uint64_t image_bytes, SwypX86DriverImageInfo *info) {
    uint16_t version;
    uint16_t header_bytes;
    uint16_t segment_count;
    uint32_t header_flags;
    uint64_t entry_rva;
    uint64_t image_span;
    uint64_t descriptor_bytes;
    uint32_t total_pages = 0u;
    uint16_t i;
    int entry_executable = 0;
    if (image == NULL || info == NULL || image_bytes < SWYP_X86_DRIVER_IMAGE_HEADER_BYTES || !swyp_driver_magic_ok(image)) {
        return SWYP_ERR_INVALID;
    }
    version = swyp_driver_u16(image + 8u);
    header_bytes = swyp_driver_u16(image + 10u);
    segment_count = swyp_driver_u16(image + 12u);
    header_flags = swyp_driver_u32(image + 16u);
    entry_rva = swyp_driver_u64(image + 24u);
    image_span = swyp_driver_u64(image + 32u);
    if (version != SWYP_X86_DRIVER_IMAGE_VERSION || header_bytes != SWYP_X86_DRIVER_IMAGE_HEADER_BYTES ||
        segment_count == 0u || segment_count > SWYP_X86_DRIVER_IMAGE_MAX_SEGMENTS || header_flags != 0u ||
        swyp_driver_u16(image + 14u) != 0u || swyp_driver_u32(image + 20u) != 0u ||
        swyp_driver_u64(image + 40u) != 0u || swyp_driver_u64(image + 48u) != 0u ||
        swyp_driver_u64(image + 56u) != 0u || image_span == 0u || image_span > SWYP_X86_DRIVER_IMAGE_MAX_SPAN ||
        !swyp_driver_page_aligned(image_span) || entry_rva >= image_span) {
        return SWYP_ERR_CORRUPT;
    }
    descriptor_bytes = (uint64_t)segment_count * SWYP_X86_DRIVER_IMAGE_SEGMENT_BYTES;
    if (!swyp_driver_range(header_bytes, descriptor_bytes, image_bytes)) {
        return SWYP_ERR_CORRUPT;
    }
    *info = (SwypX86DriverImageInfo){0};
    info->entry_rva = entry_rva;
    info->image_span = image_span;
    info->segment_count = segment_count;
    for (i = 0u; i < segment_count; ++i) {
        const uint8_t *raw = image + header_bytes + (uint64_t)i * SWYP_X86_DRIVER_IMAGE_SEGMENT_BYTES;
        SwypX86DriverImageSegment *segment = &info->segments[i];
        uint64_t pages;
        uint16_t j;
        segment->virtual_offset = swyp_driver_u64(raw + 0u);
        segment->file_offset = swyp_driver_u64(raw + 8u);
        segment->file_size = swyp_driver_u64(raw + 16u);
        segment->memory_size = swyp_driver_u64(raw + 24u);
        segment->flags = swyp_driver_u64(raw + 32u);
        if (swyp_driver_u64(raw + 40u) != 0u || segment->memory_size == 0u ||
            !swyp_driver_page_aligned(segment->virtual_offset) || !swyp_driver_page_aligned(segment->memory_size) ||
            segment->memory_size > image_span || segment->virtual_offset > image_span - segment->memory_size ||
            segment->file_size > segment->memory_size || !swyp_driver_range(segment->file_offset, segment->file_size, image_bytes) ||
            (segment->flags & SWYP_X86_DRIVER_SEGMENT_READ) == 0u ||
            (segment->flags & ~(SWYP_X86_DRIVER_SEGMENT_READ | SWYP_X86_DRIVER_SEGMENT_WRITE |
                                SWYP_X86_DRIVER_SEGMENT_EXECUTE)) != 0u ||
            ((segment->flags & SWYP_X86_DRIVER_SEGMENT_WRITE) != 0u &&
             (segment->flags & SWYP_X86_DRIVER_SEGMENT_EXECUTE) != 0u)) {
            return SWYP_ERR_CORRUPT;
        }
        if (segment->file_size != 0u && segment->file_offset < header_bytes + descriptor_bytes) {
            return SWYP_ERR_CORRUPT;
        }
        pages = segment->memory_size / SWYP_X86_64_PAGE_SIZE;
        if (pages > UINT32_MAX - total_pages || total_pages + (uint32_t)pages > SWYP_X86_DRIVER_IMAGE_MAX_PAGES) {
            return SWYP_ERR_NO_SPACE;
        }
        total_pages += (uint32_t)pages;
        for (j = 0u; j < i; ++j) {
            if (swyp_driver_segments_overlap(&info->segments[j], segment)) {
                return SWYP_ERR_CORRUPT;
            }
        }
        if ((segment->flags & SWYP_X86_DRIVER_SEGMENT_EXECUTE) != 0u && entry_rva >= segment->virtual_offset &&
            entry_rva < segment->virtual_offset + segment->memory_size) {
            entry_executable = 1;
        }
    }
    if (!entry_executable || total_pages == 0u) {
        return SWYP_ERR_CORRUPT;
    }
    info->total_pages = total_pages;
    return SWYP_OK;
}

static SwypStatus swyp_driver_map_page(SwypX86DriverRuntimeManager *manager, SwypX86AddressSpace *space,
                                       uint64_t virtual_address, uint64_t final_flags,
                                       SwypX86DriverLoadedPage *record) {
    uint64_t physical = 0u;
    uint8_t *pointer;
    SwypAddressSpace *contract;
    SwypStatus status;
    if (manager == NULL || space == NULL || record == NULL || manager->page_allocator == NULL ||
        manager->page_allocator->ops == NULL || manager->page_allocator->ops->allocate == NULL ||
        manager->page_allocator->ops->release == NULL || manager->address_space_hardware_ops == NULL ||
        manager->address_space_hardware_ops->physical_to_virtual == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = manager->page_allocator->ops->allocate(manager->page_allocator->context, 1u, 1u, &physical);
    if (status != SWYP_OK) {
        return status;
    }
    pointer = (uint8_t *)manager->address_space_hardware_ops->physical_to_virtual(manager->hardware_context, physical);
    if (pointer == NULL) {
        (void)manager->page_allocator->ops->release(manager->page_allocator->context, physical, 1u);
        return SWYP_ERR_CORRUPT;
    }
    swyp_driver_zero_page(pointer);
    contract = swyp_x86_64_address_space_contract(space);
    if (contract == NULL || contract->ops == NULL || contract->ops->map == NULL) {
        (void)manager->page_allocator->ops->release(manager->page_allocator->context, physical, 1u);
        return SWYP_ERR_CORRUPT;
    }
    status = contract->ops->map(contract->context, virtual_address, physical, 1u,
                                SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER);
    if (status != SWYP_OK) {
        (void)manager->page_allocator->ops->release(manager->page_allocator->context, physical, 1u);
        return status;
    }
    record->virtual_address = virtual_address;
    record->physical_address = physical;
    record->final_flags = final_flags;
    record->mapped = 1u;
    record->reserved0 = 0u;
    return SWYP_OK;
}

static SwypStatus swyp_driver_unload_pages(SwypX86DriverRuntimeManager *manager, SwypX86AddressSpace *space,
                                           SwypX86DriverLoadedPage *pages, uint32_t count) {
    SwypAddressSpace *contract = swyp_x86_64_address_space_contract(space);
    uint32_t i;
    SwypStatus first_error = SWYP_OK;
    if (manager == NULL || space == NULL || pages == NULL || contract == NULL || contract->ops == NULL ||
        contract->ops->unmap == NULL || manager->page_allocator == NULL || manager->page_allocator->ops == NULL ||
        manager->page_allocator->ops->release == NULL) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0u; i < count; ++i) {
        if (pages[i].mapped != 0u) {
            if (contract->ops->unmap(contract->context, pages[i].virtual_address, 1u) != SWYP_OK) {
                if (first_error == SWYP_OK) {
                    first_error = SWYP_ERR_CORRUPT;
                }
                continue;
            }
            pages[i].mapped = 0u;
        }
        if (pages[i].physical_address != 0u &&
            manager->page_allocator->ops->release(manager->page_allocator->context, pages[i].physical_address, 1u) !=
                SWYP_OK) {
            if (first_error == SWYP_OK) {
                first_error = SWYP_ERR_CORRUPT;
            }
            continue;
        }
        pages[i].physical_address = 0u;
    }
    return first_error;
}

SwypStatus swyp_x86_driver_image_load(SwypX86DriverRuntimeManager *manager, uint64_t domain_id, uint64_t lease_fence,
                                      const uint8_t *image, uint64_t image_bytes, uint32_t stack_pages,
                                      SwypX86LoadedDriverImage *loaded, SwypThreadContext *initial_context) {
    SwypX86DriverImageInfo info;
    SwypX86AddressSpace *space;
    SwypAddressSpace *contract;
    SwypX86_64ThreadContext *context;
    uint32_t image_page = 0u;
    uint16_t segment_index;
    uint32_t stack_index;
    SwypStatus status;
    if (manager == NULL || domain_id == 0u || lease_fence == 0u || loaded == NULL || initial_context == NULL ||
        stack_pages == 0u || stack_pages > SWYP_X86_DRIVER_STACK_MAX_PAGES) {
        return SWYP_ERR_INVALID;
    }
    swyp_driver_loaded_clear(loaded);
    status = swyp_x86_driver_image_parse(image, image_bytes, &info);
    if (status != SWYP_OK) {
        return status;
    }
    space = swyp_x86_64_driver_runtime_x86_space(manager, domain_id, lease_fence);
    if (space == NULL || manager->address_space_hardware_ops == NULL || manager->address_space_hardware_ops->current_root == NULL ||
        manager->address_space_hardware_ops->current_root(manager->hardware_context) == space->pml4_physical) {
        return SWYP_ERR_DENIED;
    }
    contract = swyp_x86_64_address_space_contract(space);
    if (contract == NULL || contract->ops == NULL || contract->ops->protect == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    loaded->domain_id = domain_id;
    loaded->lease_fence = lease_fence;
    /* Mark the record cleanup-owned before the first allocation. A failed
       rollback can therefore be retried through unload without publishing an
       executable entrypoint. */
    loaded->active = 1u;
    for (segment_index = 0u; segment_index < info.segment_count; ++segment_index) {
        const SwypX86DriverImageSegment *segment = &info.segments[segment_index];
        uint64_t segment_pages = segment->memory_size / SWYP_X86_64_PAGE_SIZE;
        uint64_t page;
        uint64_t final_flags = swyp_driver_segment_mmu_flags(segment->flags);
        for (page = 0u; page < segment_pages; ++page) {
            SwypX86DriverLoadedPage *record = &loaded->image_pages[image_page];
            uint64_t virtual_address = SWYP_X86_DRIVER_IMAGE_BASE + segment->virtual_offset + page * SWYP_X86_64_PAGE_SIZE;
            uint8_t *pointer;
            uint64_t file_page_offset = page * SWYP_X86_64_PAGE_SIZE;
            uint64_t copy_bytes = 0u;
            status = swyp_driver_map_page(manager, space, virtual_address, final_flags, record);
            if (status != SWYP_OK) {
                goto rollback;
            }
            pointer = (uint8_t *)manager->address_space_hardware_ops->physical_to_virtual(manager->hardware_context,
                                                                                          record->physical_address);
            if (pointer == NULL) {
                status = SWYP_ERR_CORRUPT;
                goto rollback;
            }
            if (file_page_offset < segment->file_size) {
                copy_bytes = segment->file_size - file_page_offset;
                if (copy_bytes > SWYP_X86_64_PAGE_SIZE) {
                    copy_bytes = SWYP_X86_64_PAGE_SIZE;
                }
                swyp_driver_copy(pointer, image + segment->file_offset + file_page_offset, copy_bytes);
            }
            image_page += 1u;
            loaded->image_page_count = image_page;
        }
        status = contract->ops->protect(contract->context, SWYP_X86_DRIVER_IMAGE_BASE + segment->virtual_offset,
                                        segment_pages, final_flags);
        if (status != SWYP_OK) {
            goto rollback;
        }
    }
    for (stack_index = 0u; stack_index < stack_pages; ++stack_index) {
        SwypX86DriverLoadedPage *record = &loaded->stack_pages[stack_index];
        uint64_t virtual_address = SWYP_X86_DRIVER_STACK_TOP - (uint64_t)(stack_pages - stack_index) * SWYP_X86_64_PAGE_SIZE;
        status = swyp_driver_map_page(manager, space, virtual_address, SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER,
                                      record);
        if (status != SWYP_OK) {
            goto rollback;
        }
        loaded->stack_page_count = stack_index + 1u;
    }
    loaded->entry_address = SWYP_X86_DRIVER_IMAGE_BASE + info.entry_rva;
    loaded->stack_pointer = SWYP_X86_DRIVER_STACK_TOP;
    loaded->active = 1u;
    *initial_context = (SwypThreadContext){0};
    initial_context->abi_version = SWYP_KERNEL_ABI_VERSION;
    initial_context->struct_size = (uint32_t)sizeof(*initial_context);
    initial_context->arch = SWYP_ARCH_X86_64;
    initial_context->used_bytes = (uint32_t)sizeof(SwypX86_64ThreadContext);
    context = (SwypX86_64ThreadContext *)(void *)initial_context->storage;
    *context = (SwypX86_64ThreadContext){0};
    context->rip = loaded->entry_address;
    context->rsp = loaded->stack_pointer;
    context->rflags = SWYP_X86_DRIVER_INITIAL_RFLAGS;
    return SWYP_OK;

rollback:
    {
        SwypStatus stack_cleanup = swyp_driver_unload_pages(manager, space, loaded->stack_pages,
                                                            loaded->stack_page_count);
        SwypStatus image_cleanup = swyp_driver_unload_pages(manager, space, loaded->image_pages,
                                                            loaded->image_page_count);
        if (stack_cleanup == SWYP_OK && image_cleanup == SWYP_OK) {
            swyp_driver_loaded_clear(loaded);
            return status;
        }
        loaded->entry_address = 0u;
        loaded->stack_pointer = 0u;
        return SWYP_ERR_CORRUPT;
    }
}

SwypStatus swyp_x86_driver_image_unload(SwypX86DriverRuntimeManager *manager, SwypX86LoadedDriverImage *loaded) {
    SwypX86AddressSpace *space;
    SwypStatus stack_status;
    SwypStatus image_status;
    if (manager == NULL || loaded == NULL || loaded->active == 0u || loaded->domain_id == 0u || loaded->lease_fence == 0u ||
        manager->address_space_hardware_ops == NULL || manager->address_space_hardware_ops->current_root == NULL) {
        return SWYP_ERR_INVALID;
    }
    space = swyp_x86_64_driver_runtime_x86_space(manager, loaded->domain_id, loaded->lease_fence);
    if (space == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (manager->address_space_hardware_ops->current_root(manager->hardware_context) == space->pml4_physical) {
        return SWYP_ERR_DENIED;
    }
    stack_status = swyp_driver_unload_pages(manager, space, loaded->stack_pages, loaded->stack_page_count);
    image_status = swyp_driver_unload_pages(manager, space, loaded->image_pages, loaded->image_page_count);
    if (stack_status != SWYP_OK || image_status != SWYP_OK) {
        return SWYP_ERR_CORRUPT;
    }
    swyp_driver_loaded_clear(loaded);
    return SWYP_OK;
}
