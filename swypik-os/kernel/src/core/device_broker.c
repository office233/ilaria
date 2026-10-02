#include "swypik/kernel/device_broker.h"

static SwypDeviceBrokerHandle swyp_device_broker_make_handle(uint32_t slot, uint32_t generation) {
    return ((uint64_t)generation << 32) | (uint64_t)(slot + 1u);
}

static SwypStatus swyp_device_broker_parse_handle(SwypDeviceBrokerHandle handle, uint32_t *slot,
                                                   uint32_t *generation) {
    uint32_t low = (uint32_t)(handle & UINT64_C(0xffffffff));
    uint32_t high = (uint32_t)(handle >> 32);
    if (slot == NULL || generation == NULL || low == 0u || low > SWYP_DEVICE_BROKER_RECORD_CAPACITY || high == 0u) {
        return SWYP_ERR_INVALID;
    }
    *slot = low - 1u;
    *generation = high;
    return SWYP_OK;
}

static void swyp_device_broker_record_init(SwypDeviceBrokerRecord *record) {
    if (record == NULL) {
        return;
    }
    record->generation = 1u;
    record->active = SWYP_DEVICE_BROKER_SLOT_FREE;
    record->kind = SWYP_DEVICE_BROKER_RECORD_INVALID;
    record->reserved0 = 0u;
    record->domain_id = 0u;
    record->lease_fence = 0u;
    record->capability = 0u;
    record->secondary_capability = 0u;
    record->operation_rights = 0u;
    record->backend_token = 0u;
}

static void swyp_device_broker_record_release(SwypDeviceBrokerRecord *record) {
    if (record == NULL) {
        return;
    }
    record->kind = SWYP_DEVICE_BROKER_RECORD_INVALID;
    record->reserved0 = 0u;
    record->domain_id = 0u;
    record->lease_fence = 0u;
    record->capability = 0u;
    record->secondary_capability = 0u;
    record->operation_rights = 0u;
    record->backend_token = 0u;
    if (record->generation == UINT32_MAX) {
        record->active = SWYP_DEVICE_BROKER_SLOT_RETIRED;
    } else {
        record->generation += 1u;
        record->active = SWYP_DEVICE_BROKER_SLOT_FREE;
    }
}

static SwypDeviceBrokerRecord *swyp_device_broker_free_record(SwypDeviceBroker *broker, uint32_t *slot_out) {
    uint32_t i;
    for (i = 0; i < SWYP_DEVICE_BROKER_RECORD_CAPACITY; ++i) {
        SwypDeviceBrokerRecord *record = &broker->records[i];
        if (record->active == SWYP_DEVICE_BROKER_SLOT_FREE && record->generation != 0u) {
            if (slot_out != NULL) {
                *slot_out = i;
            }
            return record;
        }
    }
    return NULL;
}

static SwypStatus swyp_device_broker_record_lookup(SwypDeviceBroker *broker, SwypDeviceBrokerHandle handle,
                                                    uint64_t domain_id, uint64_t lease_fence,
                                                    SwypDeviceBrokerRecordKind expected_kind,
                                                    SwypDeviceBrokerRecord **out_record) {
    uint32_t slot;
    uint32_t generation;
    SwypDeviceBrokerRecord *record;
    if (broker == NULL || out_record == NULL || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    *out_record = NULL;
    if (swyp_device_broker_parse_handle(handle, &slot, &generation) != SWYP_OK) {
        return SWYP_ERR_INVALID;
    }
    record = &broker->records[slot];
    if (record->generation != generation || record->active != SWYP_DEVICE_BROKER_SLOT_ACTIVE) {
        return SWYP_ERR_STALE;
    }
    if (record->reserved0 != 0u || record->domain_id != domain_id || record->lease_fence != lease_fence ||
        record->kind != expected_kind) {
        return SWYP_ERR_DENIED;
    }
    *out_record = record;
    return SWYP_OK;
}

static int swyp_device_broker_range_valid(const SwypCapabilityObject *object, uint64_t offset, uint64_t length) {
    return object != NULL && length != 0u && offset <= object->length && length <= object->length - offset;
}

static int swyp_device_broker_width_valid(uint32_t width_bytes) {
    return width_bytes == 1u || width_bytes == 2u || width_bytes == 4u;
}

static SwypStatus swyp_device_broker_resolve(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                              SwypCapabilityHandle capability, uint64_t required_rights,
                                              SwypCapabilityObjectType expected_type,
                                              const SwypCapabilityGrant **out_grant) {
    if (broker == NULL || broker->domains == NULL || broker->ops == NULL) {
        return SWYP_ERR_INVALID;
    }
    return swyp_driver_domain_resolve(broker->domains, domain_id, lease_fence, capability, required_rights,
                                      expected_type, out_grant);
}

static SwypStatus swyp_device_broker_resolve_record_capability(SwypDeviceBroker *broker,
                                                                const SwypDeviceBrokerRecord *record,
                                                                uint64_t required_rights,
                                                                SwypCapabilityObjectType expected_type,
                                                                const SwypCapabilityGrant **out_grant) {
    return swyp_device_broker_resolve(broker, record->domain_id, record->lease_fence, record->capability,
                                      required_rights, expected_type, out_grant);
}

void swyp_device_broker_init(SwypDeviceBroker *broker, SwypDriverDomainManager *domains, void *backend_context,
                             const SwypDeviceBrokerOps *ops) {
    uint32_t i;
    if (broker == NULL) {
        return;
    }
    broker->domains = domains;
    broker->backend_context = backend_context;
    broker->ops = ops;
    for (i = 0; i < SWYP_DEVICE_BROKER_RECORD_CAPACITY; ++i) {
        swyp_device_broker_record_init(&broker->records[i]);
    }
}

/* Failed acquisition may return an owned cleanup token, never a usable handle.
   Keep it in the existing revoke ledger; public lookups reject reserved0. */
static void swyp_device_broker_retain_cleanup(SwypDeviceBrokerRecord *record, SwypDeviceBrokerRecordKind kind,
                                             uint64_t domain_id, uint64_t lease_fence, uint64_t backend_token) {
    if (backend_token == 0u) {
        return;
    }
    record->active = SWYP_DEVICE_BROKER_SLOT_ACTIVE;
    record->kind = kind;
    record->reserved0 = 1u;
    record->domain_id = domain_id;
    record->lease_fence = lease_fence;
    record->backend_token = backend_token;
}

SwypStatus swyp_device_broker_map_mmio(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                       SwypCapabilityHandle capability, uint64_t offset, uint64_t length,
                                       uint64_t access_rights, SwypDeviceMapping *out_mapping) {
    const SwypCapabilityGrant *grant = NULL;
    SwypDeviceBrokerRecord *record;
    uint64_t required = SWYP_CAP_RIGHT_MAP | SWYP_CAP_RIGHT_READ;
    uint64_t mmu_flags = SWYP_MMU_USER | SWYP_MMU_DEVICE | SWYP_MMU_READ;
    uint64_t backend_token = 0u;
    uint64_t virtual_address = 0u;
    uint32_t slot = 0u;
    SwypStatus status;
    if (broker == NULL || out_mapping == NULL || access_rights == 0u ||
        (access_rights & ~(SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    out_mapping->handle = 0u;
    out_mapping->address = 0u;
    out_mapping->length = 0u;
    /* A direct x86-style memory mapping is inherently readable when present.
       Require READ authority even when the caller only intends to write. */
    if ((access_rights & SWYP_CAP_RIGHT_WRITE) != 0u) {
        required |= SWYP_CAP_RIGHT_WRITE;
        mmu_flags |= SWYP_MMU_WRITE;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, capability, required, SWYP_CAP_OBJECT_MMIO,
                                        &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (!swyp_device_broker_range_valid(&grant->object, offset, length)) {
        return SWYP_ERR_DENIED;
    }
    if (broker->ops->map_mmio == NULL || broker->ops->unmap_mmio == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    record = swyp_device_broker_free_record(broker, &slot);
    if (record == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = broker->ops->map_mmio(broker->backend_context, &grant->object, domain_id, lease_fence, offset, length,
                                   mmu_flags, &backend_token, &virtual_address);
    if (status != SWYP_OK) {
        swyp_device_broker_retain_cleanup(record, SWYP_DEVICE_BROKER_RECORD_MMIO, domain_id, lease_fence, backend_token);
        return status;
    }
    if (backend_token == 0u || virtual_address == 0u) {
        if (backend_token != 0u) {
            (void)broker->ops->unmap_mmio(broker->backend_context, backend_token);
        }
        return SWYP_ERR_CORRUPT;
    }
    record->active = SWYP_DEVICE_BROKER_SLOT_ACTIVE;
    record->kind = SWYP_DEVICE_BROKER_RECORD_MMIO;
    record->domain_id = domain_id;
    record->lease_fence = lease_fence;
    record->capability = capability;
    record->backend_token = backend_token;
    out_mapping->handle = swyp_device_broker_make_handle(slot, record->generation);
    out_mapping->address = virtual_address;
    out_mapping->length = length;
    return SWYP_OK;
}

SwypStatus swyp_device_broker_unmap_mmio(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                         SwypDeviceBrokerHandle mapping_handle) {
    SwypDeviceBrokerRecord *record;
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status = swyp_device_broker_record_lookup(broker, mapping_handle, domain_id, lease_fence,
                                                         SWYP_DEVICE_BROKER_RECORD_MMIO, &record);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_device_broker_resolve_record_capability(broker, record, SWYP_CAP_RIGHT_MAP, SWYP_CAP_OBJECT_MMIO,
                                                          &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->unmap_mmio == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    status = broker->ops->unmap_mmio(broker->backend_context, record->backend_token);
    if (status == SWYP_OK) {
        swyp_device_broker_record_release(record);
    }
    return status;
}

SwypStatus swyp_device_broker_bind_irq(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                       SwypCapabilityHandle capability, SwypDeviceIrqBinding *out_binding) {
    const SwypCapabilityGrant *grant = NULL;
    SwypDeviceBrokerRecord *record;
    uint64_t backend_token = 0u;
    uint32_t vector = 0u;
    uint32_t slot = 0u;
    SwypStatus status;
    if (broker == NULL || out_binding == NULL) {
        return SWYP_ERR_INVALID;
    }
    out_binding->handle = 0u;
    out_binding->vector = 0u;
    out_binding->reserved0 = 0u;
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, capability, SWYP_CAP_RIGHT_BIND,
                                        SWYP_CAP_OBJECT_INTERRUPT, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->bind_irq == NULL || broker->ops->unbind_irq == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    record = swyp_device_broker_free_record(broker, &slot);
    if (record == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = broker->ops->bind_irq(broker->backend_context, &grant->object, domain_id, lease_fence, &backend_token,
                                   &vector);
    if (status != SWYP_OK) {
        swyp_device_broker_retain_cleanup(record, SWYP_DEVICE_BROKER_RECORD_IRQ, domain_id, lease_fence, backend_token);
        return status;
    }
    if (backend_token == 0u || vector == 0u) {
        if (backend_token != 0u) {
            (void)broker->ops->unbind_irq(broker->backend_context, backend_token);
        }
        return SWYP_ERR_CORRUPT;
    }
    record->active = SWYP_DEVICE_BROKER_SLOT_ACTIVE;
    record->kind = SWYP_DEVICE_BROKER_RECORD_IRQ;
    record->domain_id = domain_id;
    record->lease_fence = lease_fence;
    record->capability = capability;
    record->backend_token = backend_token;
    out_binding->handle = swyp_device_broker_make_handle(slot, record->generation);
    out_binding->vector = vector;
    return SWYP_OK;
}

SwypStatus swyp_device_broker_ack_irq(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                      SwypDeviceBrokerHandle binding_handle) {
    SwypDeviceBrokerRecord *record;
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status = swyp_device_broker_record_lookup(broker, binding_handle, domain_id, lease_fence,
                                                         SWYP_DEVICE_BROKER_RECORD_IRQ, &record);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_device_broker_resolve_record_capability(broker, record, SWYP_CAP_RIGHT_ACK,
                                                          SWYP_CAP_OBJECT_INTERRUPT, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->ack_irq == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return broker->ops->ack_irq(broker->backend_context, record->backend_token);
}

SwypStatus swyp_device_broker_unbind_irq(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                         SwypDeviceBrokerHandle binding_handle) {
    SwypDeviceBrokerRecord *record;
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status = swyp_device_broker_record_lookup(broker, binding_handle, domain_id, lease_fence,
                                                         SWYP_DEVICE_BROKER_RECORD_IRQ, &record);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_device_broker_resolve_record_capability(broker, record, SWYP_CAP_RIGHT_BIND,
                                                          SWYP_CAP_OBJECT_INTERRUPT, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->unbind_irq == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    status = broker->ops->unbind_irq(broker->backend_context, record->backend_token);
    if (status == SWYP_OK) {
        swyp_device_broker_record_release(record);
    }
    return status;
}

SwypStatus swyp_device_broker_irq_backend_token(const SwypDeviceBroker *broker, uint64_t domain_id,
                                                uint64_t lease_fence, SwypDeviceBrokerHandle binding_handle,
                                                uint64_t *backend_token) {
    uint32_t slot;
    uint32_t generation;
    const SwypDeviceBrokerRecord *record;
    if (broker == NULL || backend_token == NULL || domain_id == 0u || lease_fence == 0u ||
        swyp_device_broker_parse_handle(binding_handle, &slot, &generation) != SWYP_OK) {
        return SWYP_ERR_INVALID;
    }
    *backend_token = 0u;
    record = &broker->records[slot];
    if (record->generation != generation || record->active != SWYP_DEVICE_BROKER_SLOT_ACTIVE) {
        return SWYP_ERR_STALE;
    }
    if (record->reserved0 != 0u || record->kind != SWYP_DEVICE_BROKER_RECORD_IRQ || record->domain_id != domain_id ||
        record->lease_fence != lease_fence || record->backend_token == 0u) {
        return SWYP_ERR_DENIED;
    }
    *backend_token = record->backend_token;
    return SWYP_OK;
}

SwypStatus swyp_device_broker_irq_handle_for_backend(const SwypDeviceBroker *broker, uint64_t domain_id,
                                                     uint64_t lease_fence, uint64_t backend_token,
                                                     SwypDeviceBrokerHandle *binding_handle) {
    uint32_t i;
    if (broker == NULL || binding_handle == NULL || domain_id == 0u || lease_fence == 0u || backend_token == 0u) {
        return SWYP_ERR_INVALID;
    }
    *binding_handle = 0u;
    for (i = 0u; i < SWYP_DEVICE_BROKER_RECORD_CAPACITY; ++i) {
        const SwypDeviceBrokerRecord *record = &broker->records[i];
        if (record->active == SWYP_DEVICE_BROKER_SLOT_ACTIVE && record->reserved0 == 0u &&
            record->kind == SWYP_DEVICE_BROKER_RECORD_IRQ &&
            record->domain_id == domain_id && record->lease_fence == lease_fence &&
            record->backend_token == backend_token) {
            *binding_handle = swyp_device_broker_make_handle(i, record->generation);
            return SWYP_OK;
        }
    }
    return SWYP_ERR_NOT_FOUND;
}

SwypStatus swyp_device_broker_map_dma(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                      SwypCapabilityHandle dma_capability, SwypCapabilityHandle memory_capability,
                                      uint64_t memory_offset, uint64_t length, uint64_t access_rights,
                                      SwypDeviceMapping *out_mapping) {
    const SwypCapabilityGrant *dma_grant = NULL;
    const SwypCapabilityGrant *memory_grant = NULL;
    SwypDeviceBrokerRecord *record;
    uint64_t required = SWYP_CAP_RIGHT_MAP;
    uint64_t memory_required = SWYP_CAP_RIGHT_MAP;
    uint64_t backend_token = 0u;
    uint64_t iova = 0u;
    uint64_t physical_address;
    uint32_t slot = 0u;
    SwypStatus status;
    if (broker == NULL || out_mapping == NULL || dma_capability == 0u || memory_capability == 0u || length == 0u ||
        access_rights == 0u ||
        (access_rights & ~(SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    out_mapping->handle = 0u;
    out_mapping->address = 0u;
    out_mapping->length = 0u;
    if ((access_rights & SWYP_CAP_RIGHT_READ) != 0u) {
        required |= SWYP_CAP_RIGHT_READ;
        memory_required |= SWYP_CAP_RIGHT_READ;
    }
    if ((access_rights & SWYP_CAP_RIGHT_WRITE) != 0u) {
        required |= SWYP_CAP_RIGHT_WRITE;
        memory_required |= SWYP_CAP_RIGHT_WRITE;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, dma_capability, required, SWYP_CAP_OBJECT_DMA,
                                        &dma_grant);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, memory_capability, memory_required,
                                        SWYP_CAP_OBJECT_SHARED_MEMORY, &memory_grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (length > dma_grant->object.length || !swyp_device_broker_range_valid(&memory_grant->object, memory_offset, length)) {
        return SWYP_ERR_DENIED;
    }
    if (memory_offset > UINT64_MAX - memory_grant->object.base) {
        return SWYP_ERR_INVALID;
    }
    physical_address = memory_grant->object.base + memory_offset;
    if (broker->ops->map_dma == NULL || broker->ops->unmap_dma == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    record = swyp_device_broker_free_record(broker, &slot);
    if (record == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = broker->ops->map_dma(broker->backend_context, &dma_grant->object, &memory_grant->object,
                                   physical_address, domain_id, lease_fence, length, access_rights, &backend_token,
                                   &iova);
    if (status != SWYP_OK) {
        swyp_device_broker_retain_cleanup(record, SWYP_DEVICE_BROKER_RECORD_DMA, domain_id, lease_fence, backend_token);
        return status;
    }
    if (backend_token == 0u || iova == 0u) {
        if (backend_token != 0u) {
            (void)broker->ops->unmap_dma(broker->backend_context, backend_token);
        }
        return SWYP_ERR_CORRUPT;
    }
    record->active = SWYP_DEVICE_BROKER_SLOT_ACTIVE;
    record->kind = SWYP_DEVICE_BROKER_RECORD_DMA;
    record->domain_id = domain_id;
    record->lease_fence = lease_fence;
    record->capability = dma_capability;
    record->secondary_capability = memory_capability;
    record->operation_rights = access_rights;
    record->backend_token = backend_token;
    out_mapping->handle = swyp_device_broker_make_handle(slot, record->generation);
    out_mapping->address = iova;
    out_mapping->length = length;
    return SWYP_OK;
}

SwypStatus swyp_device_broker_unmap_dma(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                        SwypDeviceBrokerHandle mapping_handle) {
    SwypDeviceBrokerRecord *record;
    const SwypCapabilityGrant *grant = NULL;
    const SwypCapabilityGrant *memory_grant = NULL;
    SwypStatus status = swyp_device_broker_record_lookup(broker, mapping_handle, domain_id, lease_fence,
                                                         SWYP_DEVICE_BROKER_RECORD_DMA, &record);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, record->secondary_capability,
                                        SWYP_CAP_RIGHT_MAP | record->operation_rights,
                                        SWYP_CAP_OBJECT_SHARED_MEMORY, &memory_grant);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_device_broker_resolve_record_capability(broker, record, SWYP_CAP_RIGHT_MAP, SWYP_CAP_OBJECT_DMA,
                                                          &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->unmap_dma == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    status = broker->ops->unmap_dma(broker->backend_context, record->backend_token);
    if (status == SWYP_OK) {
        swyp_device_broker_record_release(record);
    }
    return status;
}

SwypStatus swyp_device_broker_config_read(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                          SwypCapabilityHandle capability, uint64_t offset, uint32_t width_bytes,
                                          uint64_t *value) {
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status;
    if (value == NULL || !swyp_device_broker_width_valid(width_bytes)) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, capability, SWYP_CAP_RIGHT_READ,
                                        SWYP_CAP_OBJECT_DEVICE_CONFIG, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (!swyp_device_broker_range_valid(&grant->object, offset, width_bytes)) {
        return SWYP_ERR_DENIED;
    }
    if (((grant->object.base + offset) & (uint64_t)(width_bytes - 1u)) != 0u) {
        return SWYP_ERR_DENIED;
    }
    if (broker->ops->config_read == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return broker->ops->config_read(broker->backend_context, &grant->object, grant->object.base + offset,
                                    width_bytes, value);
}

SwypStatus swyp_device_broker_config_write(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                           SwypCapabilityHandle capability, uint64_t offset, uint32_t width_bytes,
                                           uint64_t value) {
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status;
    if (!swyp_device_broker_width_valid(width_bytes)) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, capability, SWYP_CAP_RIGHT_WRITE,
                                        SWYP_CAP_OBJECT_DEVICE_CONFIG, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (!swyp_device_broker_range_valid(&grant->object, offset, width_bytes)) {
        return SWYP_ERR_DENIED;
    }
    if (((grant->object.base + offset) & (uint64_t)(width_bytes - 1u)) != 0u) {
        return SWYP_ERR_DENIED;
    }
    if (broker->ops->config_write == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return broker->ops->config_write(broker->backend_context, &grant->object, grant->object.base + offset,
                                     width_bytes, value);
}

SwypStatus swyp_device_broker_control_read(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                           SwypCapabilityHandle capability, uint64_t *value) {
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status;
    if (value == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_device_broker_resolve(broker, domain_id, lease_fence, capability, SWYP_CAP_RIGHT_READ,
                                        SWYP_CAP_OBJECT_DEVICE_CONTROL, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->control_read == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return broker->ops->control_read(broker->backend_context, &grant->object, value);
}

SwypStatus swyp_device_broker_control_write(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                            SwypCapabilityHandle capability, uint64_t value) {
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status = swyp_device_broker_resolve(broker, domain_id, lease_fence, capability, SWYP_CAP_RIGHT_CONTROL,
                                                   SWYP_CAP_OBJECT_DEVICE_CONTROL, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (broker->ops->control_write == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return broker->ops->control_write(broker->backend_context, &grant->object, value);
}

static SwypStatus swyp_device_broker_cleanup_record(SwypDeviceBroker *broker, SwypDeviceBrokerRecord *record) {
    SwypStatus status;
    switch (record->kind) {
    case SWYP_DEVICE_BROKER_RECORD_MMIO:
        if (broker->ops->unmap_mmio == NULL) {
            return SWYP_ERR_UNSUPPORTED;
        }
        status = broker->ops->unmap_mmio(broker->backend_context, record->backend_token);
        break;
    case SWYP_DEVICE_BROKER_RECORD_IRQ:
        if (broker->ops->unbind_irq == NULL) {
            return SWYP_ERR_UNSUPPORTED;
        }
        status = broker->ops->unbind_irq(broker->backend_context, record->backend_token);
        break;
    case SWYP_DEVICE_BROKER_RECORD_DMA:
        if (broker->ops->unmap_dma == NULL) {
            return SWYP_ERR_UNSUPPORTED;
        }
        status = broker->ops->unmap_dma(broker->backend_context, record->backend_token);
        break;
    default:
        return SWYP_ERR_CORRUPT;
    }
    if (status == SWYP_OK) {
        swyp_device_broker_record_release(record);
    }
    return status;
}

SwypStatus swyp_device_broker_revoke_domain(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence) {
    SwypStatus status;
    SwypStatus first_error = SWYP_OK;
    uint32_t i;
    if (broker == NULL || broker->domains == NULL || broker->ops == NULL || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_driver_domain_quiesce(broker->domains, domain_id, lease_fence);
    if (status != SWYP_OK) {
        return status;
    }
    for (i = 0; i < SWYP_DEVICE_BROKER_RECORD_CAPACITY; ++i) {
        SwypDeviceBrokerRecord *record = &broker->records[i];
        if (record->active != SWYP_DEVICE_BROKER_SLOT_ACTIVE || record->domain_id != domain_id) {
            continue;
        }
        if (record->lease_fence != lease_fence) {
            return SWYP_ERR_CORRUPT;
        }
        status = swyp_device_broker_cleanup_record(broker, record);
        if (status != SWYP_OK && first_error == SWYP_OK) {
            first_error = status;
        }
    }
    if (first_error != SWYP_OK) {
        return first_error;
    }
    return swyp_driver_domain_revoke(broker->domains, domain_id, lease_fence);
}
