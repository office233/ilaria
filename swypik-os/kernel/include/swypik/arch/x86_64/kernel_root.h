#ifndef SWYPIK_ARCH_X86_64_KERNEL_ROOT_H
#define SWYPIK_ARCH_X86_64_KERNEL_ROOT_H

#include "swypik/arch/x86_64/address_space.h"

#define SWYP_X86_64_KERNEL_CANONICAL_MIN UINT64_C(0xffff800000000000)
#define SWYP_X86_64_DIRECT_MAP_BASE UINT64_C(0xffff800000000000)
#define SWYP_X86_64_LARGE_PAGE_SIZE UINT64_C(0x200000)

typedef struct SwypX86KernelRoot {
    SwypPageAllocator *allocator;
    void *hardware_context;
    const SwypX86AddressSpaceHardwareOps *hardware_ops;
    uint64_t pml4_physical;
    uint64_t direct_map_base;
    uint64_t physical_limit;
    uint32_t failed;
    uint32_t active;
} SwypX86KernelRoot;

SwypStatus swyp_x86_64_kernel_root_init(SwypX86KernelRoot *root, SwypPageAllocator *allocator,
                                        void *hardware_context, const SwypX86AddressSpaceHardwareOps *hardware_ops,
                                        uint64_t direct_map_base, uint64_t physical_limit);
SwypStatus swyp_x86_64_kernel_root_map(SwypX86KernelRoot *root, uint64_t virtual_address,
                                       uint64_t physical_address, uint64_t length, uint64_t flags,
                                       int allow_large_pages);
SwypStatus swyp_x86_64_kernel_root_map_active(SwypX86KernelRoot *root, uint64_t virtual_address,
                                              uint64_t physical_address, uint64_t length, uint64_t flags,
                                              int allow_large_pages);
SwypStatus swyp_x86_64_kernel_root_unmap_active(SwypX86KernelRoot *root, uint64_t virtual_address, uint64_t length);
SwypStatus swyp_x86_64_kernel_root_map_identity(SwypX86KernelRoot *root, uint64_t physical_address, uint64_t length,
                                                uint64_t flags, int allow_large_pages);
SwypStatus swyp_x86_64_kernel_root_map_direct(SwypX86KernelRoot *root, uint64_t physical_address, uint64_t length,
                                              uint64_t flags, int allow_large_pages);
SwypStatus swyp_x86_64_kernel_root_query(const SwypX86KernelRoot *root, uint64_t virtual_address,
                                         uint64_t *physical_address, uint64_t *flags, uint64_t *page_size);
SwypStatus swyp_x86_64_kernel_root_activate(SwypX86KernelRoot *root);
SwypStatus swyp_x86_64_kernel_root_destroy(SwypX86KernelRoot *root);

#endif
