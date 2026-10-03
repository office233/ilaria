#ifndef SWYPIK_KERNEL_RUNTIME_H
#define SWYPIK_KERNEL_RUNTIME_H

#include "swypik/arch/x86_64/kernel_root.h"
#include "swypik/arch/x86_64/continuation.h"
#include "swypik/arch/x86_64/driver_image.h"
#include "swypik/arch/x86_64/driver_runtime.h"
#include "swypik/arch/x86_64/extended_state.h"
#include "swypik/arch/x86_64/irq.h"
#include "swypik/arch/x86_64/scheduler.h"
#include "swypik/arch/x86_64/syscall.h"
#include "swypik/arch/x86_64/timer.h"
#include "swypik/arch/x86_64/user_mode.h"
#include "swypik/kernel/device_broker.h"
#include "swypik/kernel/device_platform.h"
#include "swypik/kernel/driver_domain.h"

typedef struct SwypKernelRuntime {
    uint32_t initialized;
    uint32_t reserved0;
    SwypCapabilityTable capability_table;
    SwypDriverDomainManager driver_domains;
    SwypX86DriverRuntimeManager x86_driver_runtime;
    SwypX86LoadedDriverImage driver_images[SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY];
    SwypX86SchedulerAddressRuntime scheduler_address_runtime;
    SwypScheduler scheduler;
    SwypX86SyscallDispatcher syscall_dispatcher;
    SwypX86IrqDispatcher irq_dispatcher;
    SwypX86KernelContinuation driver_continuation;
    uint64_t driver_continuation_thread_id;
    uint64_t fault_thread_id;
    uint64_t fault_domain_id;
    uint64_t fault_lease_fence;
    SwypDriverFaultRecord driver_fault;
    SwypX86LapicTimer *preemption_timer;
    void *extended_state_context;
    const SwypX86ExtendedStateOps *extended_state_ops;
    struct {
        uint32_t active;
        uint32_t reserved0;
        uint64_t thread_id;
        uint64_t domain_id;
        uint64_t lease_fence;
        SwypX86FxState fx;
    } extended_states[SWYP_SCHEDULER_THREAD_CAPACITY];
    SwypDevicePlatform device_platform;
    SwypDeviceBroker device_broker;
    uint32_t scheduler_ready;
    uint32_t driver_continuation_active;
    uint32_t preemption_ready;
    uint32_t extended_state_ready;
} SwypKernelRuntime;

typedef enum SwypKernelDriverRunReason {
    SWYP_KERNEL_DRIVER_RUN_NONE = 0,
    SWYP_KERNEL_DRIVER_RUN_YIELD = 1,
    SWYP_KERNEL_DRIVER_RUN_EXIT = 2,
    SWYP_KERNEL_DRIVER_RUN_PREEMPT = 3,
    SWYP_KERNEL_DRIVER_RUN_FAULT = 4
} SwypKernelDriverRunReason;

SwypStatus swyp_kernel_runtime_init(SwypKernelRuntime *runtime, SwypPageAllocator *page_allocator,
                                    void *address_hardware_context,
                                    const SwypX86AddressSpaceHardwareOps *address_hardware_ops,
                                    SwypInterruptSource *interrupts, SwypX86Iommu *iommu, SwypX86PciEcam *pci_ecam);
SwypStatus swyp_kernel_runtime_bind_kernel_root(SwypKernelRuntime *runtime, const SwypX86KernelRoot *kernel_root);
SwypStatus swyp_kernel_runtime_open_driver_domain(SwypKernelRuntime *runtime, const SwypDeviceGraph *graph,
                                                  uint64_t node_id, uint64_t domain_id, uint64_t lease_fence,
                                                  const SwypDriverDomainPolicy *policy,
                                                  const SwypDriverDomain **out_domain,
                                                  SwypAddressSpace **out_address_space);
SwypStatus swyp_kernel_runtime_activate_driver_domain(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                      uint64_t lease_fence);
SwypStatus swyp_kernel_runtime_open_compute_domain(SwypKernelRuntime *runtime, const SwypDeviceGraph *graph,
                                                   uint64_t node_id, uint64_t domain_id, uint64_t lease_fence,
                                                   const SwypDriverDomain **out_domain,
                                                   SwypAddressSpace **out_address_space);
SwypStatus swyp_kernel_runtime_load_driver_image(SwypKernelRuntime *runtime, uint64_t domain_id, uint64_t lease_fence,
                                                 const uint8_t *image, uint64_t image_bytes, uint32_t stack_pages,
                                                 SwypThreadContext *initial_context);
SwypStatus swyp_kernel_runtime_unload_driver_image(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                   uint64_t lease_fence);
SwypStatus swyp_kernel_runtime_close_driver_domain(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                   uint64_t lease_fence);
SwypDeviceBroker *swyp_kernel_runtime_device_broker(SwypKernelRuntime *runtime);
SwypScheduler *swyp_kernel_runtime_scheduler(SwypKernelRuntime *runtime);
SwypStatus swyp_kernel_runtime_bind_syscall_idt(SwypKernelRuntime *runtime, SwypX86PrivilegeState *privilege);
SwypStatus swyp_kernel_runtime_bind_preemption_timer(SwypKernelRuntime *runtime, SwypX86LapicTimer *timer,
                                                     SwypX86PrivilegeState *privilege);
SwypStatus swyp_kernel_runtime_bind_extended_state(SwypKernelRuntime *runtime, void *context,
                                                   const SwypX86ExtendedStateOps *ops);
SwypStatus swyp_kernel_runtime_restore_current_driver_extended_state(SwypKernelRuntime *runtime);
SwypStatus swyp_kernel_runtime_run_current_driver(SwypKernelRuntime *runtime, SwypKernelDriverRunReason *reason);
SwypStatus swyp_kernel_runtime_prepare_current_driver_launch(SwypKernelRuntime *runtime, SwypX86UserLaunch *launch);
SwypStatus swyp_kernel_runtime_capture_current_driver_trap(SwypKernelRuntime *runtime, const SwypX86TrapFrame *frame);
SwypStatus swyp_kernel_runtime_admit_fault_task(SwypKernelRuntime *runtime, uint64_t thread_id,
                                                uint64_t domain_id, uint64_t lease_fence);
SwypStatus swyp_kernel_runtime_stop_current_driver_fault(SwypKernelRuntime *runtime, const SwypX86TrapFrame *frame,
                                                         uint64_t fault_address);
SwypStatus swyp_kernel_runtime_validate_fault_cleanup(const SwypKernelRuntime *runtime);
void swyp_kernel_runtime_enter_current_driver(SwypKernelRuntime *runtime) __attribute__((noreturn));

#endif
