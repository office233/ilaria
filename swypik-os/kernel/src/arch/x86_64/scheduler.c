#include "swypik/arch/x86_64/scheduler.h"

static SwypStatus swyp_x86_scheduler_activate_kernel(void *context) {
    SwypX86SchedulerAddressRuntime *runtime = (SwypX86SchedulerAddressRuntime *)context;
    SwypX86KernelRoot *root;
    if (runtime == NULL || runtime->kernel_root == NULL) {
        return SWYP_ERR_INVALID;
    }
    root = runtime->kernel_root;
    if (root->active == 0u || root->failed != 0u || root->pml4_physical == 0u || root->hardware_ops == NULL ||
        root->hardware_ops->activate_root == NULL || root->hardware_ops->current_root == NULL) {
        return SWYP_ERR_DENIED;
    }
    if (root->hardware_ops->current_root(root->hardware_context) == root->pml4_physical) {
        return SWYP_OK;
    }
    return root->hardware_ops->activate_root(root->hardware_context, root->pml4_physical);
}

static SwypStatus swyp_x86_scheduler_activate_driver(void *context, uint64_t domain_id, uint64_t lease_fence) {
    SwypX86SchedulerAddressRuntime *runtime = (SwypX86SchedulerAddressRuntime *)context;
    if (runtime == NULL || runtime->driver_runtime == NULL || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    return swyp_x86_64_driver_runtime_activate_domain(runtime->driver_runtime, domain_id, lease_fence);
}

static const SwypSchedulerAddressOps swyp_x86_scheduler_ops = {
    .activate_kernel = swyp_x86_scheduler_activate_kernel,
    .activate_driver = swyp_x86_scheduler_activate_driver,
};

SwypStatus swyp_x86_scheduler_address_runtime_init(SwypX86SchedulerAddressRuntime *runtime,
                                                   SwypX86KernelRoot *kernel_root,
                                                   SwypX86DriverRuntimeManager *driver_runtime) {
    if (runtime == NULL || kernel_root == NULL || driver_runtime == NULL || kernel_root->active == 0u ||
        kernel_root->failed != 0u || kernel_root->pml4_physical == 0u ||
        driver_runtime->kernel_pml4_physical != kernel_root->pml4_physical) {
        return SWYP_ERR_INVALID;
    }
    runtime->kernel_root = kernel_root;
    runtime->driver_runtime = driver_runtime;
    return SWYP_OK;
}

const SwypSchedulerAddressOps *swyp_x86_scheduler_address_ops(void) {
    return &swyp_x86_scheduler_ops;
}
