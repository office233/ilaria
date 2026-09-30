#include "swypik/kernel/capability.h"

static SwypCapabilityHandle swyp_make_handle(uint32_t slot, uint32_t generation) {
    return ((uint64_t)generation << 32) | (uint64_t)(slot + 1u);
}

static SwypStatus swyp_parse_handle(SwypCapabilityHandle handle, uint32_t *slot, uint32_t *generation) {
    uint32_t low = (uint32_t)(handle & UINT64_C(0xffffffff));
    uint32_t high = (uint32_t)(handle >> 32);
    if (low == 0u || low > SWYP_CAPABILITY_TABLE_CAPACITY || high == 0u) {
        return SWYP_ERR_INVALID;
    }
    *slot = low - 1u;
    *generation = high;
    return SWYP_OK;
}

void swyp_capability_table_init(SwypCapabilityTable *table) {
    uint32_t i;
    if (table == NULL) {
        return;
    }
    for (i = 0; i < SWYP_CAPABILITY_TABLE_CAPACITY; ++i) {
        table->entries[i].generation = 1u;
        table->entries[i].active = SWYP_CAPABILITY_SLOT_FREE;
        table->entries[i].grant.handle = 0u;
    }
}

uint64_t swyp_capability_allowed_rights(SwypCapabilityObjectType type) {
    switch (type) {
    case SWYP_CAP_OBJECT_MMIO:
        return SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP;
    case SWYP_CAP_OBJECT_PORT_IO:
        return SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE;
    case SWYP_CAP_OBJECT_INTERRUPT:
        return SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK;
    case SWYP_CAP_OBJECT_DMA:
        return SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP;
    case SWYP_CAP_OBJECT_DEVICE_CONFIG:
        return SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE;
    case SWYP_CAP_OBJECT_DEVICE_CONTROL:
        return SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_CONTROL;
    case SWYP_CAP_OBJECT_SHARED_MEMORY:
        return SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP;
    case SWYP_CAP_OBJECT_IPC_ENDPOINT:
        return SWYP_CAP_RIGHT_SEND | SWYP_CAP_RIGHT_RECEIVE;
    default:
        return 0u;
    }
}

SwypStatus swyp_capability_mint(SwypCapabilityTable *table, const SwypCapabilityObject *object, uint64_t rights,
                                uint64_t subject_domain, uint64_t lease_fence, SwypCapabilityHandle *out_handle) {
    uint32_t i;
    uint64_t allowed;
    if (table == NULL || object == NULL || out_handle == NULL || object->type == SWYP_CAP_OBJECT_INVALID ||
        subject_domain == 0u || lease_fence == 0u || rights == 0u) {
        return SWYP_ERR_INVALID;
    }
    allowed = swyp_capability_allowed_rights(object->type);
    if ((rights & ~allowed) != 0u) {
        return SWYP_ERR_DENIED;
    }
    for (i = 0; i < SWYP_CAPABILITY_TABLE_CAPACITY; ++i) {
        SwypCapabilityEntry *entry = &table->entries[i];
        if (entry->active == SWYP_CAPABILITY_SLOT_FREE) {
            SwypCapabilityHandle handle;
            if (entry->generation == 0u) {
                entry->active = SWYP_CAPABILITY_SLOT_RETIRED;
                continue;
            }
            handle = swyp_make_handle(i, entry->generation);
            entry->active = SWYP_CAPABILITY_SLOT_ACTIVE;
            entry->grant.handle = handle;
            entry->grant.rights = rights;
            entry->grant.subject_domain = subject_domain;
            entry->grant.lease_fence = lease_fence;
            entry->grant.object = *object;
            *out_handle = handle;
            return SWYP_OK;
        }
    }
    return SWYP_ERR_NO_SPACE;
}

SwypStatus swyp_capability_lookup(const SwypCapabilityTable *table, SwypCapabilityHandle handle,
                                  uint64_t subject_domain, uint64_t lease_fence, uint64_t required_rights,
                                  const SwypCapabilityGrant **out_grant) {
    uint32_t slot;
    uint32_t generation;
    const SwypCapabilityEntry *entry;
    if (table == NULL || out_grant == NULL || required_rights == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_parse_handle(handle, &slot, &generation) != SWYP_OK) {
        return SWYP_ERR_INVALID;
    }
    entry = &table->entries[slot];
    if (entry->generation != generation || entry->active != SWYP_CAPABILITY_SLOT_ACTIVE) {
        return SWYP_ERR_STALE;
    }
    if (entry->grant.subject_domain != subject_domain || entry->grant.lease_fence != lease_fence) {
        return SWYP_ERR_DENIED;
    }
    if ((entry->grant.rights & required_rights) != required_rights) {
        return SWYP_ERR_DENIED;
    }
    *out_grant = &entry->grant;
    return SWYP_OK;
}

SwypStatus swyp_capability_revoke(SwypCapabilityTable *table, SwypCapabilityHandle handle) {
    uint32_t slot;
    uint32_t generation;
    SwypCapabilityEntry *entry;
    if (table == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_parse_handle(handle, &slot, &generation) != SWYP_OK) {
        return SWYP_ERR_INVALID;
    }
    entry = &table->entries[slot];
    if (entry->generation != generation || entry->active != SWYP_CAPABILITY_SLOT_ACTIVE) {
        return SWYP_ERR_STALE;
    }
    entry->grant.handle = 0u;
    if (entry->generation == UINT32_MAX) {
        entry->active = SWYP_CAPABILITY_SLOT_RETIRED;
    } else {
        entry->generation += 1u;
        entry->active = SWYP_CAPABILITY_SLOT_FREE;
    }
    return SWYP_OK;
}
