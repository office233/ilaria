#include "swypik/arch/x86_64/driver_runtime.h"
#include "swypik/arch/x86_64/syscall.h"

static void swyp_x86_driver_va_allocation_clear(SwypX86DriverVaAllocation *allocation) {
    if (allocation != NULL) {
        allocation->active = 0u;
        allocation->start_page = 0u;
        allocation->page_count = 0u;
        allocation->reserved0 = 0u;
    }
}

static void swyp_x86_driver_domain_clear(SwypX86DriverDomainRuntime *domain) {
    uint32_t i;
    if (domain == NULL) {
        return;
    }
    domain->active = 0u;
    domain->reserved0 = 0u;
    domain->domain_id = 0u;
    domain->lease_fence = 0u;
    domain->address_space.contract.context = NULL;
    domain->address_space.contract.ops = NULL;
    domain->address_space.allocator = NULL;
    domain->address_space.hardware_context = NULL;
    domain->address_space.hardware_ops = NULL;
    domain->address_space.domain_id = 0u;
    domain->address_space.pml4_physical = 0u;
    domain->address_space.failed = 0u;
    domain->address_space.reserved0 = 0u;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_VA_PAGES / 64u; ++i) {
        domain->va_bitmap[i] = 0u;
    }
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_VA_ALLOCATION_CAPACITY; ++i) {
        swyp_x86_driver_va_allocation_clear(&domain->va_allocations[i]);
    }
}

static void swyp_x86_driver_irq_clear(SwypX86DriverIrqAllocation *allocation) {
    if (allocation != NULL) {
        allocation->active = 0u;
        allocation->source_id = 0u;
        allocation->vector = 0u;
        allocation->pending = 0u;
        allocation->domain_id = 0u;
        allocation->lease_fence = 0u;
    }
}

static SwypX86DriverDomainRuntime *swyp_x86_driver_find_domain(SwypX86DriverRuntimeManager *manager,
                                                               uint64_t domain_id) {
    uint32_t i;
    if (manager == NULL) {
        return NULL;
    }
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
        if (manager->domains[i].active != 0u && manager->domains[i].domain_id == domain_id) {
            return &manager->domains[i];
        }
    }
    return NULL;
}

static SwypX86DriverDomainRuntime *swyp_x86_driver_find_domain_epoch(SwypX86DriverRuntimeManager *manager,
                                                                     uint64_t domain_id, uint64_t lease_fence) {
    SwypX86DriverDomainRuntime *domain = swyp_x86_driver_find_domain(manager, domain_id);
    if (domain == NULL || domain->lease_fence != lease_fence) {
        return NULL;
    }
    return domain;
}

static SwypX86DriverDomainRuntime *swyp_x86_driver_free_domain(SwypX86DriverRuntimeManager *manager) {
    uint32_t i;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
        if (manager->domains[i].active == 0u) {
            return &manager->domains[i];
        }
    }
    return NULL;
}

static int swyp_x86_driver_va_page_used(const SwypX86DriverDomainRuntime *domain, uint32_t page) {
    return (domain->va_bitmap[page / 64u] & (UINT64_C(1) << (page % 64u))) != 0u;
}

static void swyp_x86_driver_va_set(SwypX86DriverDomainRuntime *domain, uint32_t page, int used) {
    uint64_t mask = UINT64_C(1) << (page % 64u);
    if (used) {
        domain->va_bitmap[page / 64u] |= mask;
    } else {
        domain->va_bitmap[page / 64u] &= ~mask;
    }
}

static int swyp_x86_driver_va_range_free(const SwypX86DriverDomainRuntime *domain, uint32_t start,
                                         uint32_t page_count) {
    uint32_t page;
    for (page = start; page < start + page_count; ++page) {
        if (swyp_x86_driver_va_page_used(domain, page)) {
            return 0;
        }
    }
    return 1;
}

static SwypX86DriverVaAllocation *swyp_x86_driver_free_va_record(SwypX86DriverDomainRuntime *domain) {
    uint32_t i;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_VA_ALLOCATION_CAPACITY; ++i) {
        if (domain->va_allocations[i].active == 0u) {
            return &domain->va_allocations[i];
        }
    }
    return NULL;
}

static int swyp_x86_driver_domain_has_va_allocations(const SwypX86DriverDomainRuntime *domain) {
    uint32_t i;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_VA_ALLOCATION_CAPACITY; ++i) {
        if (domain->va_allocations[i].active != 0u) {
            return 1;
        }
    }
    return 0;
}

static int swyp_x86_driver_vector_in_use(const SwypX86DriverRuntimeManager *manager, uint32_t vector) {
    uint32_t i;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        if (manager->irq_allocations[i].active != 0u && manager->irq_allocations[i].vector == vector) {
            return 1;
        }
    }
    return 0;
}

static int swyp_x86_driver_domain_has_irq_allocations(const SwypX86DriverRuntimeManager *manager,
                                                       uint64_t domain_id, uint64_t lease_fence) {
    uint32_t i;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        const SwypX86DriverIrqAllocation *allocation = &manager->irq_allocations[i];
        if (allocation->active != 0u && allocation->domain_id == domain_id &&
            allocation->lease_fence == lease_fence) {
            return 1;
        }
    }
    return 0;
}

static SwypStatus swyp_x86_driver_platform_address_space(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                         SwypAddressSpace **out_address_space) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    SwypX86DriverDomainRuntime *domain;
    if (out_address_space == NULL) {
        return SWYP_ERR_INVALID;
    }
    *out_address_space = NULL;
    domain = swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence);
    if (domain == NULL) {
        return SWYP_ERR_DENIED;
    }
    *out_address_space = swyp_x86_64_address_space_contract(&domain->address_space);
    return *out_address_space == NULL ? SWYP_ERR_CORRUPT : SWYP_OK;
}

static SwypStatus swyp_x86_driver_platform_reserve_va(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                      uint64_t page_count, uint32_t page_shift,
                                                      uint64_t *virtual_base) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    SwypX86DriverDomainRuntime *domain;
    SwypX86DriverVaAllocation *allocation;
    uint32_t count;
    uint32_t start;
    uint32_t page;
    if (virtual_base == NULL || page_shift != SWYP_X86_64_PAGE_SHIFT || page_count == 0u ||
        page_count > SWYP_X86_DRIVER_RUNTIME_VA_PAGES) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence);
    if (domain == NULL) {
        return SWYP_ERR_DENIED;
    }
    allocation = swyp_x86_driver_free_va_record(domain);
    if (allocation == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    count = (uint32_t)page_count;
    for (start = 0u; start <= SWYP_X86_DRIVER_RUNTIME_VA_PAGES - count; ++start) {
        if (!swyp_x86_driver_va_range_free(domain, start, count)) {
            continue;
        }
        for (page = start; page < start + count; ++page) {
            swyp_x86_driver_va_set(domain, page, 1);
        }
        allocation->active = 1u;
        allocation->start_page = start;
        allocation->page_count = count;
        *virtual_base = SWYP_X86_DRIVER_RUNTIME_VA_BASE + (uint64_t)start * SWYP_X86_64_PAGE_SIZE;
        return SWYP_OK;
    }
    return SWYP_ERR_NO_SPACE;
}

static SwypStatus swyp_x86_driver_platform_release_va(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                      uint64_t virtual_base, uint64_t page_count) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    SwypX86DriverDomainRuntime *domain;
    uint64_t relative;
    uint32_t start;
    uint32_t count;
    uint32_t i;
    uint32_t page;
    if (virtual_base < SWYP_X86_DRIVER_RUNTIME_VA_BASE || page_count == 0u ||
        page_count > SWYP_X86_DRIVER_RUNTIME_VA_PAGES) {
        return SWYP_ERR_INVALID;
    }
    relative = virtual_base - SWYP_X86_DRIVER_RUNTIME_VA_BASE;
    if ((relative & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u ||
        relative / SWYP_X86_64_PAGE_SIZE >= SWYP_X86_DRIVER_RUNTIME_VA_PAGES) {
        return SWYP_ERR_INVALID;
    }
    start = (uint32_t)(relative / SWYP_X86_64_PAGE_SIZE);
    count = (uint32_t)page_count;
    if (count > SWYP_X86_DRIVER_RUNTIME_VA_PAGES - start) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence);
    if (domain == NULL) {
        return SWYP_ERR_DENIED;
    }
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_VA_ALLOCATION_CAPACITY; ++i) {
        SwypX86DriverVaAllocation *allocation = &domain->va_allocations[i];
        if (allocation->active != 0u && allocation->start_page == start && allocation->page_count == count) {
            for (page = start; page < start + count; ++page) {
                if (!swyp_x86_driver_va_page_used(domain, page)) {
                    return SWYP_ERR_CORRUPT;
                }
            }
            for (page = start; page < start + count; ++page) {
                swyp_x86_driver_va_set(domain, page, 0);
            }
            swyp_x86_driver_va_allocation_clear(allocation);
            return SWYP_OK;
        }
    }
    return SWYP_ERR_DENIED;
}

static SwypStatus swyp_x86_driver_platform_allocate_vector(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                           uint32_t source_id, uint32_t *vector) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    uint32_t i;
    uint32_t candidate;
    if (manager == NULL || vector == NULL || swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence) == NULL) {
        return SWYP_ERR_DENIED;
    }
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        const SwypX86DriverIrqAllocation *existing = &manager->irq_allocations[i];
        if (existing->active != 0u && existing->domain_id == domain_id && existing->lease_fence == lease_fence &&
            existing->source_id == source_id) {
            return SWYP_ERR_DENIED;
        }
    }
    for (candidate = SWYP_X86_DRIVER_RUNTIME_IRQ_FIRST; candidate <= SWYP_X86_DRIVER_RUNTIME_IRQ_LAST; ++candidate) {
        if (candidate == SWYP_X86_SYSCALL_VECTOR) {
            continue;
        }
        if (!swyp_x86_driver_vector_in_use(manager, candidate)) {
            for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
                SwypX86DriverIrqAllocation *allocation = &manager->irq_allocations[i];
                if (allocation->active == 0u) {
                    allocation->active = 1u;
                    allocation->source_id = source_id;
                    allocation->vector = candidate;
                    allocation->pending = 0u;
                    allocation->domain_id = domain_id;
                    allocation->lease_fence = lease_fence;
                    *vector = candidate;
                    return SWYP_OK;
                }
            }
            return SWYP_ERR_NO_SPACE;
        }
    }
    return SWYP_ERR_NO_SPACE;
}

static SwypStatus swyp_x86_driver_platform_release_vector(void *context, uint64_t domain_id, uint64_t lease_fence,
                                                          uint32_t source_id, uint32_t vector) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    uint32_t i;
    if (manager == NULL || swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence) == NULL) {
        return SWYP_ERR_DENIED;
    }
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        SwypX86DriverIrqAllocation *allocation = &manager->irq_allocations[i];
        if (allocation->active != 0u && allocation->domain_id == domain_id &&
            allocation->lease_fence == lease_fence && allocation->source_id == source_id &&
            allocation->vector == vector) {
            swyp_x86_driver_irq_clear(allocation);
            return SWYP_OK;
        }
    }
    return SWYP_ERR_DENIED;
}

static SwypStatus swyp_x86_driver_platform_map_dma(void *context, const SwypCapabilityObject *dma_object,
                                                   const SwypCapabilityObject *memory_object,
                                                   uint64_t physical_address, uint64_t domain_id, uint64_t lease_fence,
                                                   uint64_t length, uint64_t access_rights, uint64_t *backend_token,
                                                   uint64_t *iova) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    if (manager == NULL || manager->iommu == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    if (swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence) == NULL) {
        return SWYP_ERR_DENIED;
    }
    return swyp_x86_iommu_map(manager->iommu, dma_object, memory_object, physical_address, domain_id, lease_fence,
                              length, access_rights, backend_token, iova);
}

static SwypStatus swyp_x86_driver_platform_unmap_dma(void *context, uint64_t backend_token) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    if (manager == NULL || manager->iommu == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return swyp_x86_iommu_unmap(manager->iommu, backend_token);
}

static SwypStatus swyp_x86_driver_platform_config_read(void *context, const SwypCapabilityObject *object,
                                                       uint64_t absolute_offset, uint32_t width_bytes,
                                                       uint64_t *value) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    if (manager == NULL || manager->pci_ecam == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return swyp_x86_pci_ecam_read(manager->pci_ecam, object, absolute_offset, width_bytes, value);
}

static SwypStatus swyp_x86_driver_platform_config_write(void *context, const SwypCapabilityObject *object,
                                                        uint64_t absolute_offset, uint32_t width_bytes,
                                                        uint64_t value) {
    SwypX86DriverRuntimeManager *manager = (SwypX86DriverRuntimeManager *)context;
    if (manager == NULL || manager->pci_ecam == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return swyp_x86_pci_ecam_write(manager->pci_ecam, object, absolute_offset, width_bytes, value);
}

static const SwypDevicePlatformRuntimeOps swyp_x86_driver_platform_ops = {
    .address_space_for_domain = swyp_x86_driver_platform_address_space,
    .reserve_device_virtual = swyp_x86_driver_platform_reserve_va,
    .release_device_virtual = swyp_x86_driver_platform_release_va,
    .allocate_irq_vector = swyp_x86_driver_platform_allocate_vector,
    .release_irq_vector = swyp_x86_driver_platform_release_vector,
    .map_dma = swyp_x86_driver_platform_map_dma,
    .unmap_dma = swyp_x86_driver_platform_unmap_dma,
    .config_read = swyp_x86_driver_platform_config_read,
    .config_write = swyp_x86_driver_platform_config_write,
};

void swyp_x86_64_driver_runtime_init(SwypX86DriverRuntimeManager *manager, SwypPageAllocator *page_allocator,
                                     void *hardware_context,
                                     const SwypX86AddressSpaceHardwareOps *address_space_hardware_ops) {
    uint32_t i;
    if (manager == NULL) {
        return;
    }
    manager->page_allocator = page_allocator;
    manager->hardware_context = hardware_context;
    manager->address_space_hardware_ops = address_space_hardware_ops;
    manager->kernel_pml4_physical = 0u;
    manager->iommu = NULL;
    manager->pci_ecam = NULL;
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
        swyp_x86_driver_domain_clear(&manager->domains[i]);
    }
    for (i = 0; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        swyp_x86_driver_irq_clear(&manager->irq_allocations[i]);
    }
}

void swyp_x86_64_driver_runtime_set_iommu(SwypX86DriverRuntimeManager *manager, SwypX86Iommu *iommu) {
    if (manager != NULL) {
        manager->iommu = iommu;
    }
}

void swyp_x86_64_driver_runtime_set_pci_ecam(SwypX86DriverRuntimeManager *manager, SwypX86PciEcam *pci_ecam) {
    if (manager != NULL) {
        manager->pci_ecam = pci_ecam;
    }
}

SwypStatus swyp_x86_64_driver_runtime_set_kernel_root(SwypX86DriverRuntimeManager *manager,
                                                      uint64_t kernel_pml4_physical) {
    uint32_t i;
    if (manager == NULL || kernel_pml4_physical == 0u ||
        (kernel_pml4_physical & (SWYP_X86_64_PAGE_SIZE - 1u)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0u; i < SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY; ++i) {
        if (manager->domains[i].active != 0u) {
            return SWYP_ERR_DENIED;
        }
    }
    manager->kernel_pml4_physical = kernel_pml4_physical;
    return SWYP_OK;
}

SwypStatus swyp_x86_64_driver_runtime_open_domain(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                  uint64_t lease_fence, SwypAddressSpace **out_address_space) {
    SwypX86DriverDomainRuntime *domain;
    SwypStatus status;
    if (manager == NULL || out_address_space == NULL || manager->page_allocator == NULL ||
        manager->address_space_hardware_ops == NULL || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    *out_address_space = NULL;
    if (swyp_x86_driver_find_domain(manager, domain_id) != NULL) {
        return SWYP_ERR_DENIED;
    }
    domain = swyp_x86_driver_free_domain(manager);
    if (domain == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    swyp_x86_driver_domain_clear(domain);
    status = swyp_x86_64_address_space_init(&domain->address_space, manager->page_allocator, manager->hardware_context,
                                            manager->address_space_hardware_ops, domain_id);
    if (status != SWYP_OK) {
        swyp_x86_driver_domain_clear(domain);
        return status;
    }
    if (manager->kernel_pml4_physical != 0u) {
        status = swyp_x86_64_address_space_inherit_supervisor_root(&domain->address_space,
                                                                   manager->kernel_pml4_physical);
        if (status != SWYP_OK) {
            if (swyp_x86_64_address_space_destroy(&domain->address_space) != SWYP_OK) {
                swyp_x86_driver_domain_clear(domain);
                return SWYP_ERR_CORRUPT;
            }
            swyp_x86_driver_domain_clear(domain);
            return status;
        }
    }
    domain->domain_id = domain_id;
    domain->lease_fence = lease_fence;
    domain->active = 1u;
    *out_address_space = swyp_x86_64_address_space_contract(&domain->address_space);
    return *out_address_space == NULL ? SWYP_ERR_CORRUPT : SWYP_OK;
}

SwypStatus swyp_x86_64_driver_runtime_activate_domain(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                      uint64_t lease_fence) {
    SwypX86DriverDomainRuntime *domain = swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence);
    SwypAddressSpace *address_space;
    if (domain == NULL) {
        return SWYP_ERR_DENIED;
    }
    address_space = swyp_x86_64_address_space_contract(&domain->address_space);
    if (address_space == NULL || address_space->ops == NULL || address_space->ops->activate == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    return address_space->ops->activate(address_space->context);
}

SwypStatus swyp_x86_64_driver_runtime_close_domain(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                   uint64_t lease_fence) {
    SwypX86DriverDomainRuntime *domain = swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence);
    SwypStatus status;
    if (domain == NULL) {
        return SWYP_ERR_DENIED;
    }
    if (swyp_x86_driver_domain_has_va_allocations(domain) ||
        swyp_x86_driver_domain_has_irq_allocations(manager, domain_id, lease_fence) ||
        (manager->iommu != NULL &&
         (swyp_x86_iommu_domain_has_mappings(manager->iommu, domain_id, lease_fence) ||
          swyp_x86_iommu_domain_has_devices(manager->iommu, domain_id, lease_fence)))) {
        return SWYP_ERR_DENIED;
    }
    status = swyp_x86_64_address_space_destroy(&domain->address_space);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_x86_driver_domain_clear(domain);
    return SWYP_OK;
}

SwypX86AddressSpace *swyp_x86_64_driver_runtime_x86_space(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                         uint64_t lease_fence) {
    SwypX86DriverDomainRuntime *domain = swyp_x86_driver_find_domain_epoch(manager, domain_id, lease_fence);
    return domain == NULL ? NULL : &domain->address_space;
}

const SwypDevicePlatformRuntimeOps *swyp_x86_64_driver_runtime_platform_ops(void) {
    return &swyp_x86_driver_platform_ops;
}
