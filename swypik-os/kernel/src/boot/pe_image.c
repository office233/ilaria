#include "swypik/boot/pe_image.h"

#include <stdint.h>

#define SWYP_PE_DOS_MAGIC UINT16_C(0x5a4d)
#define SWYP_PE_SIGNATURE UINT32_C(0x00004550)
#define SWYP_PE32_PLUS_MAGIC UINT16_C(0x020b)
#define SWYP_PE_SECTION_HEADER_BYTES 40u
#define SWYP_PE_SCN_MEM_EXECUTE UINT32_C(0x20000000)
#define SWYP_PE_SCN_MEM_READ UINT32_C(0x40000000)
#define SWYP_PE_SCN_MEM_WRITE UINT32_C(0x80000000)

static uint16_t swyp_pe_u16(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t swyp_pe_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int swyp_pe_slice_valid(uint64_t offset, uint64_t length, uint64_t image_size) {
    return offset <= image_size && length <= image_size - offset;
}

static int swyp_pe_align_up(uint64_t value, uint64_t alignment, uint64_t *aligned) {
    uint64_t mask = alignment - 1u;
    if (aligned == NULL || alignment == 0u || (alignment & mask) != 0u || value > UINT64_MAX - mask) {
        return 0;
    }
    *aligned = (value + mask) & ~mask;
    return 1;
}

static SwypStatus swyp_pe_insert_range(SwypKernelIdentityRange *ranges, uint32_t capacity, uint32_t *count,
                                       SwypKernelIdentityRange range) {
    uint64_t range_end;
    uint32_t position = 0u;
    uint32_t i;
    if (ranges == NULL || count == NULL || range.length == 0u ||
        (range.base & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u ||
        (range.length & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u || range.length - 1u > UINT64_MAX - range.base) {
        return SWYP_ERR_INVALID;
    }
    range_end = range.base + range.length;
    while (position < *count && ranges[position].base < range.base) {
        position += 1u;
    }
    if (position > 0u) {
        uint64_t previous_end = ranges[position - 1u].base + ranges[position - 1u].length;
        if (range.base < previous_end) {
            return SWYP_ERR_DENIED;
        }
        if (range.base == previous_end && ranges[position - 1u].flags == range.flags) {
            ranges[position - 1u].length += range.length;
            return SWYP_OK;
        }
    }
    if (position < *count) {
        if (range_end > ranges[position].base) {
            return SWYP_ERR_DENIED;
        }
        if (range_end == ranges[position].base && ranges[position].flags == range.flags) {
            ranges[position].base = range.base;
            ranges[position].length += range.length;
            return SWYP_OK;
        }
    }
    if (*count >= capacity) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = *count; i > position; --i) {
        ranges[i] = ranges[i - 1u];
    }
    ranges[position] = range;
    *count += 1u;
    return SWYP_OK;
}

SwypStatus swyp_pe_collect_identity_ranges(const void *image_base, uint64_t image_size,
                                           SwypKernelIdentityRange *ranges, uint32_t range_capacity,
                                           uint32_t *range_count) {
    const uint8_t *image = (const uint8_t *)image_base;
    uint64_t base = (uint64_t)(uintptr_t)image_base;
    uint32_t pe_offset;
    uint16_t section_count;
    uint16_t optional_size;
    uint64_t optional_offset;
    uint64_t section_offset;
    uint32_t size_of_image;
    uint32_t size_of_headers;
    uint64_t header_bytes;
    uint32_t i;
    if (image == NULL || ranges == NULL || range_count == NULL || range_capacity == 0u || image_size < 0x100u ||
        (base & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    *range_count = 0u;
    if (swyp_pe_u16(image) != SWYP_PE_DOS_MAGIC || !swyp_pe_slice_valid(0x3cu, 4u, image_size)) {
        return SWYP_ERR_CORRUPT;
    }
    pe_offset = swyp_pe_u32(image + 0x3cu);
    if (!swyp_pe_slice_valid(pe_offset, 24u, image_size) || swyp_pe_u32(image + pe_offset) != SWYP_PE_SIGNATURE) {
        return SWYP_ERR_CORRUPT;
    }
    section_count = swyp_pe_u16(image + pe_offset + 6u);
    optional_size = swyp_pe_u16(image + pe_offset + 20u);
    optional_offset = (uint64_t)pe_offset + 24u;
    if (section_count == 0u || section_count > 96u || optional_size < 64u ||
        !swyp_pe_slice_valid(optional_offset, optional_size, image_size) ||
        swyp_pe_u16(image + optional_offset) != SWYP_PE32_PLUS_MAGIC) {
        return SWYP_ERR_CORRUPT;
    }
    size_of_image = swyp_pe_u32(image + optional_offset + 56u);
    size_of_headers = swyp_pe_u32(image + optional_offset + 60u);
    if (size_of_image == 0u || size_of_image > image_size || size_of_headers == 0u ||
        size_of_headers > size_of_image || !swyp_pe_align_up(size_of_headers, SWYP_X86_64_PAGE_SIZE, &header_bytes) ||
        header_bytes > image_size) {
        return SWYP_ERR_CORRUPT;
    }
    if (swyp_pe_insert_range(ranges, range_capacity, range_count,
                             (SwypKernelIdentityRange){base, header_bytes, SWYP_MMU_READ | SWYP_MMU_GLOBAL}) != SWYP_OK) {
        return SWYP_ERR_NO_SPACE;
    }

    section_offset = optional_offset + optional_size;
    if (!swyp_pe_slice_valid(section_offset, (uint64_t)section_count * SWYP_PE_SECTION_HEADER_BYTES, image_size)) {
        return SWYP_ERR_CORRUPT;
    }
    for (i = 0u; i < section_count; ++i) {
        const uint8_t *section = image + section_offset + (uint64_t)i * SWYP_PE_SECTION_HEADER_BYTES;
        uint32_t virtual_size = swyp_pe_u32(section + 8u);
        uint32_t virtual_address = swyp_pe_u32(section + 12u);
        uint32_t raw_size = swyp_pe_u32(section + 16u);
        uint32_t characteristics = swyp_pe_u32(section + 36u);
        uint64_t section_size = virtual_size > raw_size ? virtual_size : raw_size;
        uint64_t mapped_size;
        uint64_t flags = SWYP_MMU_READ | SWYP_MMU_GLOBAL;
        uint64_t section_base;
        SwypStatus status;
        if (section_size == 0u) {
            continue;
        }
        if ((virtual_address & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u ||
            !swyp_pe_align_up(section_size, SWYP_X86_64_PAGE_SIZE, &mapped_size) ||
            (uint64_t)virtual_address + mapped_size > size_of_image || base > UINT64_MAX - virtual_address) {
            return SWYP_ERR_CORRUPT;
        }
        if ((characteristics & SWYP_PE_SCN_MEM_WRITE) != 0u) {
            flags |= SWYP_MMU_WRITE;
        }
        if ((characteristics & SWYP_PE_SCN_MEM_EXECUTE) != 0u) {
            flags |= SWYP_MMU_EXECUTE;
        }
        if ((flags & SWYP_MMU_WRITE) != 0u && (flags & SWYP_MMU_EXECUTE) != 0u) {
            return SWYP_ERR_DENIED;
        }
        (void)characteristics;
        section_base = base + virtual_address;
        status = swyp_pe_insert_range(ranges, range_capacity, range_count,
                                      (SwypKernelIdentityRange){section_base, mapped_size, flags});
        if (status != SWYP_OK) {
            return status;
        }
    }
    return SWYP_OK;
}
