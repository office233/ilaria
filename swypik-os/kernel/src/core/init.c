#include "swypik/kernel/init.h"
#include "swypik/boot/uefi_init.h"

static SwypStatus swyp_kernel_run_init_task(SwypBootInfo *boot_info, SwypKernelRuntime *runtime, const uint8_t *image) {
    SwypDeviceGraph graph;
    SwypDeviceNode node = {.id = 1u, .device_class = SWYP_DEVICE_CLASS_COMPUTE, .bus = SWYP_DEVICE_BUS_PLATFORM};
    const SwypDriverDomain *domain;
    SwypAddressSpace *space;
    SwypThreadContext initial;
    SwypScheduler *scheduler;
    uint64_t selected;
    uint32_t i;
    SwypStatus status;
    if (boot_info == NULL || runtime == NULL || image == NULL || boot_info->init_image_bytes == 0u ||
        boot_info->init_image_bytes > SWYP_INIT_IMAGE_MAX_BYTES ||
        (boot_info->boot_flags & SWYP_BOOT_FLAG_INIT_IMAGE_READY) == 0u) {
        return SWYP_ERR_INVALID;
    }
    /* Untrusted init input cannot run without hardware preemption. */
    if (runtime->preemption_ready == 0u) {
        return SWYP_ERR_UNSUPPORTED;
    }
    scheduler = swyp_kernel_runtime_scheduler(runtime);
    if (scheduler == NULL) {
        return SWYP_ERR_INVALID;
    }
    swyp_device_graph_init(&graph);
    status = swyp_device_graph_add_node(&graph, &node);
    if (status != SWYP_OK) {
        return status;
    }

    status = swyp_kernel_runtime_open_compute_domain(runtime, &graph, 1u, SWYP_INIT_DOMAIN_ID, 1u,
                                                       &domain, &space);
    if (status != SWYP_OK) {
        return status;
    }
    if (domain->grant_count != 0u) {
        status = SWYP_ERR_DENIED;
        goto cleanup;
    }
    status = swyp_kernel_runtime_load_driver_image(runtime, SWYP_INIT_DOMAIN_ID, 1u, image,
                                                    boot_info->init_image_bytes, 4u, &initial);
    if (status != SWYP_OK) {
        goto cleanup;
    }
    status = swyp_scheduler_add_thread(scheduler, SWYP_INIT_THREAD_ID, SWYP_SCHEDULER_THREAD_DRIVER,
                                         SWYP_INIT_DOMAIN_ID, 1u, &initial);
    if (status != SWYP_OK) {
        goto cleanup;
    }
    status = swyp_kernel_runtime_admit_fault_task(runtime, SWYP_INIT_THREAD_ID, SWYP_INIT_DOMAIN_ID, 1u);
    if (status != SWYP_OK) {
        goto cleanup;
    }
    for (i = 0u; i < SWYP_INIT_DISPATCH_LIMIT; ++i) {
        SwypKernelDriverRunReason reason;
        status = swyp_scheduler_dispatch(scheduler, &selected);
        if (status != SWYP_OK || selected != SWYP_INIT_THREAD_ID) {
            status = status == SWYP_OK ? SWYP_ERR_CORRUPT : status;
            goto cleanup;
        }
        status = swyp_kernel_runtime_run_current_driver(runtime, &reason);
        if (status != SWYP_OK) {
            goto cleanup;
        }
        if (reason == SWYP_KERNEL_DRIVER_RUN_YIELD) {
            boot_info->init_yields += 1u;
            boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_YIELDED;
        } else if (reason == SWYP_KERNEL_DRIVER_RUN_PREEMPT) {
            boot_info->init_preemptions += 1u;
        } else if (reason == SWYP_KERNEL_DRIVER_RUN_EXIT) {
            const SwypSchedulerThread *thread = swyp_scheduler_thread(scheduler, SWYP_INIT_THREAD_ID);
            const SwypX86_64ThreadContext *context;
            if (thread == NULL || thread->state != SWYP_SCHEDULER_STATE_STOPPED ||
                thread->context.used_bytes != sizeof(SwypX86_64ThreadContext)) {
                status = SWYP_ERR_CORRUPT;
                goto cleanup;
            }
            context = (const SwypX86_64ThreadContext *)(const void *)thread->context.storage;
            boot_info->init_exit_code = context->rdi;
            boot_info->init_observed_domain = context->rsi;
            boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_EXITED;
            status = SWYP_OK;
            goto cleanup;
        } else if (reason == SWYP_KERNEL_DRIVER_RUN_FAULT) {
            const SwypDriverFaultRecord *fault = &runtime->driver_fault;
            if (fault->version != SWYP_DRIVER_FAULT_RECORD_VERSION || fault->struct_size != sizeof(*fault) ||
                fault->thread_id != SWYP_INIT_THREAD_ID || fault->domain_id != SWYP_INIT_DOMAIN_ID ||
                fault->lease_fence != 1u || fault->status != SWYP_ERR_FAULT) {
                status = SWYP_ERR_CORRUPT;
                goto cleanup;
            }
            boot_info->init_fault = *fault;
            boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_FAULTED;
            status = SWYP_ERR_FAULT;
            goto cleanup;
        } else {
            status = SWYP_ERR_CORRUPT;
            goto cleanup;
        }
    }
    status = SWYP_ERR_DENIED;
cleanup:
    {
        SwypStatus close_status = swyp_kernel_runtime_close_driver_domain(runtime, SWYP_INIT_DOMAIN_ID, 1u);
        if (close_status != SWYP_OK) {
            return close_status;
        }
        boot_info->boot_flags |= SWYP_BOOT_FLAG_INIT_CLEANED;
        if ((boot_info->boot_flags & SWYP_BOOT_FLAG_INIT_FAULTED) != 0u &&
            swyp_kernel_runtime_validate_fault_cleanup(runtime) != SWYP_OK) {
            boot_info->boot_flags &= ~SWYP_BOOT_FLAG_INIT_CLEANED;
            return SWYP_ERR_CORRUPT;
        }
    }
    return status;
}

SwypStatus swyp_kernel_run_init(SwypBootInfo *boot_info, SwypKernelRuntime *runtime,
                                SwypX86PrivilegeState *privilege, const uint8_t *image) {
    SwypX86KernelRoot *root;
    SwypPageAllocator *allocator;
    uint64_t stack_physical = 0u, old_rsp0;
    uint64_t stack_bytes = (uint64_t)SWYP_INIT_ENTRY_STACK_PAGES * SWYP_X86_64_PAGE_SIZE;
    uint64_t offset;
    SwypStatus status;
    if (boot_info == NULL || runtime == NULL || privilege == NULL || privilege->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    root = runtime->scheduler_address_runtime.kernel_root;
    allocator = runtime->x86_driver_runtime.page_allocator;
    if (root == NULL || allocator == NULL || allocator->ops == NULL) {
        return SWYP_ERR_INVALID;
    }
    for (offset = 0u; offset < stack_bytes + 2u * SWYP_X86_64_PAGE_SIZE; offset += SWYP_X86_64_PAGE_SIZE) {
        uint64_t physical, flags, page_size;
        if (swyp_x86_64_kernel_root_query(root, SWYP_INIT_ENTRY_STACK_BASE - SWYP_X86_64_PAGE_SIZE + offset,
                                          &physical, &flags, &page_size) != SWYP_ERR_NOT_FOUND) {
            return SWYP_ERR_DENIED;
        }
    }
    status = allocator->ops->allocate(allocator->context, SWYP_INIT_ENTRY_STACK_PAGES, 1u, &stack_physical);
    if (status != SWYP_OK) {
        return status;
    }
    /* Ring-3 interrupts must not use the suspended continuation's stack.
       TSS.RSP0 previously pointed at that same stack and repeated preemption
       overwrote live kernel frames. Both guard pages stay unmapped. */
    status = swyp_x86_64_kernel_root_map_active(root, SWYP_INIT_ENTRY_STACK_BASE, stack_physical, stack_bytes,
                                                 SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_GLOBAL, 0);
    if (status != SWYP_OK) {
        return status; /* The mapping API poisons the root on a partial failure. */
    }
    old_rsp0 = privilege->tss.rsp0;
    status = swyp_x86_privilege_set_rsp0(privilege, SWYP_INIT_ENTRY_STACK_BASE + stack_bytes);
    if (status == SWYP_OK) {
        status = swyp_kernel_run_init_task(boot_info, runtime, image);
    }
    if (swyp_x86_privilege_set_rsp0(privilege, old_rsp0) != SWYP_OK ||
        swyp_x86_64_kernel_root_unmap_active(root, SWYP_INIT_ENTRY_STACK_BASE, stack_bytes) != SWYP_OK ||
        allocator->ops->release(allocator->context, stack_physical, SWYP_INIT_ENTRY_STACK_PAGES) != SWYP_OK) {
        boot_info->boot_flags &= ~SWYP_BOOT_FLAG_INIT_CLEANED;
        return SWYP_ERR_CORRUPT;
    }
    return status;
}
