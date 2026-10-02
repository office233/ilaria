#include "swypik/arch/x86_64/vtd.h"

#define SWYP_VTD_REG_CAP 0x08u
#define SWYP_VTD_REG_ECAP 0x10u
#define SWYP_VTD_REG_GCMD 0x18u
#define SWYP_VTD_REG_GSTS 0x1cu
#define SWYP_VTD_REG_RTADDR 0x20u
#define SWYP_VTD_REG_CCMD 0x28u

#define SWYP_VTD_GCMD_TE (UINT32_C(1) << 31)
#define SWYP_VTD_GCMD_SRTP (UINT32_C(1) << 30)
#define SWYP_VTD_GCMD_WBF (UINT32_C(1) << 27)

#define SWYP_VTD_CAP_RWBF (UINT64_C(1) << 4)
#define SWYP_VTD_CAP_SAGAW_SHIFT 8u
#define SWYP_VTD_CAP_SAGAW_MASK UINT64_C(0x1f)
#define SWYP_VTD_CAP_ND_MASK UINT64_C(0x7)
#define SWYP_VTD_ECAP_COHERENT (UINT64_C(1) << 0)
#define SWYP_VTD_ECAP_IRO_SHIFT 8u
#define SWYP_VTD_ECAP_IRO_MASK UINT64_C(0x3ff)

#define SWYP_VTD_CCMD_ICC (UINT64_C(1) << 63)
#define SWYP_VTD_CCMD_GLOBAL (UINT64_C(1) << 61)

#define SWYP_VTD_IOTLB_IVT (UINT64_C(1) << 63)
#define SWYP_VTD_IOTLB_GLOBAL (UINT64_C(1) << 60)
#define SWYP_VTD_IOTLB_DOMAIN (UINT64_C(2) << 60)
#define SWYP_VTD_IOTLB_DID_SHIFT 32u
#define SWYP_VTD_IOTLB_DRAIN_READS (UINT64_C(1) << 49)
#define SWYP_VTD_IOTLB_DRAIN_WRITES (UINT64_C(1) << 48)
#define SWYP_VTD_IOTLB_ACTUAL_SHIFT 57u
#define SWYP_VTD_IOTLB_ACTUAL_MASK UINT64_C(0x3)

#define SWYP_VTD_ENTRY_PRESENT UINT64_C(1)
#define SWYP_VTD_CONTEXT_AW_48 UINT64_C(2)
#define SWYP_VTD_CONTEXT_DID_SHIFT 8u
#define SWYP_VTD_SL_READ UINT64_C(1)
#define SWYP_VTD_SL_WRITE UINT64_C(2)
#define SWYP_VTD_PAGE_MASK UINT64_C(0x000ffffffffff000)
#define SWYP_VTD_IOVA_MAX UINT64_C(0x0000ffffffffffff)

typedef struct SwypX86VtdEntry128 {
    uint64_t low;
    uint64_t high;
} SwypX86VtdEntry128;

typedef struct SwypX86VtdTxnLink {
    uint64_t *parent_entry;
    uint64_t physical;
} SwypX86VtdTxnLink;

static void swyp_vtd_zero_page(void *page) {
    uint64_t *words = (uint64_t *)page;
    uint32_t i;
    for (i = 0u; i < 512u; ++i) {
        words[i] = 0u;
    }
}

static void swyp_vtd_barrier(void) {
    __asm__ volatile("" : : : "memory");
}

static void *swyp_vtd_physical(SwypX86Vtd *vtd, uint64_t physical) {
    if (vtd == NULL || vtd->memory_ops == NULL || vtd->memory_ops->physical_to_virtual == NULL ||
        (physical & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) != 0u) {
        return NULL;
    }
    return vtd->memory_ops->physical_to_virtual(vtd->memory_context, physical);
}

static SwypStatus swyp_vtd_allocate_page(SwypX86Vtd *vtd, uint64_t *physical, void **virtual_page) {
    uint64_t address = 0u;
    void *pointer;
    SwypStatus status;
    if (vtd == NULL || physical == NULL || virtual_page == NULL || vtd->page_allocator == NULL ||
        vtd->page_allocator->ops == NULL || vtd->page_allocator->ops->allocate == NULL ||
        vtd->page_allocator->ops->release == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = vtd->page_allocator->ops->allocate(vtd->page_allocator->context, 1u, 1u, &address);
    if (status != SWYP_OK) {
        return status;
    }
    if ((address & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) != 0u || (address & ~SWYP_VTD_PAGE_MASK) != 0u) {
        (void)vtd->page_allocator->ops->release(vtd->page_allocator->context, address, 1u);
        return SWYP_ERR_CORRUPT;
    }
    pointer = swyp_vtd_physical(vtd, address);
    if (pointer == NULL) {
        (void)vtd->page_allocator->ops->release(vtd->page_allocator->context, address, 1u);
        return SWYP_ERR_CORRUPT;
    }
    swyp_vtd_zero_page(pointer);
    *physical = address;
    *virtual_page = pointer;
    return SWYP_OK;
}

static SwypStatus swyp_vtd_release_page(SwypX86Vtd *vtd, uint64_t physical) {
    if (vtd == NULL || vtd->page_allocator == NULL || vtd->page_allocator->ops == NULL ||
        vtd->page_allocator->ops->release == NULL || physical == 0u) {
        return SWYP_ERR_INVALID;
    }
    return vtd->page_allocator->ops->release(vtd->page_allocator->context, physical, 1u);
}

static uint32_t swyp_vtd_domain_limit(uint64_t capability) {
    uint32_t nd = (uint32_t)(capability & SWYP_VTD_CAP_ND_MASK);
    if (nd >= 7u) {
        return 0u;
    }
    return UINT32_C(1) << (4u + 2u * nd);
}

static uint32_t swyp_vtd_iotlb_offset(const SwypX86Vtd *vtd) {
    return (uint32_t)(((vtd->extended_capability >> SWYP_VTD_ECAP_IRO_SHIFT) & SWYP_VTD_ECAP_IRO_MASK) * 16u + 8u);
}

static SwypStatus swyp_vtd_poll32(SwypX86Vtd *vtd, uint32_t offset, uint32_t mask, int set) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_POLL_LIMIT; ++i) {
        uint32_t value = 0u;
        SwypStatus status = vtd->register_ops->read32(vtd->register_context, offset, &value);
        if (status != SWYP_OK) {
            return status;
        }
        if (((value & mask) != 0u) == (set != 0)) {
            return SWYP_OK;
        }
    }
    return SWYP_ERR_CORRUPT;
}

static SwypStatus swyp_vtd_poll64_clear(SwypX86Vtd *vtd, uint32_t offset, uint64_t mask, uint64_t *final_value) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_POLL_LIMIT; ++i) {
        uint64_t value = 0u;
        SwypStatus status = vtd->register_ops->read64(vtd->register_context, offset, &value);
        if (status != SWYP_OK) {
            return status;
        }
        if ((value & mask) == 0u) {
            if (final_value != NULL) {
                *final_value = value;
            }
            return SWYP_OK;
        }
    }
    return SWYP_ERR_CORRUPT;
}

static SwypStatus swyp_vtd_command(SwypX86Vtd *vtd, uint32_t command_bit, int status_set_after) {
    uint32_t command = command_bit;
    SwypStatus status;
    if (vtd == NULL || (command_bit != SWYP_VTD_GCMD_SRTP && command_bit != SWYP_VTD_GCMD_WBF)) {
        return SWYP_ERR_INVALID;
    }
    if (vtd->enabled != 0u) {
        command |= SWYP_VTD_GCMD_TE;
    }
    status = vtd->register_ops->write32(vtd->register_context, SWYP_VTD_REG_GCMD, command);
    if (status != SWYP_OK) {
        return status;
    }
    return swyp_vtd_poll32(vtd, SWYP_VTD_REG_GSTS, command_bit, status_set_after);
}

static SwypStatus swyp_vtd_set_translation(SwypX86Vtd *vtd, int enable) {
    uint32_t command = enable ? SWYP_VTD_GCMD_TE : 0u;
    SwypStatus status;
    if (vtd == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = vtd->register_ops->write32(vtd->register_context, SWYP_VTD_REG_GCMD, command);
    if (status != SWYP_OK) {
        return status;
    }
    return swyp_vtd_poll32(vtd, SWYP_VTD_REG_GSTS, SWYP_VTD_GCMD_TE, enable != 0);
}

static SwypStatus swyp_vtd_flush_write_buffer(SwypX86Vtd *vtd) {
    if ((vtd->capability & SWYP_VTD_CAP_RWBF) == 0u) {
        return SWYP_OK;
    }
    return swyp_vtd_command(vtd, SWYP_VTD_GCMD_WBF, 0);
}

static SwypStatus swyp_vtd_invalidate_context_global(SwypX86Vtd *vtd) {
    uint64_t final_value = 0u;
    SwypStatus status = vtd->register_ops->write64(vtd->register_context, SWYP_VTD_REG_CCMD,
                                                    SWYP_VTD_CCMD_ICC | SWYP_VTD_CCMD_GLOBAL);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_vtd_poll64_clear(vtd, SWYP_VTD_REG_CCMD, SWYP_VTD_CCMD_ICC, &final_value);
    (void)final_value;
    return status;
}

static SwypStatus swyp_vtd_invalidate_iotlb(SwypX86Vtd *vtd, uint16_t did, int global) {
    uint32_t offset = swyp_vtd_iotlb_offset(vtd);
    uint64_t command = SWYP_VTD_IOTLB_IVT | SWYP_VTD_IOTLB_DRAIN_READS | SWYP_VTD_IOTLB_DRAIN_WRITES |
                       (global ? SWYP_VTD_IOTLB_GLOBAL
                               : (SWYP_VTD_IOTLB_DOMAIN | ((uint64_t)did << SWYP_VTD_IOTLB_DID_SHIFT)));
    uint64_t final_value = 0u;
    SwypStatus status = vtd->register_ops->write64(vtd->register_context, offset, command);
    if (status != SWYP_OK) {
        return status;
    }
    status = swyp_vtd_poll64_clear(vtd, offset, SWYP_VTD_IOTLB_IVT, &final_value);
    if (status != SWYP_OK) {
        return status;
    }
    return ((final_value >> SWYP_VTD_IOTLB_ACTUAL_SHIFT) & SWYP_VTD_IOTLB_ACTUAL_MASK) == 0u
               ? SWYP_ERR_CORRUPT
               : SWYP_OK;
}

static SwypX86VtdDomain *swyp_vtd_domain(SwypX86Vtd *vtd, uint64_t domain_id) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_DOMAIN_CAPACITY; ++i) {
        if (vtd->domains[i].active != 0u && vtd->domains[i].domain_id == domain_id) {
            return &vtd->domains[i];
        }
    }
    return NULL;
}

static SwypX86VtdDomain *swyp_vtd_free_domain(SwypX86Vtd *vtd) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_DOMAIN_CAPACITY; ++i) {
        if (vtd->domains[i].active == 0u) {
            return &vtd->domains[i];
        }
    }
    return NULL;
}

static int swyp_vtd_did_used(const SwypX86Vtd *vtd, uint16_t did) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_DOMAIN_CAPACITY; ++i) {
        if (vtd->domains[i].active != 0u && vtd->domains[i].hardware_did == did) {
            return 1;
        }
    }
    return 0;
}

static uint16_t swyp_vtd_allocate_did(const SwypX86Vtd *vtd) {
    uint32_t did;
    uint32_t limit = vtd->max_hardware_domains;
    if (limit > UINT16_MAX + 1u) {
        limit = UINT16_MAX + 1u;
    }
    for (did = 1u; did < limit; ++did) {
        if (!swyp_vtd_did_used(vtd, (uint16_t)did)) {
            return (uint16_t)did;
        }
    }
    return 0u;
}

static SwypStatus swyp_vtd_track_table(SwypX86VtdDomain *domain, uint64_t physical) {
    if (domain == NULL || physical == 0u || domain->table_page_count >= SWYP_X86_VTD_MAX_DOMAIN_TABLE_PAGES) {
        return SWYP_ERR_NO_SPACE;
    }
    domain->table_pages[domain->table_page_count++] = physical;
    return SWYP_OK;
}

static SwypStatus swyp_vtd_create_domain(SwypX86Vtd *vtd, uint64_t domain_id, SwypX86VtdDomain **out_domain) {
    SwypX86VtdDomain *domain;
    uint16_t did;
    uint64_t root_physical = 0u;
    void *root_virtual = NULL;
    SwypStatus status;
    if (out_domain == NULL) {
        return SWYP_ERR_INVALID;
    }
    *out_domain = NULL;
    domain = swyp_vtd_free_domain(vtd);
    did = swyp_vtd_allocate_did(vtd);
    if (domain == NULL || did == 0u) {
        return SWYP_ERR_NO_SPACE;
    }
    status = swyp_vtd_allocate_page(vtd, &root_physical, &root_virtual);
    if (status != SWYP_OK) {
        return status;
    }
    (void)root_virtual;
    *domain = (SwypX86VtdDomain){0};
    domain->active = 1u;
    domain->hardware_did = did;
    domain->domain_id = domain_id;
    domain->sl_root_physical = root_physical;
    status = swyp_vtd_track_table(domain, root_physical);
    if (status != SWYP_OK) {
        (void)swyp_vtd_release_page(vtd, root_physical);
        *domain = (SwypX86VtdDomain){0};
        return status;
    }
    *out_domain = domain;
    return SWYP_OK;
}

static SwypX86VtdDevice *swyp_vtd_device(SwypX86Vtd *vtd, uint64_t domain_id, uint64_t device_id) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_DEVICE_CAPACITY; ++i) {
        if (vtd->devices[i].active != 0u && vtd->devices[i].domain_id == domain_id &&
            vtd->devices[i].device_id == device_id) {
            return &vtd->devices[i];
        }
    }
    return NULL;
}

static SwypX86VtdDevice *swyp_vtd_free_device(SwypX86Vtd *vtd) {
    uint32_t i;
    for (i = 0u; i < SWYP_X86_VTD_DEVICE_CAPACITY; ++i) {
        if (vtd->devices[i].active == 0u) {
            return &vtd->devices[i];
        }
    }
    return NULL;
}

static SwypStatus swyp_vtd_context_table(SwypX86Vtd *vtd, uint8_t bus, SwypX86VtdEntry128 **table_out) {
    SwypX86VtdEntry128 *root;
    SwypX86VtdEntry128 *table;
    uint64_t physical;
    void *virtual_page;
    SwypStatus status;
    if (table_out == NULL) {
        return SWYP_ERR_INVALID;
    }
    *table_out = NULL;
    if (vtd->context_tables[bus] != 0u) {
        table = (SwypX86VtdEntry128 *)swyp_vtd_physical(vtd, vtd->context_tables[bus]);
        if (table == NULL) {
            return SWYP_ERR_CORRUPT;
        }
        *table_out = table;
        return SWYP_OK;
    }
    status = swyp_vtd_allocate_page(vtd, &physical, &virtual_page);
    if (status != SWYP_OK) {
        return status;
    }
    root = (SwypX86VtdEntry128 *)swyp_vtd_physical(vtd, vtd->root_table_physical);
    if (root == NULL) {
        (void)swyp_vtd_release_page(vtd, physical);
        return SWYP_ERR_CORRUPT;
    }
    table = (SwypX86VtdEntry128 *)virtual_page;
    root[bus].high = 0u;
    swyp_vtd_barrier();
    root[bus].low = (physical & SWYP_VTD_PAGE_MASK) | SWYP_VTD_ENTRY_PRESENT;
    swyp_vtd_barrier();
    vtd->context_tables[bus] = physical;
    *table_out = table;
    return SWYP_OK;
}

static int swyp_vtd_requester(uint64_t aux, uint16_t *segment, uint8_t *bus, uint8_t *devfn) {
    if ((aux & ~UINT64_C(0xffffffff)) != 0u || segment == NULL || bus == NULL || devfn == NULL) {
        return 0;
    }
    *segment = (uint16_t)((aux >> 16) & UINT64_C(0xffff));
    *bus = (uint8_t)((aux >> 8) & UINT64_C(0xff));
    *devfn = (uint8_t)(aux & UINT64_C(0xff));
    return 1;
}

static SwypStatus swyp_vtd_attach_device_hw(void *context, uint64_t domain_id, uint64_t device_id,
                                             uint64_t requester_aux) {
    SwypX86Vtd *vtd = (SwypX86Vtd *)context;
    SwypX86VtdDomain *domain;
    SwypX86VtdDevice *device;
    SwypX86VtdEntry128 *contexts;
    uint16_t segment;
    uint8_t bus;
    uint8_t devfn;
    int created_domain = 0;
    SwypStatus status;
    if (vtd == NULL || vtd->failed != 0u || vtd->enabled == 0u || domain_id == 0u || device_id == 0u ||
        !swyp_vtd_requester(requester_aux, &segment, &bus, &devfn) || segment != vtd->segment ||
        swyp_vtd_device(vtd, domain_id, device_id) != NULL) {
        return SWYP_ERR_INVALID;
    }
    device = swyp_vtd_free_device(vtd);
    if (device == NULL) {
        return SWYP_ERR_NO_SPACE;
    }
    domain = swyp_vtd_domain(vtd, domain_id);
    if (domain == NULL) {
        status = swyp_vtd_create_domain(vtd, domain_id, &domain);
        if (status != SWYP_OK) {
            return status;
        }
        created_domain = 1;
    }
    status = swyp_vtd_context_table(vtd, bus, &contexts);
    if (status != SWYP_OK) {
        goto rollback_domain;
    }
    if ((contexts[devfn].low & SWYP_VTD_ENTRY_PRESENT) != 0u) {
        status = SWYP_ERR_DENIED;
        goto rollback_domain;
    }
    contexts[devfn].high = SWYP_VTD_CONTEXT_AW_48 | ((uint64_t)domain->hardware_did << SWYP_VTD_CONTEXT_DID_SHIFT);
    swyp_vtd_barrier();
    contexts[devfn].low = (domain->sl_root_physical & SWYP_VTD_PAGE_MASK) | SWYP_VTD_ENTRY_PRESENT;
    swyp_vtd_barrier();
    status = swyp_vtd_flush_write_buffer(vtd);
    if (status == SWYP_OK) {
        status = swyp_vtd_invalidate_context_global(vtd);
    }
    if (status == SWYP_OK) {
        status = swyp_vtd_invalidate_iotlb(vtd, domain->hardware_did, 0);
    }
    if (status != SWYP_OK) {
        contexts[devfn].low = 0u;
        contexts[devfn].high = 0u;
        swyp_vtd_barrier();
        goto rollback_domain;
    }
    *device = (SwypX86VtdDevice){0};
    device->active = 1u;
    device->segment = segment;
    device->bus = bus;
    device->devfn = devfn;
    device->domain_id = domain_id;
    device->device_id = device_id;
    domain->device_count += 1u;
    return SWYP_OK;

rollback_domain:
    if (created_domain && domain != NULL && domain->device_count == 0u) {
        uint16_t i;
        for (i = 0u; i < domain->table_page_count; ++i) {
            (void)swyp_vtd_release_page(vtd, domain->table_pages[i]);
        }
        *domain = (SwypX86VtdDomain){0};
    }
    return status;
}

static SwypStatus swyp_vtd_detach_device_hw(void *context, uint64_t domain_id, uint64_t device_id) {
    SwypX86Vtd *vtd = (SwypX86Vtd *)context;
    SwypX86VtdDevice *device;
    SwypX86VtdDomain *domain;
    SwypX86VtdEntry128 *contexts;
    SwypStatus status;
    if (vtd == NULL || vtd->failed != 0u || vtd->enabled == 0u) {
        return SWYP_ERR_INVALID;
    }
    device = swyp_vtd_device(vtd, domain_id, device_id);
    domain = swyp_vtd_domain(vtd, domain_id);
    if (device == NULL || domain == NULL || vtd->context_tables[device->bus] == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    contexts = (SwypX86VtdEntry128 *)swyp_vtd_physical(vtd, vtd->context_tables[device->bus]);
    if (contexts == NULL || (contexts[device->devfn].low & SWYP_VTD_ENTRY_PRESENT) == 0u) {
        return SWYP_ERR_CORRUPT;
    }
    contexts[device->devfn].low &= ~SWYP_VTD_ENTRY_PRESENT;
    swyp_vtd_barrier();
    status = swyp_vtd_flush_write_buffer(vtd);
    if (status == SWYP_OK) {
        status = swyp_vtd_invalidate_context_global(vtd);
    }
    if (status == SWYP_OK) {
        status = swyp_vtd_invalidate_iotlb(vtd, domain->hardware_did, 0);
    }
    if (status != SWYP_OK) {
        vtd->failed = 1u;
        return status;
    }
    contexts[device->devfn].high = 0u;
    contexts[device->devfn].low = 0u;
    *device = (SwypX86VtdDevice){0};
    if (domain->device_count == 0u) {
        vtd->failed = 1u;
        return SWYP_ERR_CORRUPT;
    }
    domain->device_count -= 1u;
    if (domain->device_count == 0u) {
        uint16_t i;
        for (i = 0u; i < domain->table_page_count; ++i) {
            if (swyp_vtd_release_page(vtd, domain->table_pages[i]) != SWYP_OK) {
                vtd->failed = 1u;
                return SWYP_ERR_CORRUPT;
            }
        }
        *domain = (SwypX86VtdDomain){0};
    }
    return SWYP_OK;
}

static uint16_t swyp_vtd_sl_index(uint64_t address, uint32_t level) {
    return (uint16_t)((address >> (12u + (level - 1u) * 9u)) & UINT64_C(0x1ff));
}

static SwypStatus swyp_vtd_ensure_sl_child(SwypX86Vtd *vtd, SwypX86VtdDomain *domain, uint64_t *parent_entry,
                                            uint64_t **child, SwypX86VtdTxnLink *links, uint16_t *link_count) {
    if ((*parent_entry & (SWYP_VTD_SL_READ | SWYP_VTD_SL_WRITE)) != 0u) {
        *child = (uint64_t *)swyp_vtd_physical(vtd, *parent_entry & SWYP_VTD_PAGE_MASK);
        return *child == NULL ? SWYP_ERR_CORRUPT : SWYP_OK;
    }
    if (*link_count >= SWYP_X86_VTD_MAX_DOMAIN_TABLE_PAGES ||
        domain->table_page_count >= SWYP_X86_VTD_MAX_DOMAIN_TABLE_PAGES) {
        return SWYP_ERR_NO_SPACE;
    }
    {
        uint64_t physical = 0u;
        void *virtual_page = NULL;
        SwypStatus status = swyp_vtd_allocate_page(vtd, &physical, &virtual_page);
        if (status != SWYP_OK) {
            return status;
        }
        status = swyp_vtd_track_table(domain, physical);
        if (status != SWYP_OK) {
            (void)swyp_vtd_release_page(vtd, physical);
            return status;
        }
        *parent_entry = physical | SWYP_VTD_SL_READ | SWYP_VTD_SL_WRITE;
        links[*link_count].parent_entry = parent_entry;
        links[*link_count].physical = physical;
        *link_count += 1u;
        *child = (uint64_t *)virtual_page;
    }
    return SWYP_OK;
}

static int swyp_vtd_leaf_present(SwypX86Vtd *vtd, const SwypX86VtdDomain *domain, uint64_t iova) {
    uint64_t *table = (uint64_t *)swyp_vtd_physical(vtd, domain->sl_root_physical);
    uint32_t level;
    if (table == NULL) {
        return -1;
    }
    for (level = 4u; level > 1u; --level) {
        uint64_t entry = table[swyp_vtd_sl_index(iova, level)];
        if ((entry & (SWYP_VTD_SL_READ | SWYP_VTD_SL_WRITE)) == 0u) {
            return 0;
        }
        table = (uint64_t *)swyp_vtd_physical(vtd, entry & SWYP_VTD_PAGE_MASK);
        if (table == NULL) {
            return -1;
        }
    }
    return (table[swyp_vtd_sl_index(iova, 1u)] & (SWYP_VTD_SL_READ | SWYP_VTD_SL_WRITE)) != 0u;
}

static void swyp_vtd_rollback_links(SwypX86Vtd *vtd, SwypX86VtdDomain *domain, SwypX86VtdTxnLink *links,
                                    uint16_t link_count) {
    while (link_count != 0u) {
        SwypX86VtdTxnLink *link = &links[link_count - 1u];
        if (link->parent_entry != NULL && (*link->parent_entry & SWYP_VTD_PAGE_MASK) == link->physical) {
            *link->parent_entry = 0u;
        }
        if (domain->table_page_count != 0u &&
            domain->table_pages[domain->table_page_count - 1u] == link->physical) {
            domain->table_page_count -= 1u;
            domain->table_pages[domain->table_page_count] = 0u;
        }
        (void)swyp_vtd_release_page(vtd, link->physical);
        link_count -= 1u;
    }
}

static SwypStatus swyp_vtd_map_pages_hw(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                                        uint64_t physical_address, uint64_t page_count, uint64_t access_rights) {
    SwypX86Vtd *vtd = (SwypX86Vtd *)context;
    SwypX86VtdDomain *domain;
    SwypX86VtdDevice *device;
    SwypX86VtdTxnLink links[SWYP_X86_VTD_MAX_DOMAIN_TABLE_PAGES];
    uint16_t link_count = 0u;
    uint64_t mapped = 0u;
    uint64_t page;
    if (vtd == NULL || vtd->failed != 0u || vtd->enabled == 0u || page_count == 0u ||
        (iova & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) != 0u ||
        (physical_address & (SWYP_X86_IOMMU_PAGE_SIZE - 1u)) != 0u ||
        (access_rights & ~(SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE)) != 0u || access_rights == 0u ||
        page_count - 1u > (SWYP_VTD_IOVA_MAX - iova) / SWYP_X86_IOMMU_PAGE_SIZE) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_vtd_domain(vtd, domain_id);
    device = swyp_vtd_device(vtd, domain_id, device_id);
    if (domain == NULL || device == NULL) {
        return SWYP_ERR_DENIED;
    }
    for (page = 0u; page < page_count; ++page) {
        int present = swyp_vtd_leaf_present(vtd, domain, iova + page * SWYP_X86_IOMMU_PAGE_SIZE);
        if (present < 0) {
            return SWYP_ERR_CORRUPT;
        }
        if (present != 0) {
            return SWYP_ERR_DENIED;
        }
    }
    for (page = 0u; page < page_count; ++page) {
        uint64_t va = iova + page * SWYP_X86_IOMMU_PAGE_SIZE;
        uint64_t pa = physical_address + page * SWYP_X86_IOMMU_PAGE_SIZE;
        uint64_t *table = (uint64_t *)swyp_vtd_physical(vtd, domain->sl_root_physical);
        uint32_t level;
        SwypStatus status = SWYP_OK;
        if (table == NULL || (pa & ~SWYP_VTD_PAGE_MASK) != 0u) {
            status = SWYP_ERR_CORRUPT;
        }
        for (level = 4u; status == SWYP_OK && level > 1u; --level) {
            uint16_t index = swyp_vtd_sl_index(va, level);
            status = swyp_vtd_ensure_sl_child(vtd, domain, &table[index], &table, links, &link_count);
        }
        if (status == SWYP_OK) {
            uint16_t index = swyp_vtd_sl_index(va, 1u);
            uint64_t rights = 0u;
            if ((access_rights & SWYP_CAP_RIGHT_READ) != 0u) {
                rights |= SWYP_VTD_SL_READ;
            }
            if ((access_rights & SWYP_CAP_RIGHT_WRITE) != 0u) {
                rights |= SWYP_VTD_SL_WRITE;
            }
            table[index] = (pa & SWYP_VTD_PAGE_MASK) | rights;
            swyp_vtd_barrier();
            mapped += 1u;
        }
        if (status != SWYP_OK) {
            uint64_t rollback;
            for (rollback = 0u; rollback < mapped; ++rollback) {
                uint64_t rollback_iova = iova + rollback * SWYP_X86_IOMMU_PAGE_SIZE;
                uint64_t *walk = (uint64_t *)swyp_vtd_physical(vtd, domain->sl_root_physical);
                uint32_t walk_level;
                if (walk == NULL) {
                    vtd->failed = 1u;
                    return SWYP_ERR_CORRUPT;
                }
                for (walk_level = 4u; walk_level > 1u; --walk_level) {
                    walk = (uint64_t *)swyp_vtd_physical(vtd,
                        walk[swyp_vtd_sl_index(rollback_iova, walk_level)] & SWYP_VTD_PAGE_MASK);
                    if (walk == NULL) {
                        vtd->failed = 1u;
                        return SWYP_ERR_CORRUPT;
                    }
                }
                walk[swyp_vtd_sl_index(rollback_iova, 1u)] = 0u;
            }
            swyp_vtd_rollback_links(vtd, domain, links, link_count);
            return status;
        }
    }
    return swyp_vtd_flush_write_buffer(vtd);
}

static SwypStatus swyp_vtd_unmap_pages_hw(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                                          uint64_t page_count) {
    SwypX86Vtd *vtd = (SwypX86Vtd *)context;
    SwypX86VtdDomain *domain;
    uint64_t page;
    if (vtd == NULL || vtd->failed != 0u || vtd->enabled == 0u || page_count == 0u ||
        swyp_vtd_device(vtd, domain_id, device_id) == NULL) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_vtd_domain(vtd, domain_id);
    if (domain == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    for (page = 0u; page < page_count; ++page) {
        if (swyp_vtd_leaf_present(vtd, domain, iova + page * SWYP_X86_IOMMU_PAGE_SIZE) != 1) {
            return SWYP_ERR_NOT_FOUND;
        }
    }
    for (page = 0u; page < page_count; ++page) {
        uint64_t va = iova + page * SWYP_X86_IOMMU_PAGE_SIZE;
        uint64_t *table = (uint64_t *)swyp_vtd_physical(vtd, domain->sl_root_physical);
        uint32_t level;
        for (level = 4u; level > 1u; --level) {
            table = (uint64_t *)swyp_vtd_physical(vtd, table[swyp_vtd_sl_index(va, level)] & SWYP_VTD_PAGE_MASK);
            if (table == NULL) {
                vtd->failed = 1u;
                return SWYP_ERR_CORRUPT;
            }
        }
        table[swyp_vtd_sl_index(va, 1u)] = 0u;
    }
    swyp_vtd_barrier();
    return swyp_vtd_flush_write_buffer(vtd);
}

static SwypStatus swyp_vtd_invalidate_domain_hw(void *context, uint64_t domain_id) {
    SwypX86Vtd *vtd = (SwypX86Vtd *)context;
    SwypX86VtdDomain *domain;
    if (vtd == NULL || vtd->failed != 0u || vtd->enabled == 0u) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_vtd_domain(vtd, domain_id);
    if (domain == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    return swyp_vtd_invalidate_iotlb(vtd, domain->hardware_did, 0);
}

static const SwypX86IommuHardwareOps swyp_vtd_iommu_ops_value = {
    .attach_device = swyp_vtd_attach_device_hw,
    .detach_device = swyp_vtd_detach_device_hw,
    .map_pages = swyp_vtd_map_pages_hw,
    .unmap_pages = swyp_vtd_unmap_pages_hw,
    .invalidate_domain = swyp_vtd_invalidate_domain_hw,
};

SwypStatus swyp_x86_vtd_query(const SwypX86Vtd *vtd_const, uint64_t domain_id, uint64_t iova,
                              uint64_t *physical_address, uint64_t *access_rights) {
    SwypX86Vtd *vtd = (SwypX86Vtd *)(uintptr_t)vtd_const;
    SwypX86VtdDomain *domain;
    uint64_t *table;
    uint32_t level;
    uint64_t entry;
    if (vtd == NULL || physical_address == NULL || access_rights == NULL || iova > SWYP_VTD_IOVA_MAX) {
        return SWYP_ERR_INVALID;
    }
    domain = swyp_vtd_domain(vtd, domain_id);
    if (domain == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    table = (uint64_t *)swyp_vtd_physical(vtd, domain->sl_root_physical);
    if (table == NULL) {
        return SWYP_ERR_CORRUPT;
    }
    for (level = 4u; level > 1u; --level) {
        entry = table[swyp_vtd_sl_index(iova, level)];
        if ((entry & (SWYP_VTD_SL_READ | SWYP_VTD_SL_WRITE)) == 0u) {
            return SWYP_ERR_NOT_FOUND;
        }
        table = (uint64_t *)swyp_vtd_physical(vtd, entry & SWYP_VTD_PAGE_MASK);
        if (table == NULL) {
            return SWYP_ERR_CORRUPT;
        }
    }
    entry = table[swyp_vtd_sl_index(iova, 1u)];
    if ((entry & (SWYP_VTD_SL_READ | SWYP_VTD_SL_WRITE)) == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    *physical_address = (entry & SWYP_VTD_PAGE_MASK) | (iova & (SWYP_X86_IOMMU_PAGE_SIZE - 1u));
    *access_rights = 0u;
    if ((entry & SWYP_VTD_SL_READ) != 0u) {
        *access_rights |= SWYP_CAP_RIGHT_READ;
    }
    if ((entry & SWYP_VTD_SL_WRITE) != 0u) {
        *access_rights |= SWYP_CAP_RIGHT_WRITE;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_vtd_init(SwypX86Vtd *vtd, uint16_t segment, SwypPageAllocator *page_allocator,
                             void *memory_context, const SwypX86AddressSpaceHardwareOps *memory_ops,
                             void *register_context, const SwypX86VtdRegisterOps *register_ops) {
    uint64_t root_physical = 0u;
    void *root_virtual = NULL;
    uint32_t domain_limit;
    uint32_t i;
    SwypStatus status;
    if (vtd == NULL || page_allocator == NULL || memory_ops == NULL || memory_ops->physical_to_virtual == NULL ||
        register_ops == NULL || register_ops->read32 == NULL || register_ops->write32 == NULL ||
        register_ops->read64 == NULL || register_ops->write64 == NULL) {
        return SWYP_ERR_INVALID;
    }
    *vtd = (SwypX86Vtd){0};
    vtd->page_allocator = page_allocator;
    vtd->memory_context = memory_context;
    vtd->memory_ops = memory_ops;
    vtd->register_context = register_context;
    vtd->register_ops = register_ops;
    vtd->segment = segment;
    status = register_ops->read64(register_context, SWYP_VTD_REG_CAP, &vtd->capability);
    if (status == SWYP_OK) {
        status = register_ops->read64(register_context, SWYP_VTD_REG_ECAP, &vtd->extended_capability);
    }
    if (status != SWYP_OK) {
        return status;
    }
    if (((vtd->capability >> SWYP_VTD_CAP_SAGAW_SHIFT) & SWYP_VTD_CAP_SAGAW_MASK & UINT64_C(0x4)) == 0u ||
        (vtd->extended_capability & SWYP_VTD_ECAP_COHERENT) == 0u || swyp_vtd_iotlb_offset(vtd) < 0x30u) {
        return SWYP_ERR_UNSUPPORTED;
    }
    domain_limit = swyp_vtd_domain_limit(vtd->capability);
    if (domain_limit < 16u) {
        return SWYP_ERR_UNSUPPORTED;
    }
    vtd->max_hardware_domains = (uint16_t)(domain_limit > UINT16_MAX ? UINT16_MAX : domain_limit);
    status = swyp_vtd_allocate_page(vtd, &root_physical, &root_virtual);
    if (status != SWYP_OK) {
        return status;
    }
    (void)root_virtual;
    vtd->root_table_physical = root_physical;
    for (i = 0u; i < SWYP_X86_VTD_CONTEXT_BUS_COUNT; ++i) {
        vtd->context_tables[i] = 0u;
    }
    status = register_ops->write64(register_context, SWYP_VTD_REG_RTADDR, root_physical & SWYP_VTD_PAGE_MASK);
    if (status == SWYP_OK) {
        status = swyp_vtd_command(vtd, SWYP_VTD_GCMD_SRTP, 1);
    }
    if (status == SWYP_OK) {
        status = swyp_vtd_invalidate_context_global(vtd);
    }
    if (status == SWYP_OK) {
        status = swyp_vtd_invalidate_iotlb(vtd, 0u, 1);
    }
    if (status == SWYP_OK) {
        status = swyp_vtd_set_translation(vtd, 1);
    }
    if (status != SWYP_OK) {
        (void)swyp_vtd_release_page(vtd, root_physical);
        vtd->root_table_physical = 0u;
        vtd->failed = 1u;
        return status;
    }
    vtd->enabled = 1u;
    return SWYP_OK;
}

const SwypX86IommuHardwareOps *swyp_x86_vtd_iommu_ops(void) {
    return &swyp_vtd_iommu_ops_value;
}

int swyp_x86_vtd_is_enabled(const SwypX86Vtd *vtd) {
    return vtd != NULL && vtd->enabled != 0u && vtd->failed == 0u;
}

SwypStatus swyp_x86_vtd_shutdown(SwypX86Vtd *vtd) {
    uint32_t i;
    SwypStatus status;
    if (vtd == NULL || vtd->failed != 0u || vtd->enabled == 0u) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0u; i < SWYP_X86_VTD_DEVICE_CAPACITY; ++i) {
        if (vtd->devices[i].active != 0u) {
            return SWYP_ERR_DENIED;
        }
    }
    for (i = 0u; i < SWYP_X86_VTD_DOMAIN_CAPACITY; ++i) {
        if (vtd->domains[i].active != 0u) {
            return SWYP_ERR_DENIED;
        }
    }
    status = swyp_vtd_set_translation(vtd, 0);
    if (status != SWYP_OK) {
        vtd->failed = 1u;
        return status;
    }
    for (i = 0u; i < SWYP_X86_VTD_CONTEXT_BUS_COUNT; ++i) {
        if (vtd->context_tables[i] != 0u) {
            if (swyp_vtd_release_page(vtd, vtd->context_tables[i]) != SWYP_OK) {
                vtd->failed = 1u;
                return SWYP_ERR_CORRUPT;
            }
            vtd->context_tables[i] = 0u;
        }
    }
    if (vtd->root_table_physical != 0u) {
        if (swyp_vtd_release_page(vtd, vtd->root_table_physical) != SWYP_OK) {
            vtd->failed = 1u;
            return SWYP_ERR_CORRUPT;
        }
        vtd->root_table_physical = 0u;
    }
    vtd->enabled = 0u;
    return SWYP_OK;
}
