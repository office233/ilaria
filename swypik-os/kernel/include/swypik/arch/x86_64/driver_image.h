#ifndef SWYPIK_ARCH_X86_64_DRIVER_IMAGE_H
#define SWYPIK_ARCH_X86_64_DRIVER_IMAGE_H

#include "swypik/arch/x86_64/context.h"
#include "swypik/arch/x86_64/driver_runtime.h"

#define SWYP_X86_DRIVER_IMAGE_VERSION 1u
#define SWYP_X86_DRIVER_IMAGE_HEADER_BYTES 64u
#define SWYP_X86_DRIVER_IMAGE_SEGMENT_BYTES 48u
#define SWYP_X86_DRIVER_IMAGE_MAX_SEGMENTS 8u
#define SWYP_X86_DRIVER_IMAGE_MAX_PAGES 256u
#define SWYP_X86_DRIVER_STACK_MAX_PAGES 32u
#define SWYP_X86_DRIVER_IMAGE_BASE UINT64_C(0x0000400000000000)
#define SWYP_X86_DRIVER_STACK_TOP UINT64_C(0x0000500000000000)
#define SWYP_X86_DRIVER_INITIAL_RFLAGS UINT64_C(0x202)

enum {
    SWYP_X86_DRIVER_SEGMENT_READ = UINT64_C(1) << 0,
    SWYP_X86_DRIVER_SEGMENT_WRITE = UINT64_C(1) << 1,
    SWYP_X86_DRIVER_SEGMENT_EXECUTE = UINT64_C(1) << 2
};

typedef struct SwypX86DriverImageSegment {
    uint64_t virtual_offset;
    uint64_t file_offset;
    uint64_t file_size;
    uint64_t memory_size;
    uint64_t flags;
} SwypX86DriverImageSegment;

typedef struct SwypX86DriverImageInfo {
    uint64_t entry_rva;
    uint64_t image_span;
    uint16_t segment_count;
    uint16_t reserved0;
    uint32_t total_pages;
    SwypX86DriverImageSegment segments[SWYP_X86_DRIVER_IMAGE_MAX_SEGMENTS];
} SwypX86DriverImageInfo;

typedef struct SwypX86DriverLoadedPage {
    uint64_t virtual_address;
    uint64_t physical_address;
    uint64_t final_flags;
    uint32_t mapped;
    uint32_t reserved0;
} SwypX86DriverLoadedPage;

typedef struct SwypX86LoadedDriverImage {
    uint64_t domain_id;
    uint64_t lease_fence;
    uint64_t entry_address;
    uint64_t stack_pointer;
    uint32_t image_page_count;
    uint32_t stack_page_count;
    SwypX86DriverLoadedPage image_pages[SWYP_X86_DRIVER_IMAGE_MAX_PAGES];
    SwypX86DriverLoadedPage stack_pages[SWYP_X86_DRIVER_STACK_MAX_PAGES];
    uint32_t active;
    uint32_t reserved0;
} SwypX86LoadedDriverImage;

SwypStatus swyp_x86_driver_image_parse(const uint8_t *image, uint64_t image_bytes, SwypX86DriverImageInfo *info);
SwypStatus swyp_x86_driver_image_load(SwypX86DriverRuntimeManager *manager, uint64_t domain_id, uint64_t lease_fence,
                                      const uint8_t *image, uint64_t image_bytes, uint32_t stack_pages,
                                      SwypX86LoadedDriverImage *loaded, SwypThreadContext *initial_context);
SwypStatus swyp_x86_driver_image_unload(SwypX86DriverRuntimeManager *manager, SwypX86LoadedDriverImage *loaded);
int swyp_x86_driver_image_executable_address(const SwypX86LoadedDriverImage *loaded, uint64_t virtual_address);
int swyp_x86_driver_image_stack_pointer(const SwypX86LoadedDriverImage *loaded, uint64_t stack_pointer);

#endif
