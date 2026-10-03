#ifndef SWYPIK_ARCH_X86_64_ADDRESS_SPACE_H
#define SWYPIK_ARCH_X86_64_ADDRESS_SPACE_H

#include "swypik/kernel/contracts.h"

#define SWYP_X86_64_PAGE_SHIFT 12u
#define SWYP_X86_64_PAGE_SIZE UINT64_C(4096)
#define SWYP_X86_64_USER_CANONICAL_MAX UINT64_C(0x00007fffffffffff)
#define SWYP_X86_64_PML4_ENTRIES 512u
#define SWYP_X86_64_SHARED_PML4_WORDS (SWYP_X86_64_PML4_ENTRIES / 64u)

typedef struct SwypX86AddressSpaceHardwareOps {
    void *(*physical_to_virtual)(void *context, uint64_t physical_address);
    SwypStatus (*activate_root)(void *context, uint64_t pml4_physical);
    uint64_t (*current_root)(void *context);
    void (*invalidate_page)(void *context, uint64_t virtual_address);
} SwypX86AddressSpaceHardwareOps;

typedef struct SwypX86AddressSpace {
    SwypAddressSpace contract;
    SwypPageAllocator *allocator;
    void *hardware_context;
    const SwypX86AddressSpaceHardwareOps *hardware_ops;
    uint64_t domain_id;
    uint64_t pml4_physical;
    uint32_t failed;
    uint32_t reserved0;
    uint64_t shared_pml4_bitmap[SWYP_X86_64_SHARED_PML4_WORDS];
} SwypX86AddressSpace;

SwypStatus swyp_x86_64_address_space_init(SwypX86AddressSpace *space, SwypPageAllocator *allocator,
                                          void *hardware_context, const SwypX86AddressSpaceHardwareOps *hardware_ops,
                                          uint64_t domain_id);
SwypAddressSpace *swyp_x86_64_address_space_contract(SwypX86AddressSpace *space);
SwypStatus swyp_x86_64_address_space_inherit_supervisor_root(SwypX86AddressSpace *space,
                                                             uint64_t source_pml4_physical);
int swyp_x86_64_address_space_pml4_shared(const SwypX86AddressSpace *space, uint16_t index);
SwypStatus swyp_x86_64_address_space_query(const SwypX86AddressSpace *space, uint64_t virtual_address,
                                           uint64_t *physical_address, uint64_t *flags);
SwypStatus swyp_x86_64_address_space_destroy(SwypX86AddressSpace *space);

#endif
