#include "swypik/arch/x86_64/iommu.h"

static void swyp_x86_iommu_device_clear(SwypX86IommuDeviceBinding *binding) {
    if (binding != NULL) {
        binding->active = 0u;
        binding->reserved0 = 0u;
        binding->domain_id = 0u;
        binding->lease_fence = 0u;
        binding->device_id = 0u;
        binding->requester_aux = 0u;
    }
}

static void swyp_x86_iommu_mapping_clear(SwypX86IommuMapping *mapping) {
    if (mapping != NULL) {
        mapping->active = 0u;
        mapping->hardware_mapped = 0u;
        mapping->domain_id = 0u;
        mapping->lease_fence = 0u;
        mapping->device_id = 0u;
        mapping->iova = 0u;
        mapping->physical_address = 0u;
        mapping->length = 0u;
        mapping->access_rights = 0u;
    }
}

static int swyp_x86_iommu_page_aligned(uint64_t value) {
    return (value & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) == 0u;
}

static int swyp_x86_iommu_range_valid(uint64_t start, uint64_t length) {
    return length != 0u && swyp_x86_iommu_page_aligned(start) && swyp_x86_iommu_page_aligned(length) &&
           length <= UINT64_MAX - start;
}

static int swyp_x86_iommu_ranges_overlap(uint64_t left_start, uint64_t left_length, uint64_t right_start,
                                         uint64_t right_length) {
    uint64_t left_end = left_start + left_length;
    uint64_t right_end = right_start + right_length;
    return left_start < right_end && right_start < left_end;
}

static SwypX86IommuMapping *swyp_x86_iommu_free_mapping(SwypX86Iommu *iommu, uint32_t *index) {
    uint32_t i;
    for (i = 0; i < SWYP_X86_IOMMU_MAPPING_CAPACITY; ++i) {
        if (iommu->mappings[i].active == 0u) {
            if (index != NULL) {
                *index = i;
            }
            return &iommu->mappings[i];
        }
    }
    return NULL;
}

static SwypX86IommuDeviceBinding *swyp_x86_iommu_device(SwypX86Iommu *iommu, uint64_t domain_id,
                                                         uint64_t lease_fence, uint64_t device_id) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_IOMMU_DEVICE_CAPACITY; ++i) {
        SwypX86IommuDeviceBinding *binding = &iommu->devices[i];
        if (binding->active != 0u && binding->domain_id == domain_id && binding->lease_fence == lease_fence &&
            binding->device_id == device_id) {
            return binding;
        }
    }
    return NULL;
}

static SwypX86IommuDeviceBinding *swyp_x86_iommu_free_device(SwypX86Iommu *iommu) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_IOMMU_DEVICE_CAPACITY; ++i) {
        if (iommu->devices[i].active == 0u) {
            return &iommu->devices[i];
        }
    }
    return NULL;
}

static SwypStatus swyp_x86_iommu_choose_iova(const SwypX86Iommu *iommu, const SwypCapabilityObject *dma_object,
                                             uint64_t domain_id, uint64_t length, uint64_t *iova) {
    uint64_t aperture_end;
    uint64_t candidate;
    if (!swyp_x86_iommu_range_valid(dma_object->base, dma_object->length) || length > dma_object->length) {
        return SWYP_ERR_INVALID;
    }
    aperture_end = dma_object->base + dma_object->length;
    candidate = dma_object->base;
    while (candidate <= aperture_end - length) {
        uint64_t conflict_end = 0u;
        uint32_t i;
        for (i = 0; i < SWYP_X86_IOMMU_MAPPING_CAPACITY; ++i) {
            const SwypX86IommuMapping *mapping = &iommu->mappings[i];
            uint64_t mapping_end;
            if (mapping->active == 0u || mapping->domain_id != domain_id ||
                mapping->device_id != dma_object->object_id) {
                continue;
            }
            if (!swyp_x86_iommu_ranges_overlap(candidate, length, mapping->iova, mapping->length)) {
                continue;
            }
            mapping_end = mapping->iova + mapping->length;
            if (mapping_end > conflict_end) {
                conflict_end = mapping_end;
            }
        }
        if (conflict_end == 0u) {
            *iova = candidate;
            return SWYP_OK;
        }
        candidate = conflict_end;
        if (!swyp_x86_iommu_page_aligned(candidate)) {
            return SWYP_ERR_CORRUPT;
        }
    }
    return SWYP_ERR_NO_SPACE;
}

void swyp_x86_iommu_init(SwypX86Iommu *iommu, void *hardware_context, const SwypX86IommuHardwareOps *hardware_ops) {
    uint32_t i;
    if (iommu == NULL) {
        return;
    }
    iommu->hardware_context = hardware_context;
    iommu->hardware_ops = hardware_ops;
    iommu->failed = 0u;
    iommu->reserved0 = 0u;
    for (i = 0; i < SWYP_X86_IOMMU_DEVICE_CAPACITY; ++i) {
        swyp_x86_iommu_device_clear(&iommu->devices[i]);
    }
    for (i = 0; i < SWYP_X86_IOMMU_MAPPING_CAPACITY; ++i) {
        swyp_x86_iommu_mapping_clear(&iommu->mappings[i]);
    }
}

SwypStatus swyp_x86_iommu_attach_device(SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence,
                                        uint64_t device_id, uint64_t requester_aux) {
    SwypX86IommuDeviceBinding *binding;
    SwypStatus status;
    if (iommu == NULL || iommu->failed != 0u || domain_id == 0u || lease_fence == 0u || device_id == 0u ||
        iommu->hardware_ops == NULL || iommu->hardware_ops->attach_device == NULL ||
        iommu->hardware_ops->detach_device == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_x86_iommu_device(iommu, domain_id, lease_fence, device_id) != NULL) {
        return SWYP_ERR_DENIED;
    }
    binding = swyp_x86_iommu_free_device(iommu);
    if (binding == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = iommu->hardware_ops->attach_device(iommu->hardware_context, domain_id, device_id, requester_aux);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_x86_iommu_device_clear(binding);
    binding->active = 1u;
    binding->domain_id = domain_id;
    binding->lease_fence = lease_fence;
    binding->device_id = device_id;
    binding->requester_aux = requester_aux;
    return SWYP_OK;
}

SwypStatus swyp_x86_iommu_detach_device(SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence,
                                        uint64_t device_id) {
    SwypX86IommuDeviceBinding *binding;
    uint32_t i;
    SwypStatus status;
    if (iommu == NULL || iommu->failed != 0u || domain_id == 0u || lease_fence == 0u || device_id == 0u ||
        iommu->hardware_ops == NULL || iommu->hardware_ops->detach_device == NULL) {
        return SWYP_ERR_INVALID;
    }
    binding = swyp_x86_iommu_device(iommu, domain_id, lease_fence, device_id);
    if (binding == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    for (i = 0u; i < SWYP_X86_IOMMU_MAPPING_CAPACITY; ++i) {
        const SwypX86IommuMapping *mapping = &iommu->mappings[i];
        if (mapping->active != 0u && mapping->domain_id == domain_id && mapping->lease_fence == lease_fence &&
            mapping->device_id == device_id) {
            return SWYP_ERR_DENIED;
        }
    }
    status = iommu->hardware_ops->detach_device(iommu->hardware_context, domain_id, device_id);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_x86_iommu_device_clear(binding);
    return SWYP_OK;
}

SwypStatus swyp_x86_iommu_map(SwypX86Iommu *iommu, const SwypCapabilityObject *dma_object,
                              const SwypCapabilityObject *memory_object, uint64_t physical_address,
                              uint64_t domain_id, uint64_t lease_fence, uint64_t length, uint64_t access_rights,
                              uint64_t *mapping_token, uint64_t *iova) {
    SwypX86IommuMapping *mapping;
    uint64_t chosen_iova = 0u;
    uint64_t memory_offset;
    uint64_t page_count;
    uint32_t index = 0u;
    SwypStatus status;
    if (iommu == NULL || dma_object == NULL || memory_object == NULL || mapping_token == NULL || iova == NULL ||
        iommu->failed != 0u || iommu->hardware_ops == NULL || iommu->hardware_ops->map_pages == NULL ||
        iommu->hardware_ops->unmap_pages == NULL || iommu->hardware_ops->invalidate_domain == NULL ||
        dma_object->type != SWYP_CAP_OBJECT_DMA || memory_object->type != SWYP_CAP_OBJECT_SHARED_MEMORY ||
        domain_id == 0u || lease_fence == 0u ||
        (access_rights & ~(SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE)) != 0u || access_rights == 0u ||
        !swyp_x86_iommu_range_valid(physical_address, length) ||
        !swyp_x86_iommu_range_valid(memory_object->base, memory_object->length)) {
        return SWYP_ERR_INVALID;
    }
    if (iommu->hardware_ops->attach_device != NULL &&
        swyp_x86_iommu_device(iommu, domain_id, lease_fence, dma_object->object_id) == NULL) {
        return SWYP_ERR_DENIED;
    }
    if (physical_address < memory_object->base) {
        return SWYP_ERR_DENIED;
    }
    memory_offset = physical_address - memory_object->base;
    if (memory_offset > memory_object->length || length > memory_object->length - memory_offset) {
        return SWYP_ERR_DENIED;
    }
    mapping = swyp_x86_iommu_free_mapping(iommu, &index);
    if (mapping == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = swyp_x86_iommu_choose_iova(iommu, dma_object, domain_id, length, &chosen_iova);
    if (status != SWYP_OK) {
        return status;
    }
    page_count = length / SWYP_X86_IOMMU_PAGE_SIZE;
    status = iommu->hardware_ops->map_pages(iommu->hardware_context, domain_id, dma_object->object_id, chosen_iova,
                                            physical_address, page_count, access_rights);
    if (status != SWYP_OK) {
        return status;
    }
    status = iommu->hardware_ops->invalidate_domain(iommu->hardware_context, domain_id);
    if (status != SWYP_OK) {
        SwypStatus rollback = iommu->hardware_ops->unmap_pages(iommu->hardware_context, domain_id,
                                                               dma_object->object_id, chosen_iova, page_count);
        SwypStatus rollback_invalidate = iommu->hardware_ops->invalidate_domain(iommu->hardware_context, domain_id);
        if (rollback != SWYP_OK || rollback_invalidate != SWYP_OK) {
            iommu->failed = 1u;
        }
        return status;
    }
    swyp_x86_iommu_mapping_clear(mapping);
    mapping->active = 1u;
    mapping->hardware_mapped = 1u;
    mapping->domain_id = domain_id;
    mapping->lease_fence = lease_fence;
    mapping->device_id = dma_object->object_id;
    mapping->iova = chosen_iova;
    mapping->physical_address = physical_address;
    mapping->length = length;
    mapping->access_rights = access_rights;
    *mapping_token = (uint64_t)index + 1u;
    *iova = chosen_iova;
    return SWYP_OK;
}

SwypStatus swyp_x86_iommu_unmap(SwypX86Iommu *iommu, uint64_t mapping_token) {
    SwypX86IommuMapping *mapping;
    uint64_t page_count;
    SwypStatus status;
    if (iommu == NULL || iommu->failed != 0u || iommu->hardware_ops == NULL || mapping_token == 0u ||
        mapping_token > SWYP_X86_IOMMU_MAPPING_CAPACITY) {
        return SWYP_ERR_INVALID;
    }
    mapping = &iommu->mappings[mapping_token - 1u];
    if (mapping->active == 0u) {
        return SWYP_ERR_STALE;
    }
    page_count = mapping->length / SWYP_X86_IOMMU_PAGE_SIZE;
    if (mapping->hardware_mapped != 0u) {
        status = iommu->hardware_ops->unmap_pages(iommu->hardware_context, mapping->domain_id, mapping->device_id,
                                                  mapping->iova, page_count);
        if (status != SWYP_OK) {
            return status;
        }
        mapping->hardware_mapped = 0u;
    }
    status = iommu->hardware_ops->invalidate_domain(iommu->hardware_context, mapping->domain_id);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_x86_iommu_mapping_clear(mapping);
    return SWYP_OK;
}

int swyp_x86_iommu_domain_has_mappings(const SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence) {
    uint32_t i;
    if (iommu == NULL || domain_id == 0u || lease_fence == 0u) {
        return 0;
    }
    for (i = 0; i < SWYP_X86_IOMMU_MAPPING_CAPACITY; ++i) {
        const SwypX86IommuMapping *mapping = &iommu->mappings[i];
        if (mapping->active != 0u && mapping->domain_id == domain_id && mapping->lease_fence == lease_fence) {
            return 1;
        }
    }
    return 0;
}

int swyp_x86_iommu_domain_has_devices(const SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence) {
    uint32_t i;
    if (iommu == NULL || domain_id == 0u || lease_fence == 0u) {
        return 0;
    }
    for (i = 0u; i < SWYP_X86_IOMMU_DEVICE_CAPACITY; ++i) {
        const SwypX86IommuDeviceBinding *binding = &iommu->devices[i];
        if (binding->active != 0u && binding->domain_id == domain_id && binding->lease_fence == lease_fence) {
            return 1;
        }
    }
    return 0;
}
