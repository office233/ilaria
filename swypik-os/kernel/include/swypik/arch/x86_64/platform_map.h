#ifndef SWYPIK_ARCH_X86_64_PLATFORM_MAP_H
#define SWYPIK_ARCH_X86_64_PLATFORM_MAP_H

#include "swypik/arch/x86_64/kernel_root.h"
#include "swypik/arch/x86_64/native_mmu.h"

SwypStatus swyp_x86_platform_map_mmio(SwypX86KernelRoot *root, SwypX86NativeMmu *mmu,
                                      uint64_t physical_address, uint64_t length, volatile void **virtual_address);

#endif
