#include "swypik/kernel/driver_domain.h"

static void swyp_driver_domain_clear(SwypDriverDomain *domain) {
    uint16_t i;
    if (domain == NULL) {
        return;
    }
    domain->domain_id = 0u;
    domain->node_id = 0u;
    domain->lease_fence = 0u;
    domain->grant_count = 0u;
    domain->active = SWYP_DRIVER_DOMAIN_FREE;
    domain->reserved0 = 0u;
    for (i = 0; i < SWYP_DRIVER_DOMAIN_MAX_GRANTS; ++i) {
        domain->grants[i] = 0u;
    }
}

static int swyp_driver_domain_graph_has_node(const SwypDeviceGraph *graph, uint64_t node_id) {
    uint16_t i;
    for (i = 0; i < graph->node_count; ++i) {
        if (graph->nodes[i].id == node_id) {
            return 1;
        }
    }
    return 0;
}

static SwypDriverDomain *swyp_driver_domain_find(SwypDriverDomainManager *manager, uint64_t domain_id) {
    uint16_t i;
    for (i = 0; i < SWYP_DRIVER_DOMAIN_CAPACITY; ++i) {
        SwypDriverDomain *domain = &manager->domains[i];
        if (domain->active != SWYP_DRIVER_DOMAIN_FREE && domain->domain_id == domain_id) {
            return domain;
        }
    }
    return NULL;
}

static const SwypDriverDomain *swyp_driver_domain_find_const(const SwypDriverDomainManager *manager, uint64_t domain_id) {
    uint16_t i;
    for (i = 0; i < SWYP_DRIVER_DOMAIN_CAPACITY; ++i) {
        const SwypDriverDomain *domain = &manager->domains[i];
        if (domain->active != SWYP_DRIVER_DOMAIN_FREE && domain->domain_id == domain_id) {
            return domain;
        }
    }
    return NULL;
}

static SwypDriverDomain *swyp_driver_domain_free_slot(SwypDriverDomainManager *manager) {
    uint16_t i;
    for (i = 0; i < SWYP_DRIVER_DOMAIN_CAPACITY; ++i) {
        if (manager->domains[i].active == SWYP_DRIVER_DOMAIN_FREE) {
            return &manager->domains[i];
        }
    }
    return NULL;
}

static uint16_t swyp_driver_domain_available_capability_slots(const SwypCapabilityTable *table) {
    uint16_t available = 0u;
    uint32_t i;
    for (i = 0; i < SWYP_CAPABILITY_TABLE_CAPACITY; ++i) {
        const SwypCapabilityEntry *entry = &table->entries[i];
        if (entry->active == SWYP_CAPABILITY_SLOT_FREE && entry->generation != 0u) {
            available += 1u;
        }
    }
    return available;
}

static int swyp_driver_domain_ranges_overlap(const SwypCapabilityObject *left, const SwypCapabilityObject *right) {
    uint64_t left_end;
    uint64_t right_end;
    if (left->length == 0u || right->length == 0u || left->length > UINT64_MAX - left->base ||
        right->length > UINT64_MAX - right->base) {
        return 0;
    }
    left_end = left->base + left->length;
    right_end = right->base + right->length;
    return left->base < right_end && right->base < left_end;
}

static int swyp_driver_domain_objects_conflict(const SwypCapabilityObject *left, const SwypCapabilityObject *right) {
    if (left->type != right->type) {
        return 0;
    }
    switch (left->type) {
    case SWYP_CAP_OBJECT_MMIO:
    case SWYP_CAP_OBJECT_PORT_IO:
    case SWYP_CAP_OBJECT_DMA:
    case SWYP_CAP_OBJECT_SHARED_MEMORY:
        return swyp_driver_domain_ranges_overlap(left, right);
    case SWYP_CAP_OBJECT_INTERRUPT:
    case SWYP_CAP_OBJECT_DEVICE_CONFIG:
    case SWYP_CAP_OBJECT_DEVICE_CONTROL:
        return left->object_id == right->object_id && swyp_driver_domain_ranges_overlap(left, right);
    default:
        return 0;
    }
}

static int swyp_driver_domain_object_is_owned(const SwypCapabilityTable *table, const SwypCapabilityObject *object) {
    uint32_t i;
    for (i = 0; i < SWYP_CAPABILITY_TABLE_CAPACITY; ++i) {
        const SwypCapabilityEntry *entry = &table->entries[i];
        if (entry->active == SWYP_CAPABILITY_SLOT_ACTIVE && swyp_driver_domain_objects_conflict(&entry->grant.object, object)) {
            return 1;
        }
    }
    return 0;
}

static int swyp_driver_domain_owns_handle(const SwypDriverDomain *domain, SwypCapabilityHandle handle) {
    uint16_t i;
    for (i = 0; i < domain->grant_count; ++i) {
        if (domain->grants[i] == handle) {
            return 1;
        }
    }
    return 0;
}

void swyp_driver_domain_policy_init(SwypDriverDomainPolicy *policy) {
    uint16_t i;
    if (policy == NULL) {
        return;
    }
    for (i = 0; i < SWYP_DEVICE_GRAPH_MAX_RESOURCES; ++i) {
        policy->resource_rights[i] = 0u;
    }
}

SwypStatus swyp_driver_domain_policy_allow_resource(SwypDriverDomainPolicy *policy, uint16_t resource_index,
                                                     uint64_t rights) {
    if (policy == NULL || resource_index >= SWYP_DEVICE_GRAPH_MAX_RESOURCES || rights == 0u) {
        return SWYP_ERR_INVALID;
    }
    policy->resource_rights[resource_index] = rights;
    return SWYP_OK;
}

static int swyp_driver_domain_resource_equal(const SwypDeviceResource *left, const SwypDeviceResource *right) {
    return left->node_id == right->node_id && left->kind == right->kind && left->flags == right->flags &&
           left->reserved0 == right->reserved0 && left->start == right->start && left->length == right->length &&
           left->aux == right->aux;
}

SwypStatus swyp_driver_domain_policy_allow_exact_resource(SwypDriverDomainPolicy *policy, const SwypDeviceGraph *graph,
                                                           const SwypDeviceResource *resource, uint64_t rights) {
    uint16_t i;
    uint16_t match = 0u;
    uint16_t match_count = 0u;
    if (policy == NULL || graph == NULL || resource == NULL || rights == 0u ||
        swyp_device_graph_validate(graph) != SWYP_OK) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0; i < graph->resource_count; ++i) {
        if (swyp_driver_domain_resource_equal(&graph->resources[i], resource)) {
            match = i;
            match_count += 1u;
        }
    }
    if (match_count == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (match_count != 1u) {
        return SWYP_ERR_CORRUPT;
    }
    return swyp_driver_domain_policy_allow_resource(policy, match, rights);
}

void swyp_driver_domain_manager_init(SwypDriverDomainManager *manager, SwypCapabilityTable *capability_table) {
    uint16_t i;
    if (manager == NULL) {
        return;
    }
    manager->capability_table = capability_table;
    for (i = 0; i < SWYP_DRIVER_DOMAIN_CAPACITY; ++i) {
        swyp_driver_domain_clear(&manager->domains[i]);
    }
}

SwypStatus swyp_driver_domain_open(SwypDriverDomainManager *manager, const SwypDeviceGraph *graph, uint64_t node_id,
                                   uint64_t domain_id, uint64_t lease_fence, const SwypDriverDomainPolicy *policy,
                                   const SwypDriverDomain **out_domain) {
    SwypDriverDomain *slot;
    SwypCapabilityHandle minted[SWYP_DRIVER_DOMAIN_MAX_GRANTS];
    uint16_t grant_count = 0u;
    uint16_t i;
    if (manager == NULL || manager->capability_table == NULL || graph == NULL || policy == NULL || out_domain == NULL ||
        node_id == 0u || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    *out_domain = NULL;
    if (swyp_device_graph_validate(graph) != SWYP_OK || !swyp_driver_domain_graph_has_node(graph, node_id)) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_driver_domain_find(manager, domain_id) != NULL) {
        return SWYP_ERR_DENIED;
    }
    slot = swyp_driver_domain_free_slot(manager);
    if (slot == NULL) {
        return SWYP_ERR_NO_SPACE;
    }

    for (i = 0; i < graph->resource_count; ++i) {
        uint64_t rights = policy->resource_rights[i];
        SwypCapabilityObject object;
        uint64_t allowed_rights = 0u;
        SwypStatus status;
        if (rights == 0u) {
            continue;
        }
        if (graph->resources[i].node_id != node_id) {
            return SWYP_ERR_DENIED;
        }
        status = swyp_device_resource_capability(&graph->resources[i], &object, &allowed_rights);
        if (status != SWYP_OK) {
            return status;
        }
        if ((rights & ~allowed_rights) != 0u) {
            return SWYP_ERR_DENIED;
        }
		if (swyp_driver_domain_object_is_owned(manager->capability_table, &object)) {
			return SWYP_ERR_DENIED;
		}
        grant_count += 1u;
    }
    for (i = graph->resource_count; i < SWYP_DEVICE_GRAPH_MAX_RESOURCES; ++i) {
        if (policy->resource_rights[i] != 0u) {
            return SWYP_ERR_INVALID;
        }
    }
    if (grant_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (grant_count > SWYP_DRIVER_DOMAIN_MAX_GRANTS ||
        grant_count > swyp_driver_domain_available_capability_slots(manager->capability_table)) {
        return SWYP_ERR_NO_SPACE;
    }

    grant_count = 0u;
    for (i = 0; i < graph->resource_count; ++i) {
        uint64_t rights = policy->resource_rights[i];
        SwypCapabilityObject object;
        uint64_t allowed_rights = 0u;
        SwypCapabilityHandle handle = 0u;
        SwypStatus status;
        if (rights == 0u) {
            continue;
        }
        status = swyp_device_resource_capability(&graph->resources[i], &object, &allowed_rights);
        if (status == SWYP_OK) {
            status = swyp_capability_mint(manager->capability_table, &object, rights, domain_id, lease_fence, &handle);
        }
        if (status != SWYP_OK) {
            uint16_t rollback;
            for (rollback = 0; rollback < grant_count; ++rollback) {
                (void)swyp_capability_revoke(manager->capability_table, minted[rollback]);
            }
            return status;
        }
        minted[grant_count++] = handle;
    }

    swyp_driver_domain_clear(slot);
    slot->domain_id = domain_id;
    slot->node_id = node_id;
    slot->lease_fence = lease_fence;
    slot->grant_count = grant_count;
    for (i = 0; i < grant_count; ++i) {
        slot->grants[i] = minted[i];
    }
    slot->active = SWYP_DRIVER_DOMAIN_ACTIVE;
    *out_domain = slot;
    return SWYP_OK;
}

SwypStatus swyp_driver_domain_resolve(const SwypDriverDomainManager *manager, uint64_t domain_id, uint64_t lease_fence,
                                      SwypCapabilityHandle handle, uint64_t required_rights,
                                      SwypCapabilityObjectType expected_type, const SwypCapabilityGrant **out_grant) {
    const SwypDriverDomain *domain;
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status;
    if (manager == NULL || manager->capability_table == NULL || out_grant == NULL || domain_id == 0u ||
        lease_fence == 0u || handle == 0u || required_rights == 0u) {
        return SWYP_ERR_INVALID;
    }
    *out_grant = NULL;
    domain = swyp_driver_domain_find_const(manager, domain_id);
    if (domain == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (domain->active != SWYP_DRIVER_DOMAIN_ACTIVE) {
        return SWYP_ERR_DENIED;
    }
    if (domain->lease_fence != lease_fence) {
        return SWYP_ERR_DENIED;
    }
    if (!swyp_driver_domain_owns_handle(domain, handle)) {
        return SWYP_ERR_DENIED;
    }
    status = swyp_capability_lookup(manager->capability_table, handle, domain_id, lease_fence, required_rights, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (grant->object.object_id != domain->node_id) {
        return SWYP_ERR_DENIED;
    }
    if (expected_type != SWYP_CAP_OBJECT_INVALID && grant->object.type != expected_type) {
        return SWYP_ERR_DENIED;
    }
    *out_grant = grant;
    return SWYP_OK;
}

SwypStatus swyp_driver_domain_quiesce(SwypDriverDomainManager *manager, uint64_t domain_id, uint64_t lease_fence) {
    SwypDriverDomain *domain;
    if (manager == NULL || manager->capability_table == NULL || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_driver_domain_find(manager, domain_id);
    if (domain == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (domain->lease_fence != lease_fence) {
        return SWYP_ERR_DENIED;
    }
    if (domain->active == SWYP_DRIVER_DOMAIN_QUIESCED) {
        return SWYP_OK;
    }
    if (domain->active != SWYP_DRIVER_DOMAIN_ACTIVE) {
        return SWYP_ERR_DENIED;
    }
    domain->active = SWYP_DRIVER_DOMAIN_QUIESCED;
    return SWYP_OK;
}

SwypStatus swyp_driver_domain_revoke(SwypDriverDomainManager *manager, uint64_t domain_id, uint64_t lease_fence) {
    SwypDriverDomain *domain;
    SwypStatus first_error = SWYP_OK;
    uint16_t i;
    int remaining = 0;
    if (manager == NULL || manager->capability_table == NULL || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_driver_domain_find(manager, domain_id);
    if (domain == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (domain->lease_fence != lease_fence) {
        return SWYP_ERR_DENIED;
    }
    if (domain->active != SWYP_DRIVER_DOMAIN_QUIESCED) {
        return SWYP_ERR_DENIED;
    }
    for (i = 0; i < domain->grant_count; ++i) {
        SwypStatus status;
        if (domain->grants[i] == 0u) {
            continue;
        }
        status = swyp_capability_revoke(manager->capability_table, domain->grants[i]);
        if (status == SWYP_OK || status == SWYP_ERR_STALE) {
            domain->grants[i] = 0u;
        } else {
            remaining = 1;
            if (first_error == SWYP_OK) {
                first_error = status;
            }
        }
    }
    if (!remaining) {
        swyp_driver_domain_clear(domain);
    }
    return first_error;
}
