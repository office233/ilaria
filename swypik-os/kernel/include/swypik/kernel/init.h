#ifndef SWYPIK_KERNEL_INIT_H
#define SWYPIK_KERNEL_INIT_H

#include "swypik/kernel/kernel_runtime.h"

#define SWYP_INIT_DOMAIN_ID UINT64_C(1)
#define SWYP_INIT_THREAD_ID UINT64_C(1)
#define SWYP_INIT_DISPATCH_LIMIT 128u
#define SWYP_INIT_ENTRY_STACK_BASE UINT64_C(0xffffc00000001000)
#define SWYP_INIT_ENTRY_STACK_PAGES 16u

SwypStatus swyp_kernel_run_init(SwypBootInfo *boot_info, SwypKernelRuntime *runtime,
                                SwypX86PrivilegeState *privilege, const uint8_t *image);

#endif
