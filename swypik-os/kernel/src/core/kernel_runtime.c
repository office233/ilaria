#include "swypik/kernel/kernel_runtime.h"
#include "swypik/kernel/kernel_entry.h"
#include "swypik/arch/x86_64/vtd_router.h"

/* Zero in place rather than assigning a compound literal: large literals are
   materialized as stack temporaries at -O0 and the boot stack is 64 KiB. */
static void swyp_kernel_runtime_zero(void *pointer, size_t bytes) {
    uint8_t *out = (uint8_t *)pointer;
    size_t i;
    for (i = 0u; i < bytes; ++i) {
        out[i] = 0u;
    }
}

static int swyp_kernel_runtime_ready(const SwypKernelRuntime *runtime) {
    return runtime != NULL && runtime->initialized != 0u;
}

static void swyp_kernel_runtime_clear_extended_slot(SwypKernelRuntime *runtime, uint32_t index) {
    uint32_t i;
    if (runtime == NULL || index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
        return;
    }
    runtime->extended_states[index].active = 0u;
    runtime->extended_states[index].reserved0 = 0u;
    runtime->extended_states[index].thread_id = 0u;
    runtime->extended_states[index].domain_id = 0u;
    runtime->extended_states[index].lease_fence = 0u;
    for (i = 0u; i < SWYP_X86_FX_STATE_BYTES; ++i) {
        runtime->extended_states[index].fx.bytes[i] = 0u;
    }
}

static uint32_t swyp_kernel_runtime_extended_slot_index(SwypKernelRuntime *runtime, uint64_t thread_id,
                                                         uint64_t domain_id, uint64_t lease_fence, int create) {
    uint32_t i;
    uint32_t free_index = SWYP_SCHEDULER_THREAD_CAPACITY;
    if (runtime == NULL || thread_id == 0u || domain_id == 0u || lease_fence == 0u) {
        return SWYP_SCHEDULER_THREAD_CAPACITY;
    }
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        if (runtime->extended_states[i].active != 0u && runtime->extended_states[i].thread_id == thread_id &&
            runtime->extended_states[i].domain_id == domain_id &&
            runtime->extended_states[i].lease_fence == lease_fence) {
            return i;
        }
        if (runtime->extended_states[i].active == 0u && free_index == SWYP_SCHEDULER_THREAD_CAPACITY) {
            free_index = i;
        }
    }
    if (!create || free_index == SWYP_SCHEDULER_THREAD_CAPACITY) {
        return SWYP_SCHEDULER_THREAD_CAPACITY;
    }
    swyp_kernel_runtime_clear_extended_slot(runtime, free_index);
    runtime->extended_states[free_index].active = 1u;
    runtime->extended_states[free_index].thread_id = thread_id;
    runtime->extended_states[free_index].domain_id = domain_id;
    runtime->extended_states[free_index].lease_fence = lease_fence;
    swyp_x86_fx_state_init_default(&runtime->extended_states[free_index].fx);
    return free_index;
}

static void swyp_kernel_runtime_clear_extended_epoch(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                      uint64_t lease_fence) {
    uint32_t i;
    if (runtime == NULL) {
        return;
    }
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        if (runtime->extended_states[i].active != 0u && runtime->extended_states[i].domain_id == domain_id &&
            runtime->extended_states[i].lease_fence == lease_fence) {
            swyp_kernel_runtime_clear_extended_slot(runtime, i);
        }
    }
}

static SwypStatus swyp_kernel_runtime_timer_tick(void *context, SwypX86TrapFrame *frame, int *resume_user) {
    SwypKernelRuntime *runtime = (SwypKernelRuntime *)context;
    const SwypSchedulerThread *thread;
    int preempt_requested = 0;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || frame == NULL || resume_user == NULL ||
        runtime->scheduler_ready == 0u || runtime->driver_continuation_active == 0u) {
        return SWYP_ERR_INVALID;
    }
    thread = swyp_scheduler_current(&runtime->scheduler);
    if (thread == NULL || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER ||
        runtime->driver_continuation_thread_id != thread->id || !swyp_x86_trap_from_user(frame)) {
        return SWYP_ERR_DENIED;
    }
    status = swyp_kernel_runtime_capture_current_driver_trap(runtime, frame);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_scheduler_tick(&runtime->scheduler, &preempt_requested);
    if (status != SWYP_OK) {
        return status;
    }
    if (!preempt_requested) {
        *resume_user = 1;
        return SWYP_OK;
    }
    *resume_user = 0;
    status = swyp_scheduler_repatriate_kernel(&runtime->scheduler);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_x86_kernel_continuation_resume(&runtime->driver_continuation, SWYP_KERNEL_DRIVER_RUN_PREEMPT);
}

static const SwypDeviceNode *swyp_kernel_runtime_graph_node(const SwypDeviceGraph *graph, uint64_t node_id) {
    uint16_t i;
    if (graph == NULL || node_id == 0u) {
        return NULL;
    }
    for (i = 0u; i < graph->node_count; ++i) {
        if (graph->nodes[i].id == node_id) {
            return &graph->nodes[i];
        }
    }
    return NULL;
}

static SwypStatus swyp_kernel_runtime_authorize_rmrr(SwypKernelRuntime *runtime, const SwypDeviceGraph *graph,
                                                      uint64_t node_id, uint64_t domain_id, uint64_t requester_aux,
                                                      int *authorized) {
    SwypX86Iommu *iommu;
    SwypX86VtdRouter *router;
    uint64_t base = 0u;
    uint64_t limit = 0u;
    uint64_t length;
    uint16_t i;
    SwypStatus status;
    if (authorized == NULL) {
        return SWYP_ERR_INVALID;
    }
    *authorized = 0;
    if (runtime == NULL || graph == NULL || runtime->x86_driver_runtime.iommu == NULL) {
        return SWYP_OK;
    }
    iommu = runtime->x86_driver_runtime.iommu;
    if (iommu->hardware_ops != swyp_x86_vtd_router_iommu_ops() || iommu->hardware_context == NULL) {
        return SWYP_OK;
    }
    router = (SwypX86VtdRouter *)iommu->hardware_context;
    status = swyp_x86_vtd_router_reserved_for_requester(router, requester_aux, &base, &limit);
    if (status == SWYP_ERR_NOT_FOUND) {
        return SWYP_OK;
    }
    if (status != SWYP_OK || limit == UINT64_MAX || limit < base) {
        return status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
    }
    length = limit - base + 1u;
    if ((base & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) != 0u ||
        (length & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_UNSUPPORTED;
    }
    for (i = 0u; i < graph->resource_count; ++i) {
        const SwypDeviceResource *resource = &graph->resources[i];
        if (resource->node_id == node_id && resource->kind == SWYP_DEVICE_RESOURCE_SHARED_MEMORY &&
            resource->start == base && resource->length == length) {
            status = swyp_x86_vtd_router_authorize_rmrr(router, domain_id, node_id, requester_aux, base, length);
            if (status == SWYP_OK) {
                *authorized = 1;
            }
            return status;
        }
    }
    return SWYP_ERR_DENIED;
}

static SwypStatus swyp_kernel_runtime_attach_iommu_device(SwypKernelRuntime *runtime, const SwypDeviceGraph *graph,
                                                           uint64_t node_id, uint64_t domain_id,
                                                           uint64_t lease_fence, int *attached) {
    const SwypDeviceNode *node;
    uint64_t requester_aux = 0u;
    int has_dma = 0;
    int has_config = 0;
    int rmrr_authorized = 0;
    uint16_t i;
    if (attached == NULL) {
        return SWYP_ERR_INVALID;
    }
    *attached = 0;
    if (runtime == NULL || runtime->x86_driver_runtime.iommu == NULL ||
        runtime->x86_driver_runtime.iommu->hardware_ops == NULL ||
        runtime->x86_driver_runtime.iommu->hardware_ops->attach_device == NULL) {
        return SWYP_OK;
    }
    node = swyp_kernel_runtime_graph_node(graph, node_id);
    if (node == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    if (node->bus != SWYP_DEVICE_BUS_PCI) {
        return SWYP_OK;
    }
    for (i = 0u; i < graph->resource_count; ++i) {
        const SwypDeviceResource *resource = &graph->resources[i];
        if (resource->node_id != node_id) {
            continue;
        }
        if (resource->kind == SWYP_DEVICE_RESOURCE_DMA) {
            has_dma = 1;
        } else if (resource->kind == SWYP_DEVICE_RESOURCE_CONFIG) {
            if (has_config && resource->aux != requester_aux) {
                return SWYP_ERR_CORRUPT;
            }
            requester_aux = resource->aux;
            has_config = 1;
        }
    }
    if (!has_dma) {
        return SWYP_OK;
    }
    if (!has_config) {
        return SWYP_ERR_CORRUPT;
    }
    {
        SwypStatus status = swyp_kernel_runtime_authorize_rmrr(runtime, graph, node_id, domain_id, requester_aux,
                                                               &rmrr_authorized);
        if (status != SWYP_OK) {
            return status;
        }
    }
    {
        SwypStatus status = swyp_x86_iommu_attach_device(runtime->x86_driver_runtime.iommu, domain_id, lease_fence,
                                                         node_id, requester_aux);
        if (status != SWYP_OK) {
            if (rmrr_authorized != 0 && runtime->x86_driver_runtime.iommu->hardware_ops == swyp_x86_vtd_router_iommu_ops()) {
                SwypX86VtdRouter *router = (SwypX86VtdRouter *)runtime->x86_driver_runtime.iommu->hardware_context;
                SwypStatus cancel = swyp_x86_vtd_router_cancel_rmrr_authorization(router, domain_id, node_id,
                                                                                  requester_aux);
                if (cancel != SWYP_OK && cancel != SWYP_ERR_NOT_FOUND) {
                    return SWYP_ERR_CORRUPT;
                }
            }
            return status;
        }
    }
    *attached = 1;
    return SWYP_OK;
}

static SwypStatus swyp_kernel_runtime_detach_iommu_epoch(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                          uint64_t lease_fence) {
    SwypX86Iommu *iommu;
    uint32_t i;
    if (runtime == NULL || runtime->x86_driver_runtime.iommu == NULL) {
        return SWYP_OK;
    }
    iommu = runtime->x86_driver_runtime.iommu;
    for (i = 0u; i < SWYP_X86_IOMMU_DEVICE_CAPACITY; ++i) {
        SwypX86IommuDeviceBinding *binding = &iommu->devices[i];
        if (binding->active == 0u || binding->domain_id != domain_id || binding->lease_fence != lease_fence) {
            continue;
        }
        {
            SwypStatus status = swyp_x86_iommu_detach_device(iommu, domain_id, lease_fence, binding->device_id);
            if (status != SWYP_OK) {
                return status;
            }
        }
    }
    return SWYP_OK;
}

static SwypStatus swyp_kernel_runtime_syscall(void *context, uint64_t number, const uint64_t args[6],
                                              SwypX86TrapFrame *frame, uint64_t *result) {
    SwypKernelRuntime *runtime = (SwypKernelRuntime *)context;
    const SwypSchedulerThread *thread;
    (void)args;
    if (!swyp_kernel_runtime_ready(runtime) || frame == NULL || result == NULL || runtime->scheduler_ready == 0u) {
        return SWYP_ERR_INVALID;
    }
    thread = swyp_scheduler_current(&runtime->scheduler);
    if (thread == NULL || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER || thread->domain_id == 0u ||
        thread->lease_fence == 0u) {
        return SWYP_ERR_DENIED;
    }
    switch (number) {
    case SWYP_X86_SYSCALL_ABI_VERSION:
        *result = SWYP_KERNEL_ABI_VERSION;
        return SWYP_OK;
    case SWYP_X86_SYSCALL_THREAD_ID:
        *result = thread->id;
        return SWYP_OK;
    case SWYP_X86_SYSCALL_DOMAIN_ID:
        *result = thread->domain_id;
        return SWYP_OK;
    case SWYP_X86_SYSCALL_LEASE_FENCE:
        *result = thread->lease_fence;
        return SWYP_OK;
    case SWYP_X86_SYSCALL_IRQ_NEXT: {
        uint32_t vector = 0u;
        uint32_t source_id = 0u;
        uint32_t i;
        SwypStatus status = swyp_x86_irq_next_pending(&runtime->irq_dispatcher, thread->domain_id,
                                                      thread->lease_fence, &vector, &source_id);
        if (status != SWYP_OK) {
            return status;
        }
        for (i = 0u; i < SWYP_DEVICE_PLATFORM_RECORD_CAPACITY; ++i) {
            const SwypDevicePlatformRecord *record = &runtime->device_platform.records[i];
            if (record->active != 0u && record->kind == SWYP_DEVICE_PLATFORM_RECORD_IRQ &&
                record->domain_id == thread->domain_id && record->lease_fence == thread->lease_fence &&
                record->irq_source == source_id && record->irq_vector == vector) {
                SwypDeviceBrokerHandle handle = 0u;
                status = swyp_device_broker_irq_handle_for_backend(&runtime->device_broker, thread->domain_id,
                                                                   thread->lease_fence, (uint64_t)i + 1u, &handle);
                if (status != SWYP_OK) {
                    return status;
                }
                *result = handle;
                return SWYP_OK;
            }
        }
        return SWYP_ERR_CORRUPT;
    }
    case SWYP_X86_SYSCALL_IRQ_ACK: {
        SwypDeviceBrokerHandle handle = args[0];
        uint64_t backend_token = 0u;
        SwypDevicePlatformRecord *platform_record;
        SwypStatus status = swyp_device_broker_irq_backend_token(&runtime->device_broker, thread->domain_id,
                                                                 thread->lease_fence, handle, &backend_token);
        if (status != SWYP_OK || backend_token == 0u || backend_token > SWYP_DEVICE_PLATFORM_RECORD_CAPACITY) {
            return status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
        }
        platform_record = &runtime->device_platform.records[backend_token - 1u];
        if (platform_record->active == 0u || platform_record->kind != SWYP_DEVICE_PLATFORM_RECORD_IRQ ||
            platform_record->domain_id != thread->domain_id || platform_record->lease_fence != thread->lease_fence) {
            return SWYP_ERR_DENIED;
        }
        status = swyp_x86_irq_is_pending(&runtime->irq_dispatcher, thread->domain_id, thread->lease_fence,
                                         platform_record->irq_vector);
        if (status != SWYP_OK) {
            return status;
        }
        status = swyp_device_broker_ack_irq(&runtime->device_broker, thread->domain_id, thread->lease_fence, handle);
        if (status != SWYP_OK) {
            return status;
        }
        status = swyp_x86_irq_complete(&runtime->irq_dispatcher, thread->domain_id, thread->lease_fence,
                                       platform_record->irq_vector);
        if (status != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
        *result = 0u;
        return SWYP_OK;
    }
    case SWYP_X86_SYSCALL_YIELD:
    case SWYP_X86_SYSCALL_EXIT: {
        SwypStatus status;
        uint64_t thread_id = thread->id;
        if (runtime->driver_continuation_active == 0u || runtime->driver_continuation_thread_id != thread_id) {
            return SWYP_ERR_DENIED;
        }
        frame->rax = 0u;
        status = swyp_kernel_runtime_capture_current_driver_trap(runtime, frame);
        if (status != SWYP_OK) {
            return status;
        }
        if (number == SWYP_X86_SYSCALL_YIELD) {
            status = swyp_scheduler_yield_current(&runtime->scheduler);
        } else {
            status = swyp_scheduler_stop(&runtime->scheduler, thread_id);
        }
        if (status != SWYP_OK) {
            return status;
        }
        status = swyp_scheduler_repatriate_kernel(&runtime->scheduler);
        if (status != SWYP_OK) {
            return status;
        }
        swyp_x86_kernel_continuation_resume(&runtime->driver_continuation,
                                            number == SWYP_X86_SYSCALL_YIELD ? SWYP_KERNEL_DRIVER_RUN_YIELD
                                                                            : SWYP_KERNEL_DRIVER_RUN_EXIT);
    }
    default:
        return SWYP_ERR_UNSUPPORTED;
    }
}

static SwypX86LoadedDriverImage *swyp_kernel_runtime_find_image(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                                uint64_t lease_fence) {
    uint32_t i;
    if (runtime == NULL) {
        return NULL;
    }
    for (i = 0u; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
        SwypX86LoadedDriverImage *image = &runtime->driver_images[i];
        if (image->active != 0u && image->domain_id == domain_id && image->lease_fence == lease_fence) {
            return image;
        }
    }
    return NULL;
}

static SwypX86LoadedDriverImage *swyp_kernel_runtime_free_image(SwypKernelRuntime *runtime) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
        if (runtime->driver_images[i].active == 0u) {
            return &runtime->driver_images[i];
        }
    }
    return NULL;
}

SwypStatus swyp_kernel_runtime_init(SwypKernelRuntime *runtime, SwypPageAllocator *page_allocator,
                                    void *address_hardware_context,
                                    const SwypX86AddressSpaceHardwareOps *address_hardware_ops,
                                    SwypInterruptSource *interrupts, SwypX86Iommu *iommu, SwypX86PciEcam *pci_ecam) {
    if (runtime == NULL || page_allocator == NULL || page_allocator->ops == NULL ||
        page_allocator->ops->allocate == NULL || page_allocator->ops->release == NULL ||
        address_hardware_ops == NULL || address_hardware_ops->physical_to_virtual == NULL ||
        address_hardware_ops->activate_root == NULL || address_hardware_ops->current_root == NULL ||
        address_hardware_ops->invalidate_page == NULL || interrupts == NULL || interrupts->ops == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->initialized = 0u;
    runtime->reserved0 = 0u;
    runtime->scheduler_ready = 0u;
    runtime->driver_continuation_active = 0u;
    runtime->driver_continuation_thread_id = 0u;
    runtime->preemption_timer = NULL;
    runtime->extended_state_context = NULL;
    runtime->extended_state_ops = NULL;
    runtime->preemption_ready = 0u;
    runtime->extended_state_ready = 0u;
    runtime->driver_continuation = (SwypX86KernelContinuation){0};
    {
        uint32_t i;
        for (i = 0u; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
            runtime->driver_images[i] = (SwypX86LoadedDriverImage){0};
        }
        for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
            swyp_kernel_runtime_clear_extended_slot(runtime, i);
        }
    }
    swyp_capability_table_init(&runtime->capability_table);
    swyp_driver_domain_manager_init(&runtime->driver_domains, &runtime->capability_table);
    swyp_x86_64_driver_runtime_init(&runtime->x86_driver_runtime, page_allocator, address_hardware_context,
                                    address_hardware_ops);
    swyp_x86_64_driver_runtime_set_iommu(&runtime->x86_driver_runtime, iommu);
    swyp_x86_64_driver_runtime_set_pci_ecam(&runtime->x86_driver_runtime, pci_ecam);
    swyp_device_platform_init(&runtime->device_platform, &runtime->x86_driver_runtime,
                              swyp_x86_64_driver_runtime_platform_ops(), interrupts, SWYP_X86_64_PAGE_SHIFT);
    swyp_device_broker_init(&runtime->device_broker, &runtime->driver_domains, &runtime->device_platform,
                            swyp_device_platform_broker_ops());
    swyp_x86_syscall_dispatcher_init(&runtime->syscall_dispatcher, runtime, swyp_kernel_runtime_syscall);
    swyp_x86_irq_dispatcher_init(&runtime->irq_dispatcher, &runtime->x86_driver_runtime, interrupts);
    runtime->initialized = 1u;
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_bind_kernel_root(SwypKernelRuntime *runtime, const SwypX86KernelRoot *kernel_root) {
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || kernel_root == NULL || kernel_root->active == 0u ||
        kernel_root->failed != 0u || kernel_root->pml4_physical == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (runtime->scheduler_ready != 0u) {
        return SWYP_ERR_DENIED;
    }
    status = swyp_x86_64_driver_runtime_set_kernel_root(&runtime->x86_driver_runtime, kernel_root->pml4_physical);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_scheduler_address_runtime_init(&runtime->scheduler_address_runtime,
                                                     (SwypX86KernelRoot *)(uintptr_t)kernel_root,
                                                     &runtime->x86_driver_runtime);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_scheduler_init(&runtime->scheduler, &runtime->scheduler_address_runtime, swyp_x86_scheduler_address_ops());
    runtime->scheduler_ready = 1u;
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_open_driver_domain(SwypKernelRuntime *runtime, const SwypDeviceGraph *graph,
                                                  uint64_t node_id, uint64_t domain_id, uint64_t lease_fence,
                                                  const SwypDriverDomainPolicy *policy,
                                                  const SwypDriverDomain **out_domain,
                                                  SwypAddressSpace **out_address_space) {
    SwypAddressSpace *address_space = NULL;
    int iommu_attached = 0;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || graph == NULL || policy == NULL || out_domain == NULL ||
        out_address_space == NULL || node_id == 0u || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    *out_domain = NULL;
    *out_address_space = NULL;
    status = swyp_x86_64_driver_runtime_open_domain(&runtime->x86_driver_runtime, domain_id, lease_fence,
                                                    &address_space);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_driver_domain_open(&runtime->driver_domains, graph, node_id, domain_id, lease_fence, policy,
                                     out_domain);
    if (status != SWYP_OK) {
        SwypStatus rollback = swyp_x86_64_driver_runtime_close_domain(&runtime->x86_driver_runtime, domain_id,
                                                                      lease_fence);
        if (rollback != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
        return status;
    }
    status = swyp_kernel_runtime_attach_iommu_device(runtime, graph, node_id, domain_id, lease_fence,
                                                     &iommu_attached);
    if (status != SWYP_OK) {
        SwypStatus quiesce_status = swyp_driver_domain_quiesce(&runtime->driver_domains, domain_id, lease_fence);
        SwypStatus revoke_status = quiesce_status == SWYP_OK
                                       ? swyp_driver_domain_revoke(&runtime->driver_domains, domain_id, lease_fence)
                                       : quiesce_status;
        SwypStatus close_status = swyp_x86_64_driver_runtime_close_domain(&runtime->x86_driver_runtime, domain_id,
                                                                          lease_fence);
        *out_domain = NULL;
        if (revoke_status != SWYP_OK || close_status != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
        return status;
    }
    (void)iommu_attached;
    *out_address_space = address_space;
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_activate_driver_domain(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                      uint64_t lease_fence) {
    if (!swyp_kernel_runtime_ready(runtime) || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    return swyp_x86_64_driver_runtime_activate_domain(&runtime->x86_driver_runtime, domain_id, lease_fence);
}

SwypStatus swyp_kernel_runtime_load_driver_image(SwypKernelRuntime *runtime, uint64_t domain_id, uint64_t lease_fence,
                                                 const uint8_t *image, uint64_t image_bytes, uint32_t stack_pages,
                                                 SwypThreadContext *initial_context) {
    SwypX86LoadedDriverImage *slot;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || domain_id == 0u || lease_fence == 0u || image == NULL ||
        image_bytes == 0u || initial_context == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_kernel_runtime_find_image(runtime, domain_id, lease_fence) != NULL) {
        return SWYP_ERR_DENIED;
    }
    if (swyp_x86_64_driver_runtime_x86_space(&runtime->x86_driver_runtime, domain_id, lease_fence) == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    slot = swyp_kernel_runtime_free_image(runtime);
    if (slot == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    swyp_kernel_runtime_zero(slot, sizeof(*slot));
    status = swyp_x86_driver_image_load(&runtime->x86_driver_runtime, domain_id, lease_fence, image, image_bytes,
                                        stack_pages, slot, initial_context);
    if (status != SWYP_OK && slot->active == 0u) {
        swyp_kernel_runtime_zero(slot, sizeof(*slot));
    }
    return status;
}

SwypStatus swyp_kernel_runtime_unload_driver_image(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                   uint64_t lease_fence) {
    SwypX86LoadedDriverImage *image;
    if (!swyp_kernel_runtime_ready(runtime) || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    image = swyp_kernel_runtime_find_image(runtime, domain_id, lease_fence);
    if (image == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    return swyp_x86_driver_image_unload(&runtime->x86_driver_runtime, image);
}

SwypStatus swyp_kernel_runtime_close_driver_domain(SwypKernelRuntime *runtime, uint64_t domain_id,
                                                   uint64_t lease_fence) {
    SwypStatus broker_status;
    SwypStatus runtime_status;
    int running_thread_stopped = 0;
    uint32_t removed_threads = 0u;
    if (!swyp_kernel_runtime_ready(runtime) || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (runtime->scheduler_ready != 0u) {
        SwypStatus scheduler_status = swyp_scheduler_stop_driver_epoch(&runtime->scheduler, domain_id, lease_fence,
                                                                       &running_thread_stopped);
        if (scheduler_status != SWYP_OK && scheduler_status != SWYP_ERR_NOT_FOUND) {
            return scheduler_status;
        }
        if (running_thread_stopped) {
            scheduler_status = swyp_scheduler_repatriate_kernel(&runtime->scheduler);
            if (scheduler_status != SWYP_OK) {
                return scheduler_status;
            }
        }
        scheduler_status = swyp_scheduler_remove_driver_epoch(&runtime->scheduler, domain_id, lease_fence,
                                                               &removed_threads);
        if (scheduler_status != SWYP_OK && scheduler_status != SWYP_ERR_NOT_FOUND) {
            return scheduler_status;
        }
        (void)removed_threads;
    }
    {
        SwypX86LoadedDriverImage *image = swyp_kernel_runtime_find_image(runtime, domain_id, lease_fence);
        if (image != NULL) {
            SwypStatus image_status = swyp_x86_driver_image_unload(&runtime->x86_driver_runtime, image);
            if (image_status != SWYP_OK) {
                return image_status;
            }
        }
    }
    broker_status = swyp_device_broker_revoke_domain(&runtime->device_broker, domain_id, lease_fence);
    if (broker_status != SWYP_OK && broker_status != SWYP_ERR_NOT_FOUND) {
        return broker_status;
    }
    runtime_status = swyp_kernel_runtime_detach_iommu_epoch(runtime, domain_id, lease_fence);
    if (runtime_status != SWYP_OK) {
        return runtime_status;
    }
    runtime_status = swyp_x86_64_driver_runtime_close_domain(&runtime->x86_driver_runtime, domain_id, lease_fence);
    if (runtime_status != SWYP_OK) {
        return runtime_status;
    }
    swyp_kernel_runtime_clear_extended_epoch(runtime, domain_id, lease_fence);
    return SWYP_OK;
}

SwypDeviceBroker *swyp_kernel_runtime_device_broker(SwypKernelRuntime *runtime) {
    if (!swyp_kernel_runtime_ready(runtime)) {
        return NULL;
    }
    return &runtime->device_broker;
}

SwypScheduler *swyp_kernel_runtime_scheduler(SwypKernelRuntime *runtime) {
    if (!swyp_kernel_runtime_ready(runtime) || runtime->scheduler_ready == 0u) {
        return NULL;
    }
    return &runtime->scheduler;
}

SwypStatus swyp_kernel_runtime_bind_syscall_idt(SwypKernelRuntime *runtime, SwypX86PrivilegeState *privilege) {
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || privilege == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_syscall_bind_dispatcher(&runtime->syscall_dispatcher);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_irq_bind_dispatcher(&runtime->irq_dispatcher);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_irq_install_idt(privilege);
    if (status != SWYP_OK) {
        return status;
    }
    return swyp_x86_syscall_install_idt(privilege);
}

SwypStatus swyp_kernel_runtime_bind_preemption_timer(SwypKernelRuntime *runtime, SwypX86LapicTimer *timer,
                                                     SwypX86PrivilegeState *privilege) {
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || runtime->scheduler_ready == 0u || timer == NULL ||
        timer->initialized == 0u || privilege == NULL || privilege->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    timer->tick_context = runtime;
    timer->tick_handler = swyp_kernel_runtime_timer_tick;
    status = swyp_x86_lapic_timer_install_idt(privilege);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_x86_lapic_timer_bind(timer);
    if (status != SWYP_OK) {
        return status;
    }
    runtime->preemption_timer = timer;
    runtime->preemption_ready = 1u;
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_bind_extended_state(SwypKernelRuntime *runtime, void *context,
                                                   const SwypX86ExtendedStateOps *ops) {
    if (!swyp_kernel_runtime_ready(runtime) || ops == NULL || ops->save_fx == NULL || ops->restore_fx == NULL ||
        ops->read_fs_base == NULL || ops->read_gs_base == NULL || ops->write_fs_base == NULL ||
        ops->write_gs_base == NULL) {
        return SWYP_ERR_INVALID;
    }
    runtime->extended_state_context = context;
    runtime->extended_state_ops = ops;
    runtime->extended_state_ready = 1u;
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_restore_current_driver_extended_state(SwypKernelRuntime *runtime) {
    const SwypSchedulerThread *thread;
    const SwypX86_64ThreadContext *context;
    uint32_t slot_index;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || runtime->extended_state_ready == 0u ||
        runtime->extended_state_ops == NULL) {
        return SWYP_ERR_INVALID;
    }
    thread = swyp_scheduler_current(&runtime->scheduler);
    if (thread == NULL || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER ||
        thread->context.used_bytes != sizeof(SwypX86_64ThreadContext)) {
        return SWYP_ERR_DENIED;
    }
    slot_index = swyp_kernel_runtime_extended_slot_index(runtime, thread->id, thread->domain_id, thread->lease_fence, 1);
    if (slot_index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
        return SWYP_ERR_NO_SPACE;
    }
    context = (const SwypX86_64ThreadContext *)(const void *)thread->context.storage;
    status = runtime->extended_state_ops->write_fs_base(runtime->extended_state_context, context->fs_base);
    if (status != SWYP_OK) {
        return status;
    }
    status = runtime->extended_state_ops->write_gs_base(runtime->extended_state_context, context->gs_base);
    if (status != SWYP_OK) {
        return status;
    }
    return runtime->extended_state_ops->restore_fx(runtime->extended_state_context,
                                                    &runtime->extended_states[slot_index].fx);
}

SwypStatus swyp_kernel_runtime_run_current_driver(SwypKernelRuntime *runtime, SwypKernelDriverRunReason *reason) {
    const SwypSchedulerThread *thread;
    SwypX86UserLaunch launch;
    int64_t resumed;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || runtime->scheduler_ready == 0u || reason == NULL ||
        runtime->driver_continuation_active != 0u) {
        return SWYP_ERR_INVALID;
    }
    *reason = SWYP_KERNEL_DRIVER_RUN_NONE;
    thread = swyp_scheduler_current(&runtime->scheduler);
    if (thread == NULL || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER) {
        return SWYP_ERR_DENIED;
    }
    if (runtime->preemption_ready != 0u) {
        SwypX86LoadedDriverImage *image = swyp_kernel_runtime_find_image(runtime, thread->domain_id,
                                                                         thread->lease_fence);
        SwypX86AddressSpace *space = swyp_x86_64_driver_runtime_x86_space(&runtime->x86_driver_runtime,
                                                                          thread->domain_id,
                                                                          thread->lease_fence);
        if (image == NULL || space == NULL ||
            runtime->x86_driver_runtime.address_space_hardware_ops->current_root(
                runtime->x86_driver_runtime.hardware_context) != space->pml4_physical) {
            return SWYP_ERR_DENIED;
        }
        status = swyp_x86_user_launch_prepare_interruptible(&thread->context, 1, &launch);
        if (status == SWYP_OK && (!swyp_x86_driver_image_executable_address(image, launch.context.rip) ||
                                  !swyp_x86_driver_image_stack_pointer(image, launch.context.rsp))) {
            status = SWYP_ERR_DENIED;
        }
    } else {
        status = swyp_kernel_runtime_prepare_current_driver_launch(runtime, &launch);
    }
    if (status != SWYP_OK) {
        return status;
    }
    runtime->driver_continuation_thread_id = thread->id;
    resumed = swyp_x86_kernel_continuation_capture(&runtime->driver_continuation);
    if (resumed == 0) {
        runtime->driver_continuation_active = 1u;
        if (runtime->extended_state_ready != 0u) {
            status = swyp_kernel_runtime_restore_current_driver_extended_state(runtime);
            if (status != SWYP_OK) {
                runtime->driver_continuation_active = 0u;
                runtime->driver_continuation_thread_id = 0u;
                return status;
            }
        }
        if (runtime->preemption_ready != 0u) {
            status = swyp_x86_lapic_timer_arm_periodic(runtime->preemption_timer);
            if (status != SWYP_OK) {
                runtime->driver_continuation_active = 0u;
                runtime->driver_continuation_thread_id = 0u;
                return status;
            }
        }
        swyp_x86_enter_user(&launch);
    }
    if (runtime->preemption_ready != 0u && runtime->preemption_timer != NULL && runtime->preemption_timer->armed != 0u) {
        status = swyp_x86_lapic_timer_disarm(runtime->preemption_timer);
        if (status != SWYP_OK) {
            runtime->driver_continuation_active = 0u;
            runtime->driver_continuation_thread_id = 0u;
            return status;
        }
    }
    runtime->driver_continuation_active = 0u;
    runtime->driver_continuation_thread_id = 0u;
    if (resumed != SWYP_KERNEL_DRIVER_RUN_YIELD && resumed != SWYP_KERNEL_DRIVER_RUN_EXIT &&
        resumed != SWYP_KERNEL_DRIVER_RUN_PREEMPT) {
        return SWYP_ERR_CORRUPT;
    }
    *reason = (SwypKernelDriverRunReason)resumed;
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_prepare_current_driver_launch(SwypKernelRuntime *runtime, SwypX86UserLaunch *launch) {
    const SwypSchedulerThread *thread;
    SwypX86LoadedDriverImage *image;
    SwypX86AddressSpace *space;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || runtime->scheduler_ready == 0u || launch == NULL ||
        runtime->x86_driver_runtime.address_space_hardware_ops == NULL ||
        runtime->x86_driver_runtime.address_space_hardware_ops->current_root == NULL) {
        return SWYP_ERR_INVALID;
    }
    thread = swyp_scheduler_current(&runtime->scheduler);
    if (thread == NULL || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER || thread->domain_id == 0u ||
        thread->lease_fence == 0u) {
        return SWYP_ERR_DENIED;
    }
    image = swyp_kernel_runtime_find_image(runtime, thread->domain_id, thread->lease_fence);
    if (image == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    space = swyp_x86_64_driver_runtime_x86_space(&runtime->x86_driver_runtime, thread->domain_id,
                                                 thread->lease_fence);
    if (space == NULL || runtime->x86_driver_runtime.address_space_hardware_ops->current_root(
                             runtime->x86_driver_runtime.hardware_context) != space->pml4_physical) {
        return SWYP_ERR_DENIED;
    }
    status = swyp_x86_user_launch_prepare(&thread->context, launch);
    if (status != SWYP_OK) {
        return status;
    }
    if (!swyp_x86_driver_image_executable_address(image, launch->context.rip) ||
        !swyp_x86_driver_image_stack_pointer(image, launch->context.rsp)) {
        return SWYP_ERR_DENIED;
    }
    return SWYP_OK;
}

SwypStatus swyp_kernel_runtime_capture_current_driver_trap(SwypKernelRuntime *runtime, const SwypX86TrapFrame *frame) {
    const SwypSchedulerThread *thread;
    SwypX86LoadedDriverImage *image;
    SwypThreadContext updated;
    const SwypX86_64ThreadContext *context;
    SwypStatus status;
    if (!swyp_kernel_runtime_ready(runtime) || runtime->scheduler_ready == 0u || frame == NULL) {
        return SWYP_ERR_INVALID;
    }
    thread = swyp_scheduler_current(&runtime->scheduler);
    if (thread == NULL || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER) {
        return SWYP_ERR_DENIED;
    }
    image = swyp_kernel_runtime_find_image(runtime, thread->domain_id, thread->lease_fence);
    if (image == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    updated = thread->context;
    status = swyp_x86_user_context_capture_trap(&updated, frame);
    if (status != SWYP_OK) {
        return status;
    }
    if (runtime->extended_state_ready != 0u) {
        SwypX86_64ThreadContext *updated_x86 = (SwypX86_64ThreadContext *)(void *)updated.storage;
        uint32_t slot_index = swyp_kernel_runtime_extended_slot_index(runtime, thread->id, thread->domain_id,
                                                                      thread->lease_fence, 1);
        if (slot_index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
            return SWYP_ERR_NO_SPACE;
        }
        status = runtime->extended_state_ops->save_fx(runtime->extended_state_context,
                                                       &runtime->extended_states[slot_index].fx);
        if (status != SWYP_OK) {
            return status;
        }
        updated_x86->fs_base = runtime->extended_state_ops->read_fs_base(runtime->extended_state_context);
        updated_x86->gs_base = runtime->extended_state_ops->read_gs_base(runtime->extended_state_context);
    }
    context = (const SwypX86_64ThreadContext *)(const void *)updated.storage;
    if (!swyp_x86_driver_image_executable_address(image, context->rip) ||
        !swyp_x86_driver_image_stack_pointer(image, context->rsp)) {
        return SWYP_ERR_DENIED;
    }
    return swyp_scheduler_update_current_context(&runtime->scheduler, &updated);
}

void swyp_kernel_runtime_enter_current_driver(SwypKernelRuntime *runtime) {
    SwypX86UserLaunch launch;
    if (swyp_kernel_runtime_prepare_current_driver_launch(runtime, &launch) != SWYP_OK) {
        swyp_kernel_halt();
    }
    swyp_x86_enter_user(&launch);
}
