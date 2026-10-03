#ifndef SWYPIK_ARCH_X86_64_SCHEDULER_H
#define SWYPIK_ARCH_X86_64_SCHEDULER_H

#include "swypik/arch/x86_64/driver_runtime.h"
#include "swypik/arch/x86_64/kernel_root.h"
#include "swypik/kernel/scheduler.h"

typedef struct SwypX86SchedulerAddressRuntime {
    SwypX86KernelRoot *kernel_root;
    SwypX86DriverRuntimeManager *driver_runtime;
} SwypX86SchedulerAddressRuntime;

SwypStatus swyp_x86_scheduler_address_runtime_init(SwypX86SchedulerAddressRuntime *runtime,
                                                   SwypX86KernelRoot *kernel_root,
                                                   SwypX86DriverRuntimeManager *driver_runtime);
const SwypSchedulerAddressOps *swyp_x86_scheduler_address_ops(void);

#endif
