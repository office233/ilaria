#ifndef SWYPIK_KERNEL_TAKEOVER_H
#define SWYPIK_KERNEL_TAKEOVER_H

#include "swypik/arch/x86_64/kernel_root.h"
#include "swypik/arch/x86_64/native_mmu.h"

#define SWYP_KERNEL_TAKEOVER_MAX_DIRECT_RANGES SWYP_X86_NATIVE_MMU_MAX_RANGES
#define SWYP_KERNEL_TAKEOVER_MAX_IDENTITY_RANGES 32u

typedef struct SwypKernelPhysicalRange {
    uint64_t base;
    uint64_t length;
    uint64_t flags;
} SwypKernelPhysicalRange;

typedef struct SwypKernelIdentityRange {
    uint64_t base;
    uint64_t length;
    uint64_t flags;
} SwypKernelIdentityRange;

typedef struct SwypKernelTakeover {
    SwypX86KernelRoot root;
    SwypX86NativeMmu native_mmu;
    uint32_t prepared;
    uint32_t activated;
} SwypKernelTakeover;

SwypStatus swyp_kernel_takeover_prepare(SwypKernelTakeover *takeover, SwypPageAllocator *page_table_allocator,
                                        void *bootstrap_hardware_context,
                                        const SwypX86AddressSpaceHardwareOps *bootstrap_hardware_ops,
                                        const SwypKernelPhysicalRange *direct_ranges, uint32_t direct_range_count,
                                        const SwypKernelIdentityRange *identity_ranges, uint32_t identity_range_count);
SwypStatus swyp_kernel_takeover_activate(SwypKernelTakeover *takeover);
uint64_t swyp_kernel_takeover_root_physical(const SwypKernelTakeover *takeover);
SwypStatus swyp_kernel_takeover_confirm_external_activation(SwypKernelTakeover *takeover);
const SwypX86AddressSpaceHardwareOps *swyp_kernel_takeover_native_ops(const SwypKernelTakeover *takeover);
SwypX86NativeMmu *swyp_kernel_takeover_native_mmu(SwypKernelTakeover *takeover);
SwypStatus swyp_kernel_takeover_destroy_unactivated(SwypKernelTakeover *takeover);

#endif
