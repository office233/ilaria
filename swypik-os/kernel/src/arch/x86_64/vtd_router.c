#include "swypik/arch/x86_64/vtd_router.h"

static int swyp_vtd_router_requester(uint64_t aux, uint16_t *segment, uint8_t *bus, uint8_t *device,
                                     uint8_t *function) {
    uint8_t devfn;
    if ((aux & ~UINT64_C(0xffffffff)) != 0u || segment == NULL || bus == NULL || device == NULL || function == NULL) {
        return 0;
    }
    *segment = (uint16_t)((aux >> 16) & UINT64_C(0xffff));
    *bus = (uint8_t)((aux >> 8) & UINT64_C(0xff));
    devfn = (uint8_t)(aux & UINT64_C(0xff));
    *device = (uint8_t)(devfn >> 3);
    *function = (uint8_t)(devfn & 7u);
    return *device <= 31u;
}

static SwypX86VtdRouteBinding *swyp_vtd_router_binding(SwypX86VtdRouter *router, uint64_t domain_id,
                                                        uint64_t device_id) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_ROUTER_BINDING_CAPACITY; ++i) {
        if (router->bindings[i].active != 0u && router->bindings[i].domain_id == domain_id &&
            router->bindings[i].device_id == device_id) {
            return &router->bindings[i];
        }
    }
    return NULL;
}

static SwypX86VtdRouteBinding *swyp_vtd_router_free_binding(SwypX86VtdRouter *router) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_ROUTER_BINDING_CAPACITY; ++i) {
        if (router->bindings[i].active == 0u) {
            return &router->bindings[i];
        }
    }
    return NULL;
}

static SwypX86VtdRmrrAuthorization *swyp_vtd_router_rmrr_authorization(SwypX86VtdRouter *router,
                                                                       uint64_t domain_id, uint64_t device_id,
                                                                       uint64_t requester_aux) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_ROUTER_BINDING_CAPACITY; ++i) {
        SwypX86VtdRmrrAuthorization *authorization = &router->rmrr_authorizations[i];
        if (authorization->active != 0u && authorization->domain_id == domain_id &&
            authorization->device_id == device_id && authorization->requester_aux == requester_aux) {
            return authorization;
        }
    }
    return NULL;
}

static SwypX86VtdRmrrAuthorization *swyp_vtd_router_free_rmrr_authorization(SwypX86VtdRouter *router) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_ROUTER_BINDING_CAPACITY; ++i) {
        if (router->rmrr_authorizations[i].active == 0u) {
            return &router->rmrr_authorizations[i];
        }
    }
    return NULL;
}

static int swyp_vtd_router_page_range(uint64_t base, uint64_t length) {
    return length != 0u && (base & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) == 0u &&
           (length & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) == 0u && length - 1u <= UINT64_MAX - base;
}

static SwypStatus swyp_vtd_router_pci_read32(SwypX86VtdRouter *router, uint16_t segment, uint8_t bus,
                                             uint8_t device, uint8_t function, uint64_t offset, uint32_t *value) {
    SwypCapabilityObject object = {0};
    uint64_t read_value = 0u;
    SwypStatus status;
    if (router == NULL || router->pci == NULL || value == NULL || device > 31u || function > 7u ||
        (offset & UINT64_C(3)) != 0u || offset >= UINT64_C(4096)) {
        return SWYP_ERR_UNSUPPORTED;
    }
    object.type = SWYP_CAP_OBJECT_DEVICE_CONFIG;
    object.base = 0u;
    object.length = UINT64_C(4096);
    object.aux = swyp_x86_pci_config_aux(segment, bus, device, function);
    if (object.aux == UINT64_MAX) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_pci_ecam_read(router->pci, &object, offset, 4u, &read_value);
    if (status != SWYP_OK) {
        return status == SWYP_ERR_NOT_FOUND ? SWYP_ERR_UNSUPPORTED : status;
    }
    *value = (uint32_t)read_value;
    return SWYP_OK;
}

static SwypStatus swyp_vtd_router_bridge_buses(SwypX86VtdRouter *router, uint16_t segment, uint8_t bus,
                                                uint8_t device, uint8_t function, uint8_t *secondary,
                                                uint8_t *subordinate) {
    uint32_t class_register = 0u;
    uint32_t bus_register = 0u;
    SwypStatus status;
    if (secondary == NULL || subordinate == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_vtd_router_pci_read32(router, segment, bus, device, function, UINT64_C(0x08), &class_register);
    if (status != SWYP_OK) {
        return status;
    }
    if (((class_register >> 24) & UINT32_C(0xff)) != UINT32_C(0x06) ||
        ((class_register >> 16) & UINT32_C(0xff)) != UINT32_C(0x04)) {
        return SWYP_ERR_CORRUPT;
    }
    status = swyp_vtd_router_pci_read32(router, segment, bus, device, function, UINT64_C(0x18), &bus_register);
    if (status != SWYP_OK) {
        return status;
    }
    if ((uint8_t)(bus_register & UINT32_C(0xff)) != bus) {
        return SWYP_ERR_CORRUPT;
    }
    *secondary = (uint8_t)((bus_register >> 8) & UINT32_C(0xff));
    *subordinate = (uint8_t)((bus_register >> 16) & UINT32_C(0xff));
    if (*secondary == 0u || *secondary > *subordinate) {
        return SWYP_ERR_UNSUPPORTED;
    }
    return SWYP_OK;
}

static SwypStatus swyp_vtd_router_scope_match(SwypX86VtdRouter *router, const SwypAcpiDmarScope *scope,
                                              uint16_t segment, uint8_t bus, uint8_t device, uint8_t function,
                                              int *matches) {
    uint8_t current_bus;
    uint32_t i;
    if (scope == NULL || matches == NULL) {
        return SWYP_ERR_INVALID;
    }
    *matches = 0;
    if (scope->segment != segment || (scope->type != 1u && scope->type != 2u)) {
        return SWYP_OK;
    }
    if (scope->path_count == 0u || scope->path_count > SWYP_ACPI_MAX_DMAR_SCOPE_PATH) {
        return SWYP_ERR_CORRUPT;
    }
    if (scope->path_count == 1u && scope->type == 1u) {
        *matches = scope->start_bus == bus && scope->path[0].device == device && scope->path[0].function == function;
        return SWYP_OK;
    }
    if (router->pci == NULL) {
        return SWYP_ERR_UNSUPPORTED;
    }
    current_bus = scope->start_bus;
    for (i = 0u; i < scope->path_count; ++i) {
        const SwypAcpiDmarPathElement *path = &scope->path[i];
        int last = i + 1u == scope->path_count;
        if (last && scope->type == 1u) {
            *matches = current_bus == bus && path->device == device && path->function == function;
            return SWYP_OK;
        }
        {
            uint8_t secondary = 0u;
            uint8_t subordinate = 0u;
            SwypStatus status = swyp_vtd_router_bridge_buses(router, segment, current_bus, path->device,
                                                             path->function, &secondary, &subordinate);
            if (status != SWYP_OK) {
                return status;
            }
            if (last && scope->type == 2u) {
                *matches = bus >= secondary && bus <= subordinate;
                return SWYP_OK;
            }
            current_bus = secondary;
        }
    }
    return SWYP_ERR_CORRUPT;
}

static SwypStatus swyp_vtd_router_select_unit(SwypX86VtdRouter *router, uint16_t segment, uint8_t bus,
                                               uint8_t device, uint8_t function, uint32_t *unit_index) {
    uint32_t exact = UINT32_MAX;
    uint32_t include_all = UINT32_MAX;
    uint32_t i;
    if (router == NULL || router->acpi == NULL || unit_index == NULL) {
        return SWYP_ERR_INVALID;
    }
    *unit_index = UINT32_MAX;
    for (i = 0u; i < router->acpi->dmar_unit_count; ++i) {
        const SwypAcpiDmarUnit *unit = &router->acpi->dmar_units[i];
        uint32_t j;
        if (unit->segment != segment) {
            continue;
        }
        if ((unit->flags & 1u) != 0u) {
            if (include_all != UINT32_MAX) {
                return SWYP_ERR_CORRUPT;
            }
            include_all = i;
        }
        if ((uint32_t)unit->first_scope + unit->scope_count > router->acpi->dmar_scope_count) {
            return SWYP_ERR_CORRUPT;
        }
        for (j = 0u; j < unit->scope_count; ++j) {
            int matches = 0;
            SwypStatus status = swyp_vtd_router_scope_match(router,
                                                             &router->acpi->dmar_scopes[unit->first_scope + j],
                                                             segment, bus, device, function, &matches);
            if (status != SWYP_OK) {
                return status;
            }
            if (matches) {
                if (exact != UINT32_MAX && exact != i) {
                    return SWYP_ERR_CORRUPT;
                }
                exact = i;
            }
        }
    }
    if (exact != UINT32_MAX) {
        *unit_index = exact;
        return SWYP_OK;
    }
    if (include_all != UINT32_MAX) {
        *unit_index = include_all;
        return SWYP_OK;
    }
    return SWYP_ERR_NOT_FOUND;
}

static SwypStatus swyp_vtd_router_reserved(SwypX86VtdRouter *router, uint16_t segment, uint8_t bus,
                                            uint8_t device, uint8_t function, uint64_t *base, uint64_t *limit) {
    uint32_t i;
    int found = 0;
    uint64_t found_base = 0u;
    uint64_t found_limit = 0u;
    if (router == NULL || router->acpi == NULL || base == NULL || limit == NULL) {
        return SWYP_ERR_INVALID;
    }
    *base = 0u;
    *limit = 0u;
    for (i = 0u; i < router->acpi->dmar_reserved_count; ++i) {
        const SwypAcpiDmarReserved *reserved = &router->acpi->dmar_reserved[i];
        uint32_t j;
        if (reserved->segment != segment) {
            continue;
        }
        if ((uint32_t)reserved->first_scope + reserved->scope_count > router->acpi->dmar_scope_count) {
            return SWYP_ERR_CORRUPT;
        }
        for (j = 0u; j < reserved->scope_count; ++j) {
            int matches = 0;
            SwypStatus status = swyp_vtd_router_scope_match(router,
                                                             &router->acpi->dmar_scopes[reserved->first_scope + j],
                                                             segment, bus, device, function, &matches);
            if (status != SWYP_OK) {
                return status;
            }
            if (!matches) {
                continue;
            }
            if (found && (found_base != reserved->base || found_limit != reserved->limit)) {
                return SWYP_ERR_UNSUPPORTED;
            }
            found = 1;
            found_base = reserved->base;
            found_limit = reserved->limit;
        }
    }
    if (!found) {
        return SWYP_ERR_NOT_FOUND;
    }
    *base = found_base;
    *limit = found_limit;
    return SWYP_OK;
}

static SwypStatus swyp_vtd_router_attach(void *context, uint64_t domain_id, uint64_t device_id,
                                         uint64_t requester_aux) {
    SwypX86VtdRouter *router = (SwypX86VtdRouter *)context;
    SwypX86VtdRouteBinding *binding;
    const SwypX86IommuHardwareOps *ops = swyp_x86_vtd_iommu_ops();
    uint16_t segment;
    uint8_t bus;
    uint8_t device;
    uint8_t function;
    uint32_t unit_index = UINT32_MAX;
    uint64_t reserved_base = 0u;
    uint64_t reserved_limit = 0u;
    uint64_t reserved_length = 0u;
    SwypX86VtdRmrrAuthorization *authorization = NULL;
    SwypX86VtdRmrrAuthorization consumed_authorization = {0};
    SwypStatus status;
    if (router == NULL || router->failed != 0u || router->acpi == NULL || domain_id == 0u || device_id == 0u ||
        ops == NULL || ops->attach_device == NULL || !swyp_vtd_router_requester(requester_aux, &segment, &bus, &device,
                                                                                &function) ||
        swyp_vtd_router_binding(router, domain_id, device_id) != NULL) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_vtd_router_reserved(router, segment, bus, device, function, &reserved_base, &reserved_limit);
    if (status == SWYP_OK) {
        if (reserved_limit == UINT64_MAX || reserved_limit < reserved_base) {
            return SWYP_ERR_CORRUPT;
        }
        reserved_length = reserved_limit - reserved_base + 1u;
        if (!swyp_vtd_router_page_range(reserved_base, reserved_length)) {
            return SWYP_ERR_UNSUPPORTED;
        }
        authorization = swyp_vtd_router_rmrr_authorization(router, domain_id, device_id, requester_aux);
        if (authorization == NULL || authorization->base != reserved_base || authorization->length != reserved_length) {
            if (authorization != NULL) {
                *authorization = (SwypX86VtdRmrrAuthorization){0};
            }
            return SWYP_ERR_DENIED;
        }
        consumed_authorization = *authorization;
        *authorization = (SwypX86VtdRmrrAuthorization){0};
        authorization = &consumed_authorization;
    }
    if (status != SWYP_OK && status != SWYP_ERR_NOT_FOUND) {
        return status;
    }
    status = swyp_vtd_router_select_unit(router, segment, bus, device, function, &unit_index);
    if (status != SWYP_OK) {
        return status;
    }
    if (unit_index >= router->unit_count || router->units[unit_index] == NULL ||
        !swyp_x86_vtd_is_enabled(router->units[unit_index])) {
        return SWYP_ERR_CORRUPT;
    }
    binding = swyp_vtd_router_free_binding(router);
    if (binding == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    status = ops->attach_device(router->units[unit_index], domain_id, device_id, requester_aux);
    if (status != SWYP_OK) {
        return status;
    }
    if (authorization != NULL) {
        uint64_t page_count = authorization->length / SWYP_X86_IOMMU_PAGE_SIZE;
        status = ops->map_pages(router->units[unit_index], domain_id, device_id, authorization->base,
                                authorization->base, page_count, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE);
        if (status == SWYP_OK) {
            status = ops->invalidate_domain(router->units[unit_index], domain_id);
        }
        if (status != SWYP_OK) {
            SwypStatus rollback_map = ops->unmap_pages(router->units[unit_index], domain_id, device_id,
                                                       authorization->base, page_count);
            SwypStatus rollback_invalidate = ops->invalidate_domain(router->units[unit_index], domain_id);
            SwypStatus rollback_detach = ops->detach_device(router->units[unit_index], domain_id, device_id);
            if ((rollback_map != SWYP_OK && rollback_map != SWYP_ERR_NOT_FOUND) ||
                rollback_invalidate != SWYP_OK || rollback_detach != SWYP_OK) {
                router->failed = 1u;
                return SWYP_ERR_CORRUPT;
            }
            return status;
        }
    }
    *binding = (SwypX86VtdRouteBinding){
        .active = 1u,
        .unit_index = unit_index,
        .domain_id = domain_id,
        .device_id = device_id,
        .requester_aux = requester_aux,
        .rmrr_base = authorization != NULL ? authorization->base : 0u,
        .rmrr_length = authorization != NULL ? authorization->length : 0u,
        .rmrr_hardware_mapped = authorization != NULL ? 1u : 0u,
    };
    return SWYP_OK;
}

static SwypStatus swyp_vtd_router_detach(void *context, uint64_t domain_id, uint64_t device_id) {
    SwypX86VtdRouter *router = (SwypX86VtdRouter *)context;
    SwypX86VtdRouteBinding *binding;
    const SwypX86IommuHardwareOps *ops = swyp_x86_vtd_iommu_ops();
    SwypStatus status;
    if (router == NULL || router->failed != 0u || ops == NULL || ops->detach_device == NULL) {
        return SWYP_ERR_INVALID;
    }
    binding = swyp_vtd_router_binding(router, domain_id, device_id);
    if (binding == NULL || binding->unit_index >= router->unit_count || router->units[binding->unit_index] == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (binding->rmrr_hardware_mapped != 0u) {
        uint64_t page_count = binding->rmrr_length / SWYP_X86_IOMMU_PAGE_SIZE;
        status = ops->unmap_pages(router->units[binding->unit_index], domain_id, device_id, binding->rmrr_base,
                                  page_count);
        if (status != SWYP_OK) {
            return status;
        }
        binding->rmrr_hardware_mapped = 0u;
    }
    if (binding->rmrr_length != 0u) {
        status = ops->invalidate_domain(router->units[binding->unit_index], domain_id);
        if (status != SWYP_OK) {
            return status;
        }
    }
    status = ops->detach_device(router->units[binding->unit_index], domain_id, device_id);
    if (status == SWYP_OK) {
        *binding = (SwypX86VtdRouteBinding){0};
    }
    return status;
}

static SwypStatus swyp_vtd_router_map(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                                      uint64_t physical_address, uint64_t page_count, uint64_t access_rights) {
    SwypX86VtdRouter *router = (SwypX86VtdRouter *)context;
    SwypX86VtdRouteBinding *binding;
    const SwypX86IommuHardwareOps *ops = swyp_x86_vtd_iommu_ops();
    if (router == NULL || router->failed != 0u || ops == NULL || ops->map_pages == NULL) {
        return SWYP_ERR_INVALID;
    }
    binding = swyp_vtd_router_binding(router, domain_id, device_id);
    if (binding == NULL || binding->unit_index >= router->unit_count || router->units[binding->unit_index] == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    return ops->map_pages(router->units[binding->unit_index], domain_id, device_id, iova, physical_address, page_count,
                          access_rights);
}

static SwypStatus swyp_vtd_router_unmap(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                                        uint64_t page_count) {
    SwypX86VtdRouter *router = (SwypX86VtdRouter *)context;
    SwypX86VtdRouteBinding *binding;
    const SwypX86IommuHardwareOps *ops = swyp_x86_vtd_iommu_ops();
    if (router == NULL || router->failed != 0u || ops == NULL || ops->unmap_pages == NULL) {
        return SWYP_ERR_INVALID;
    }
    binding = swyp_vtd_router_binding(router, domain_id, device_id);
    if (binding == NULL || binding->unit_index >= router->unit_count || router->units[binding->unit_index] == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    return ops->unmap_pages(router->units[binding->unit_index], domain_id, device_id, iova, page_count);
}

static SwypStatus swyp_vtd_router_invalidate(void *context, uint64_t domain_id) {
    SwypX86VtdRouter *router = (SwypX86VtdRouter *)context;
    const SwypX86IommuHardwareOps *ops = swyp_x86_vtd_iommu_ops();
    uint8_t visited[SWYP_ACPI_MAX_DMAR_UNITS] = {0};
    uint32_t i;
    int found = 0;
    if (router == NULL || router->failed != 0u || ops == NULL || ops->invalidate_domain == NULL || domain_id == 0u) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0u; i < SWYP_X86_VTD_ROUTER_BINDING_CAPACITY; ++i) {
        SwypX86VtdRouteBinding *binding = &router->bindings[i];
        SwypStatus status;
        if (binding->active == 0u || binding->domain_id != domain_id) {
            continue;
        }
        if (binding->unit_index >= router->unit_count || router->units[binding->unit_index] == NULL) {
            router->failed = 1u;
            return SWYP_ERR_CORRUPT;
        }
        found = 1;
        if (visited[binding->unit_index] != 0u) {
            continue;
        }
        status = ops->invalidate_domain(router->units[binding->unit_index], domain_id);
        if (status != SWYP_OK) {
            return status;
        }
        visited[binding->unit_index] = 1u;
    }
    return found ? SWYP_OK : SWYP_ERR_NOT_FOUND;
}

static const SwypX86IommuHardwareOps swyp_vtd_router_ops = {
    .attach_device = swyp_vtd_router_attach,
    .detach_device = swyp_vtd_router_detach,
    .map_pages = swyp_vtd_router_map,
    .unmap_pages = swyp_vtd_router_unmap,
    .invalidate_domain = swyp_vtd_router_invalidate,
};

SwypStatus swyp_x86_vtd_router_init(SwypX86VtdRouter *router, const SwypAcpiPlatform *acpi,
                                    SwypX86Vtd *const *units, uint32_t unit_count) {
    uint32_t i;
    if (router == NULL || acpi == NULL || units == NULL || unit_count == 0u ||
        unit_count != acpi->dmar_unit_count || unit_count > SWYP_ACPI_MAX_DMAR_UNITS) {
        return SWYP_ERR_INVALID;
    }
    *router = (SwypX86VtdRouter){0};
    router->acpi = acpi;
    router->unit_count = unit_count;
    for (i = 0u; i < unit_count; ++i) {
        if (units[i] == NULL || !swyp_x86_vtd_is_enabled(units[i]) || units[i]->segment != acpi->dmar_units[i].segment) {
            *router = (SwypX86VtdRouter){0};
            return SWYP_ERR_INVALID;
        }
        router->units[i] = units[i];
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_vtd_router_authorize_rmrr(SwypX86VtdRouter *router, uint64_t domain_id, uint64_t device_id,
                                              uint64_t requester_aux, uint64_t base, uint64_t length) {
    SwypX86VtdRmrrAuthorization *authorization;
    uint16_t segment;
    uint8_t bus;
    uint8_t device;
    uint8_t function;
    uint64_t required_base = 0u;
    uint64_t required_limit = 0u;
    uint64_t required_length;
    SwypStatus status;
    if (router == NULL || router->failed != 0u || domain_id == 0u || device_id == 0u ||
        !swyp_vtd_router_page_range(base, length) ||
        !swyp_vtd_router_requester(requester_aux, &segment, &bus, &device, &function) ||
        swyp_vtd_router_binding(router, domain_id, device_id) != NULL) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_vtd_router_reserved(router, segment, bus, device, function, &required_base, &required_limit);
    if (status != SWYP_OK) {
        return status;
    }
    if (required_limit == UINT64_MAX || required_limit < required_base) {
        return SWYP_ERR_CORRUPT;
    }
    required_length = required_limit - required_base + 1u;
    if (required_base != base || required_length != length || !swyp_vtd_router_page_range(required_base, required_length)) {
        return SWYP_ERR_DENIED;
    }
    authorization = swyp_vtd_router_rmrr_authorization(router, domain_id, device_id, requester_aux);
    if (authorization != NULL) {
        return authorization->base == base && authorization->length == length ? SWYP_OK : SWYP_ERR_DENIED;
    }
    authorization = swyp_vtd_router_free_rmrr_authorization(router);
    if (authorization == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    *authorization = (SwypX86VtdRmrrAuthorization){
        .active = 1u,
        .domain_id = domain_id,
        .device_id = device_id,
        .requester_aux = requester_aux,
        .base = base,
        .length = length,
    };
    return SWYP_OK;
}

void swyp_x86_vtd_router_set_pci(SwypX86VtdRouter *router, SwypX86PciEcam *pci) {
    if (router != NULL) {
        router->pci = pci;
    }
}

SwypStatus swyp_x86_vtd_router_reserved_for_requester(SwypX86VtdRouter *router, uint64_t requester_aux,
                                                      uint64_t *base, uint64_t *limit) {
    uint16_t segment;
    uint8_t bus;
    uint8_t device;
    uint8_t function;
    if (router == NULL || !swyp_vtd_router_requester(requester_aux, &segment, &bus, &device, &function)) {
        return SWYP_ERR_INVALID;
    }
    return swyp_vtd_router_reserved(router, segment, bus, device, function, base, limit);
}

SwypStatus swyp_x86_vtd_router_cancel_rmrr_authorization(SwypX86VtdRouter *router, uint64_t domain_id,
                                                         uint64_t device_id, uint64_t requester_aux) {
    SwypX86VtdRmrrAuthorization *authorization;
    if (router == NULL || domain_id == 0u || device_id == 0u) {
        return SWYP_ERR_INVALID;
    }
    authorization = swyp_vtd_router_rmrr_authorization(router, domain_id, device_id, requester_aux);
    if (authorization == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    *authorization = (SwypX86VtdRmrrAuthorization){0};
    return SWYP_OK;
}

const SwypX86IommuHardwareOps *swyp_x86_vtd_router_iommu_ops(void) {
    return &swyp_vtd_router_ops;
}
