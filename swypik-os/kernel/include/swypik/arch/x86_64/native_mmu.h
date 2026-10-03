#ifndef SWYPIK_ARCH_X86_64_NATIVE_MMU_H
#define SWYPIK_ARCH_X86_64_NATIVE_MMU_H

#include "swypik/arch/x86_64/address_space.h"

#define SWYP_X86_NATIVE_MMU_MAX_RANGES 256u

typedef struct SwypX86NativeRange {
    uint64_t base;
    uint64_t length;
} SwypX86NativeRange;

typedef struct SwypX86NativeMmu {
    uint64_t direct_map_base;
    uint64_t physical_limit;
    uint32_t range_count;
    uint32_t reserved0;
    SwypX86NativeRange ranges[SWYP_X86_NATIVE_MMU_MAX_RANGES];
} SwypX86NativeMmu;

SwypStatus swyp_x86_native_mmu_init(SwypX86NativeMmu *mmu, uint64_t direct_map_base, uint64_t physical_limit);
SwypStatus swyp_x86_native_mmu_init_sparse(SwypX86NativeMmu *mmu, uint64_t direct_map_base, uint64_t physical_limit);
SwypStatus swyp_x86_native_mmu_extend_limit(SwypX86NativeMmu *mmu, uint64_t physical_limit);
SwypStatus swyp_x86_native_mmu_add_range(SwypX86NativeMmu *mmu, uint64_t base, uint64_t length);
SwypStatus swyp_x86_native_mmu_remove_range(SwypX86NativeMmu *mmu, uint64_t base, uint64_t length);
const SwypX86AddressSpaceHardwareOps *swyp_x86_native_mmu_ops(void);

#endif
