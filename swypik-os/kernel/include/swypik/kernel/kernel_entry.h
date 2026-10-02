#ifndef SWYPIK_KERNEL_ENTRY_H
#define SWYPIK_KERNEL_ENTRY_H

#include "swypik/kernel/contracts.h"

struct SwypKernelRuntime;

SwypStatus swyp_kernel_validate_handoff(const SwypBootInfo *boot_info, const SwypPageAllocator *page_allocator);
SwypStatus swyp_kernel_validate_runtime_handoff(const SwypBootInfo *boot_info, const SwypPageAllocator *page_allocator,
                                                const struct SwypKernelRuntime *runtime);
void swyp_kernel_entry(const SwypBootInfo *boot_info, SwypPageAllocator *page_allocator) __attribute__((noreturn));
void swyp_kernel_entry_runtime(SwypBootInfo *boot_info, SwypPageAllocator *page_allocator,
                               struct SwypKernelRuntime *runtime) __attribute__((noreturn));
void swyp_kernel_halt(void) __attribute__((noreturn));

#endif
