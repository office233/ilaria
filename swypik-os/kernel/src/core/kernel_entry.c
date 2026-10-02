#include "swypik/kernel/kernel_entry.h"
#include "swypik/kernel/kernel_runtime.h"

SwypStatus swyp_kernel_validate_handoff(const SwypBootInfo *boot_info, const SwypPageAllocator *page_allocator) {
    if (boot_info == NULL || page_allocator == NULL || page_allocator->ops == NULL ||
        page_allocator->ops->allocate == NULL || page_allocator->ops->release == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (boot_info->magic != SWYP_BOOT_INFO_MAGIC || boot_info->abi_version != SWYP_KERNEL_ABI_VERSION ||
        boot_info->struct_size != sizeof(*boot_info) || boot_info->arch.arch != SWYP_ARCH_X86_64 ||
        boot_info->arch.endianness != SWYP_ENDIAN_LITTLE || boot_info->arch.base_page_shift != 12u ||
        boot_info->physical_memory.source != SWYP_MEMORY_MAP_UEFI ||
        (boot_info->boot_flags & (SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES | SWYP_BOOT_FLAG_PAGE_ALLOCATOR_READY |
                                  SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE | SWYP_BOOT_FLAG_DIRECT_MAP_READY |
                                  SWYP_BOOT_FLAG_PRIVILEGE_READY | SWYP_BOOT_FLAG_EMERGENCY_IDT_READY |
                                  SWYP_BOOT_FLAG_TRAP_ABI_READY)) !=
            (SWYP_BOOT_FLAG_EXITED_BOOT_SERVICES | SWYP_BOOT_FLAG_PAGE_ALLOCATOR_READY |
             SWYP_BOOT_FLAG_KERNEL_ROOT_ACTIVE | SWYP_BOOT_FLAG_DIRECT_MAP_READY | SWYP_BOOT_FLAG_PRIVILEGE_READY |
             SWYP_BOOT_FLAG_EMERGENCY_IDT_READY | SWYP_BOOT_FLAG_TRAP_ABI_READY)) {
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

SwypStatus swyp_kernel_validate_runtime_handoff(const SwypBootInfo *boot_info, const SwypPageAllocator *page_allocator,
                                                const SwypKernelRuntime *runtime) {
    const uint64_t required = SWYP_BOOT_FLAG_PLATFORM_READY | SWYP_BOOT_FLAG_SCHEDULER_READY |
                              SWYP_BOOT_FLAG_DRIVER_ABI_READY;
    if (swyp_kernel_validate_handoff(boot_info, page_allocator) != SWYP_OK || runtime == NULL ||
        runtime->initialized == 0u || runtime->scheduler_ready == 0u ||
        (boot_info->boot_flags & required) != required || swyp_kernel_runtime_scheduler((SwypKernelRuntime *)runtime) == NULL ||
        swyp_kernel_runtime_device_broker((SwypKernelRuntime *)runtime) == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    if (runtime->x86_driver_runtime.kernel_pml4_physical == 0u ||
        runtime->scheduler_address_runtime.kernel_root == NULL ||
        runtime->scheduler_address_runtime.kernel_root->active == 0u ||
        runtime->scheduler_address_runtime.kernel_root->pml4_physical !=
            runtime->x86_driver_runtime.kernel_pml4_physical) {
        return SWYP_ERR_CORRUPT;
    }
    if ((boot_info->boot_flags & SWYP_BOOT_FLAG_INIT_FAULTED) != 0u) {
        const uint64_t fault_flags = SWYP_BOOT_FLAG_INIT_IMAGE_READY | SWYP_BOOT_FLAG_INIT_FAILED |
                                     SWYP_BOOT_FLAG_INIT_CLEANED;
        if ((boot_info->boot_flags & fault_flags) != fault_flags ||
            (boot_info->boot_flags & (SWYP_BOOT_FLAG_INIT_EXITED | SWYP_BOOT_FLAG_INIT_REFUSED)) != 0u ||
            boot_info->init_status != SWYP_ERR_FAULT || boot_info->init_exit_code != 0u ||
            boot_info->init_fault.version != runtime->driver_fault.version ||
            boot_info->init_fault.struct_size != sizeof(SwypDriverFaultRecord) ||
            boot_info->init_fault.thread_id != runtime->driver_fault.thread_id ||
            boot_info->init_fault.domain_id != runtime->driver_fault.domain_id ||
            boot_info->init_fault.lease_fence != runtime->driver_fault.lease_fence ||
            boot_info->init_fault.vector != runtime->driver_fault.vector ||
            boot_info->init_fault.error_code != runtime->driver_fault.error_code ||
            boot_info->init_fault.address != runtime->driver_fault.address ||
            boot_info->init_fault.rip != runtime->driver_fault.rip ||
            boot_info->init_fault.cs != runtime->driver_fault.cs ||
            boot_info->init_fault.kernel_cr3 != runtime->driver_fault.kernel_cr3 ||
            boot_info->init_fault.status != SWYP_ERR_FAULT ||
            swyp_kernel_runtime_validate_fault_cleanup(runtime) != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
    } else if (runtime->driver_fault.version != 0u) {
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

void swyp_kernel_halt(void) {
    __asm__ volatile("cli" : : : "memory");
    for (;;) {
        __asm__ volatile("hlt" : : : "memory");
    }
}

void swyp_kernel_entry(const SwypBootInfo *boot_info, SwypPageAllocator *page_allocator) {
    uint64_t probe_page = 0u;
    if (swyp_kernel_validate_handoff(boot_info, page_allocator) != SWYP_OK ||
        page_allocator->ops->allocate(page_allocator->context, 1u, 1u, &probe_page) != SWYP_OK ||
        page_allocator->ops->release(page_allocator->context, probe_page, 1u) != SWYP_OK) {
        swyp_kernel_halt();
    }
    /* M2 starts here: native scheduler/process bring-up will replace this halt.
       Boot services are already gone and physical allocation is kernel-owned. */
    swyp_kernel_halt();
}

void swyp_kernel_entry_runtime(SwypBootInfo *boot_info, SwypPageAllocator *page_allocator,
                               SwypKernelRuntime *runtime) {
    uint64_t probe_page = 0u;
    if (swyp_kernel_validate_runtime_handoff(boot_info, page_allocator, runtime) != SWYP_OK ||
        page_allocator->ops->allocate(page_allocator->context, 1u, 1u, &probe_page) != SWYP_OK ||
        page_allocator->ops->release(page_allocator->context, probe_page, 1u) != SWYP_OK) {
        swyp_kernel_halt();
    }
    /* The platform, syscall/IRQ ABI and scheduler address-switch layer are now
       live. The next runnable work item must be admitted through KernelRuntime;
       there is intentionally no ambient bootstrap driver or fabricated task. */
    boot_info->boot_flags |= SWYP_BOOT_FLAG_RUNTIME_HANDOFF_VALIDATED;
    swyp_kernel_halt();
}
