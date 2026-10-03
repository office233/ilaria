#include "swypik/kernel/device_platform.h"

static void swyp_device_platform_record_clear(SwypDevicePlatformRecord *record) {
    if (record == NULL) {
        return;
    }
    record->active = 0u;
    record->kind = SWYP_DEVICE_PLATFORM_RECORD_INVALID;
    record->domain_id = 0u;
    record->lease_fence = 0u;
    record->address_space = NULL;
    record->virtual_base = 0u;
    record->page_count = 0u;
    record->irq_source = 0u;
    record->irq_vector = 0u;
    record->mmio_mapped = 0u;
    record->irq_bound = 0u;
}

static SwypDevicePlatformRecord *swyp_device_platform_free_record(SwypDevicePlatform *platform, uint64_t *token) {
    uint32_t i;
    for (i = 0; i < SWYP_DEVICE_PLATFORM_RECORD_CAPACITY; ++i) {
        if (platform->records[i].active == 0u) {
            if (token != NULL) {
                *token = (uint64_t)i + 1u;
            }
            return &platform->records[i];
        }
    }
    return NULL;
}

static SwypDevicePlatformRecord *swyp_device_platform_record(SwypDevicePlatform *platform, uint64_t token,
                                                              SwypDevicePlatformRecordKind kind) {
    SwypDevicePlatformRecord *record;
    uint64_t index;
    if (platform == NULL || token == 0u || token > SWYP_DEVICE_PLATFORM_RECORD_CAPACITY) {
        return NULL;
    }
    index = token - 1u;
    record = &platform->records[index];
    if (record->active == 0u || record->kind != kind) {
        return NULL;
    }
    return record;
}

static SwypStatus swyp_device_platform_map_mmio(void *context, const SwypCapabilityObject *object, uint64_t domain_id,
                                                uint64_t lease_fence, uint64_t offset, uint64_t length,
                                                uint64_t mmu_flags, uint64_t *backend_token,
                                                uint64_t *virtual_address) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    SwypDevicePlatformRecord *record;
    SwypAddressSpace *address_space = NULL;
    uint64_t page_size;
    uint64_t page_mask;
    uint64_t physical;
    uint64_t physical_base;
    uint64_t page_offset;
    uint64_t span;
    uint64_t page_count;
    uint64_t virtual_base = 0u;
    uint64_t token = 0u;
    SwypStatus status;
    if (platform == NULL || object == NULL || backend_token == NULL || virtual_address == NULL || domain_id == 0u ||
        lease_fence == 0u || length == 0u || platform->runtime_ops == NULL || platform->page_shift < 12u ||
        platform->page_shift > 30u || (mmu_flags & ~(SWYP_MMU_READ | SWYP_MMU_WRITE | SWYP_MMU_USER | SWYP_MMU_DEVICE)) != 0u ||
        (mmu_flags & (SWYP_MMU_READ | SWYP_MMU_WRITE)) == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (platform->runtime_ops->address_space_for_domain == NULL ||
        platform->runtime_ops->reserve_device_virtual == NULL || platform->runtime_ops->release_device_virtual == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    if (offset > UINT64_MAX - object->base) {
        return SWYP_ERR_INVALID;
    }
    physical = object->base + offset;
    page_size = UINT64_C(1) << platform->page_shift;
    page_mask = page_size - 1u;
    physical_base = physical & ~page_mask;
    page_offset = physical - physical_base;
    if (length > UINT64_MAX - page_offset) {
        return SWYP_ERR_INVALID;
    }
    span = page_offset + length;
    page_count = span / page_size;
    if ((span & page_mask) != 0u) {
        page_count += 1u;
    }
    if (page_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    record = swyp_device_platform_free_record(platform, &token);
    if (record == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = platform->runtime_ops->address_space_for_domain(platform->runtime_context, domain_id, lease_fence,
                                                              &address_space);
    if (status != SWYP_OK) {
        return status;
    }
    if (address_space == NULL || address_space->ops == NULL || address_space->ops->map == NULL ||
        address_space->ops->unmap == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    status = platform->runtime_ops->reserve_device_virtual(platform->runtime_context, domain_id, lease_fence,
                                                            page_count, platform->page_shift, &virtual_base);
    if (status != SWYP_OK) {
        return status;
    }
    if (virtual_base == 0u || (virtual_base & page_mask) != 0u) {
        if (virtual_base != 0u) {
            (void)platform->runtime_ops->release_device_virtual(platform->runtime_context, domain_id, lease_fence,
                                                                 virtual_base, page_count);
        }
        return SWYP_ERR_CORRUPT;
    }
    status = address_space->ops->map(address_space->context, virtual_base, physical_base, page_count, mmu_flags);
    if (status != SWYP_OK) {
        if (platform->runtime_ops->release_device_virtual(platform->runtime_context, domain_id, lease_fence,
                                                          virtual_base, page_count) != SWYP_OK) {
            swyp_device_platform_record_clear(record);
            record->active = 1u;
            record->kind = SWYP_DEVICE_PLATFORM_RECORD_MMIO;
            record->domain_id = domain_id;
            record->lease_fence = lease_fence;
            record->address_space = address_space;
            record->virtual_base = virtual_base;
            record->page_count = page_count;
            /* Map failed before publication; only the reservation needs retry. */
            *backend_token = token;
        }
        return status;
    }
    swyp_device_platform_record_clear(record);
    record->active = 1u;
    record->kind = SWYP_DEVICE_PLATFORM_RECORD_MMIO;
    record->domain_id = domain_id;
    record->lease_fence = lease_fence;
    record->address_space = address_space;
    record->virtual_base = virtual_base;
    record->page_count = page_count;
    record->mmio_mapped = 1u;
    *backend_token = token;
    *virtual_address = virtual_base + page_offset;
    return SWYP_OK;
}

static SwypStatus swyp_device_platform_unmap_mmio(void *context, uint64_t backend_token) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    SwypDevicePlatformRecord *record = swyp_device_platform_record(platform, backend_token, SWYP_DEVICE_PLATFORM_RECORD_MMIO);
    SwypStatus status;
    if (record == NULL || platform->runtime_ops == NULL || platform->runtime_ops->release_device_virtual == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (record->mmio_mapped != 0u) {
        if (record->address_space == NULL || record->address_space->ops == NULL || record->address_space->ops->unmap == NULL) {
            return SWYP_ERR_CORRUPT;
        }
        status = record->address_space->ops->unmap(record->address_space->context, record->virtual_base,
                                                   record->page_count);
        if (status != SWYP_OK) {
            return status;
        }
        record->mmio_mapped = 0u;
    }
    status = platform->runtime_ops->release_device_virtual(platform->runtime_context, record->domain_id,
                                                            record->lease_fence, record->virtual_base,
                                                            record->page_count);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_device_platform_record_clear(record);
    return SWYP_OK;
}

static SwypStatus swyp_device_platform_bind_irq(void *context, const SwypCapabilityObject *object, uint64_t domain_id,
                                                uint64_t lease_fence, uint64_t *backend_token, uint32_t *vector) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    SwypDevicePlatformRecord *record;
    uint64_t token = 0u;
    uint32_t source_id;
    uint32_t allocated_vector = 0u;
    SwypStatus status;
    if (platform == NULL || object == NULL || backend_token == NULL || vector == NULL || object->base > UINT32_MAX ||
        domain_id == 0u || lease_fence == 0u || platform->runtime_ops == NULL || platform->interrupts == NULL ||
        platform->interrupts->ops == NULL || platform->runtime_ops->allocate_irq_vector == NULL ||
        platform->runtime_ops->release_irq_vector == NULL || platform->interrupts->ops->bind == NULL ||
        platform->interrupts->ops->unbind == NULL || platform->interrupts->ops->mask == NULL ||
        platform->interrupts->ops->unmask == NULL ||
        platform->interrupts->ops->end_of_interrupt == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    source_id = (uint32_t)object->base;
    record = swyp_device_platform_free_record(platform, &token);
    if (record == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = platform->runtime_ops->allocate_irq_vector(platform->runtime_context, domain_id, lease_fence, source_id,
                                                         &allocated_vector);
    if (status != SWYP_OK) {
        return status;
    }
    if (allocated_vector == 0u) {
        (void)platform->runtime_ops->release_irq_vector(platform->runtime_context, domain_id, lease_fence, source_id,
                                                         allocated_vector);
        return SWYP_ERR_CORRUPT;
    }
    /* Own the vector before bind/unmask; rollback clears only on successful
       teardown. On failure expose the token solely for broker revoke cleanup. */
    swyp_device_platform_record_clear(record);
    record->active = 1u;
    record->kind = SWYP_DEVICE_PLATFORM_RECORD_IRQ;
    record->domain_id = domain_id;
    record->lease_fence = lease_fence;
    record->irq_source = source_id;
    record->irq_vector = allocated_vector;
    status = platform->interrupts->ops->bind(platform->interrupts->context, source_id, allocated_vector);
    if (status != SWYP_OK) {
        if (platform->runtime_ops->release_irq_vector(platform->runtime_context, domain_id, lease_fence, source_id,
                                                     allocated_vector) == SWYP_OK) {
            swyp_device_platform_record_clear(record);
        } else {
            *backend_token = token;
        }
        return status;
    }
    record->irq_bound = 1u;
    status = platform->interrupts->ops->unmask(platform->interrupts->context, source_id);
    if (status != SWYP_OK) {
        (void)platform->interrupts->ops->mask(platform->interrupts->context, source_id);
        if (platform->interrupts->ops->unbind(platform->interrupts->context, source_id) != SWYP_OK) {
            *backend_token = token;
            return status;
        }
        record->irq_bound = 0u;
        if (platform->runtime_ops->release_irq_vector(platform->runtime_context, domain_id, lease_fence, source_id,
                                                     allocated_vector) == SWYP_OK) {
            swyp_device_platform_record_clear(record);
        } else {
            *backend_token = token;
        }
        return status;
    }
    *backend_token = token;
    *vector = allocated_vector;
    return SWYP_OK;
}

static SwypStatus swyp_device_platform_ack_irq(void *context, uint64_t backend_token) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    SwypDevicePlatformRecord *record = swyp_device_platform_record(platform, backend_token, SWYP_DEVICE_PLATFORM_RECORD_IRQ);
    SwypStatus status;
    if (record == NULL || platform->interrupts == NULL || platform->interrupts->ops == NULL ||
        platform->interrupts->ops->end_of_interrupt == NULL || platform->interrupts->ops->unmask == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = platform->interrupts->ops->end_of_interrupt(platform->interrupts->context, record->irq_source);
    if (status != SWYP_OK) {
        return status;
    }
    return platform->interrupts->ops->unmask(platform->interrupts->context, record->irq_source);
}

static SwypStatus swyp_device_platform_unbind_irq(void *context, uint64_t backend_token) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    SwypDevicePlatformRecord *record = swyp_device_platform_record(platform, backend_token, SWYP_DEVICE_PLATFORM_RECORD_IRQ);
    SwypStatus status;
    if (record == NULL || platform->runtime_ops == NULL || platform->runtime_ops->release_irq_vector == NULL ||
        platform->interrupts == NULL || platform->interrupts->ops == NULL || platform->interrupts->ops->mask == NULL ||
        platform->interrupts->ops->unbind == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (record->irq_bound != 0u) {
        status = platform->interrupts->ops->mask(platform->interrupts->context, record->irq_source);
        if (status != SWYP_OK) {
            return status;
        }
        status = platform->interrupts->ops->unbind(platform->interrupts->context, record->irq_source);
        if (status != SWYP_OK) {
            return status;
        }
        record->irq_bound = 0u;
    }
    status = platform->runtime_ops->release_irq_vector(platform->runtime_context, record->domain_id,
                                                        record->lease_fence, record->irq_source, record->irq_vector);
    if (status != SWYP_OK) {
        return status;
    }
    swyp_device_platform_record_clear(record);
    return SWYP_OK;
}

static SwypStatus swyp_device_platform_map_dma(void *context, const SwypCapabilityObject *dma_object,
                                               const SwypCapabilityObject *memory_object, uint64_t physical_address,
                                               uint64_t domain_id, uint64_t lease_fence, uint64_t length,
                                               uint64_t access_rights, uint64_t *backend_token, uint64_t *iova) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    if (platform == NULL || platform->runtime_ops == NULL || platform->runtime_ops->map_dma == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return platform->runtime_ops->map_dma(platform->runtime_context, dma_object, memory_object, physical_address,
                                          domain_id, lease_fence, length, access_rights, backend_token, iova);
}

static SwypStatus swyp_device_platform_unmap_dma(void *context, uint64_t backend_token) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    if (platform == NULL || platform->runtime_ops == NULL || platform->runtime_ops->unmap_dma == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return platform->runtime_ops->unmap_dma(platform->runtime_context, backend_token);
}

static SwypStatus swyp_device_platform_config_read(void *context, const SwypCapabilityObject *object,
                                                   uint64_t absolute_offset, uint32_t width_bytes, uint64_t *value) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    if (platform == NULL || platform->runtime_ops == NULL || platform->runtime_ops->config_read == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return platform->runtime_ops->config_read(platform->runtime_context, object, absolute_offset, width_bytes, value);
}

static SwypStatus swyp_device_platform_config_write(void *context, const SwypCapabilityObject *object,
                                                    uint64_t absolute_offset, uint32_t width_bytes, uint64_t value) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    if (platform == NULL || platform->runtime_ops == NULL || platform->runtime_ops->config_write == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return platform->runtime_ops->config_write(platform->runtime_context, object, absolute_offset, width_bytes, value);
}

static SwypStatus swyp_device_platform_control_read(void *context, const SwypCapabilityObject *object,
                                                    uint64_t *value) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    if (platform == NULL || platform->runtime_ops == NULL || platform->runtime_ops->control_read == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return platform->runtime_ops->control_read(platform->runtime_context, object, value);
}

static SwypStatus swyp_device_platform_control_write(void *context, const SwypCapabilityObject *object,
                                                     uint64_t value) {
    SwypDevicePlatform *platform = (SwypDevicePlatform *)context;
    if (platform == NULL || platform->runtime_ops == NULL || platform->runtime_ops->control_write == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return platform->runtime_ops->control_write(platform->runtime_context, object, value);
}

static const SwypDeviceBrokerOps swyp_device_platform_ops = {
    .map_mmio = swyp_device_platform_map_mmio,
    .unmap_mmio = swyp_device_platform_unmap_mmio,
    .bind_irq = swyp_device_platform_bind_irq,
    .ack_irq = swyp_device_platform_ack_irq,
    .unbind_irq = swyp_device_platform_unbind_irq,
    .map_dma = swyp_device_platform_map_dma,
    .unmap_dma = swyp_device_platform_unmap_dma,
    .config_read = swyp_device_platform_config_read,
    .config_write = swyp_device_platform_config_write,
    .control_read = swyp_device_platform_control_read,
    .control_write = swyp_device_platform_control_write,
};

void swyp_device_platform_init(SwypDevicePlatform *platform, void *runtime_context,
                               const SwypDevicePlatformRuntimeOps *runtime_ops, SwypInterruptSource *interrupts,
                               uint32_t page_shift) {
    uint32_t i;
    if (platform == NULL) {
        return;
    }
    platform->runtime_context = runtime_context;
    platform->runtime_ops = runtime_ops;
    platform->interrupts = interrupts;
    platform->page_shift = page_shift;
    for (i = 0; i < SWYP_DEVICE_PLATFORM_RECORD_CAPACITY; ++i) {
        swyp_device_platform_record_clear(&platform->records[i]);
    }
}

const SwypDeviceBrokerOps *swyp_device_platform_broker_ops(void) {
    return &swyp_device_platform_ops;
}
