#include "swypik/firmware/acpi.h"

#define SWYP_ACPI_PAGE_SIZE UINT64_C(4096)
#define SWYP_ACPI_SDT_HEADER_BYTES 36u
#define SWYP_ACPI_RSDP_V1_BYTES 20u
#define SWYP_ACPI_RSDP_V2_BYTES 36u

static uint16_t swyp_acpi_u16(const uint8_t *bytes) {
    return (uint16_t)((uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8));
}

static uint32_t swyp_acpi_u32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static uint64_t swyp_acpi_u64(const uint8_t *bytes) {
    return (uint64_t)swyp_acpi_u32(bytes) | ((uint64_t)swyp_acpi_u32(bytes + 4u) << 32);
}

static int swyp_acpi_signature(const uint8_t *bytes, const char *signature, uint32_t length) {
    uint32_t i;
    for (i = 0u; i < length; ++i) {
        if (bytes[i] != (uint8_t)signature[i]) {
            return 0;
        }
    }
    return 1;
}

static int swyp_acpi_checksum(const uint8_t *bytes, uint32_t length) {
    uint8_t sum = 0u;
    uint32_t i;
    for (i = 0u; i < length; ++i) {
        sum = (uint8_t)(sum + bytes[i]);
    }
    return sum == 0u;
}

static const uint8_t *swyp_acpi_span(const SwypAcpiMemoryOps *memory, uint64_t physical, uint32_t length) {
    uint8_t *base;
    uint64_t offset;
    uint64_t last;
    if (memory == NULL || memory->physical_to_virtual == NULL || physical == 0u || length == 0u ||
        (uint64_t)length - 1u > UINT64_MAX - physical) {
        return NULL;
    }
    base = (uint8_t *)memory->physical_to_virtual(memory->context, physical);
    if (base == NULL) {
        return NULL;
    }
    last = (uint64_t)length - 1u;
    for (offset = SWYP_ACPI_PAGE_SIZE - (physical & (SWYP_ACPI_PAGE_SIZE - 1u)); offset < length;
         offset += SWYP_ACPI_PAGE_SIZE) {
        uint8_t *page = (uint8_t *)memory->physical_to_virtual(memory->context, physical + offset);
        if (page == NULL || page != base + offset) {
            return NULL;
        }
    }
    {
        uint8_t *tail = (uint8_t *)memory->physical_to_virtual(memory->context, physical + last);
        if (tail == NULL || tail != base + last) {
            return NULL;
        }
    }
    return base;
}

static const uint8_t *swyp_acpi_table(const SwypAcpiMemoryOps *memory, uint64_t physical, uint32_t *length) {
    const uint8_t *header = swyp_acpi_span(memory, physical, SWYP_ACPI_SDT_HEADER_BYTES);
    uint32_t table_length;
    const uint8_t *table;
    if (header == NULL || length == NULL) {
        return NULL;
    }
    table_length = swyp_acpi_u32(header + 4u);
    if (table_length < SWYP_ACPI_SDT_HEADER_BYTES || table_length > SWYP_ACPI_MAX_TABLE_BYTES) {
        return NULL;
    }
    table = swyp_acpi_span(memory, physical, table_length);
    if (table == NULL || !swyp_acpi_checksum(table, table_length)) {
        return NULL;
    }
    *length = table_length;
    return table;
}

static int swyp_acpi_cpu_exists(const SwypAcpiPlatform *platform, uint32_t apic_id) {
    uint32_t i;
    for (i = 0u; i < platform->cpu_count; ++i) {
        if (platform->cpus[i].apic_id == apic_id) {
            return 1;
        }
    }
    return 0;
}

static SwypStatus swyp_acpi_add_cpu(SwypAcpiPlatform *platform, uint32_t apic_id, uint32_t uid, uint32_t flags,
                                    uint32_t x2apic) {
    SwypAcpiCpu *cpu;
    if (swyp_acpi_cpu_exists(platform, apic_id)) {
        return SWYP_ERR_CORRUPT;
    }
    if (platform->cpu_count >= SWYP_ACPI_MAX_CPUS) {
        return SWYP_ERR_NO_SPACE;
    }
    cpu = &platform->cpus[platform->cpu_count++];
    cpu->apic_id = apic_id;
    cpu->acpi_uid = uid;
    cpu->flags = flags;
    cpu->x2apic = x2apic;
    return SWYP_OK;
}

static SwypStatus swyp_acpi_parse_madt(const uint8_t *table, uint32_t length, SwypAcpiPlatform *platform) {
    uint32_t cursor = 44u;
    if (length < 44u || !swyp_acpi_signature(table, "APIC", 4u)) {
        return SWYP_ERR_CORRUPT;
    }
    platform->local_apic_address = swyp_acpi_u32(table + 36u);
    platform->madt_flags = swyp_acpi_u32(table + 40u);
    while (cursor < length) {
        uint8_t type;
        uint8_t entry_length;
        const uint8_t *entry;
        if (length - cursor < 2u) {
            return SWYP_ERR_CORRUPT;
        }
        entry = table + cursor;
        type = entry[0];
        entry_length = entry[1];
        if (entry_length < 2u || entry_length > length - cursor) {
            return SWYP_ERR_CORRUPT;
        }
        if (type == 0u) {
            uint32_t flags;
            if (entry_length < 8u) {
                return SWYP_ERR_CORRUPT;
            }
            flags = swyp_acpi_u32(entry + 4u);
            if ((flags & UINT32_C(0x3)) != 0u) {
                SwypStatus status = swyp_acpi_add_cpu(platform, entry[3], entry[2], flags, 0u);
                if (status != SWYP_OK) {
                    return status;
                }
            }
        } else if (type == 1u) {
            SwypAcpiIoApic *ioapic;
            if (entry_length < 12u || platform->ioapic_count >= SWYP_ACPI_MAX_IOAPICS) {
                return entry_length < 12u ? SWYP_ERR_CORRUPT : SWYP_ERR_NO_SPACE;
            }
            ioapic = &platform->ioapics[platform->ioapic_count++];
            ioapic->id = entry[2];
            ioapic->address = swyp_acpi_u32(entry + 4u);
            ioapic->gsi_base = swyp_acpi_u32(entry + 8u);
            ioapic->reserved0 = 0u;
        } else if (type == 2u) {
            SwypAcpiInterruptOverride *override;
            if (entry_length < 10u || platform->interrupt_override_count >= SWYP_ACPI_MAX_ISO) {
                return entry_length < 10u ? SWYP_ERR_CORRUPT : SWYP_ERR_NO_SPACE;
            }
            override = &platform->interrupt_overrides[platform->interrupt_override_count++];
            override->bus = entry[2];
            override->source = entry[3];
            override->gsi = swyp_acpi_u32(entry + 4u);
            override->flags = swyp_acpi_u16(entry + 8u);
        } else if (type == 5u) {
            if (entry_length < 12u) {
                return SWYP_ERR_CORRUPT;
            }
            platform->local_apic_address = swyp_acpi_u64(entry + 4u);
        } else if (type == 9u) {
            uint32_t flags;
            if (entry_length < 16u) {
                return SWYP_ERR_CORRUPT;
            }
            flags = swyp_acpi_u32(entry + 8u);
            if ((flags & UINT32_C(0x3)) != 0u) {
                SwypStatus status = swyp_acpi_add_cpu(platform, swyp_acpi_u32(entry + 4u),
                                                      swyp_acpi_u32(entry + 12u), flags, 1u);
                if (status != SWYP_OK) {
                    return status;
                }
            }
        }
        cursor += entry_length;
    }
    return cursor == length ? SWYP_OK : SWYP_ERR_CORRUPT;
}

static int swyp_acpi_mcfg_conflict(const SwypAcpiPlatform *platform, uint16_t segment, uint8_t start_bus,
                                   uint8_t end_bus) {
    uint32_t i;
    for (i = 0u; i < platform->mcfg_segment_count; ++i) {
        const SwypAcpiMcfgSegment *existing = &platform->mcfg_segments[i];
        if (existing->segment == segment && start_bus <= existing->end_bus && existing->start_bus <= end_bus) {
            return 1;
        }
    }
    return 0;
}

static SwypStatus swyp_acpi_parse_mcfg(const uint8_t *table, uint32_t length, SwypAcpiPlatform *platform) {
    uint32_t cursor = 44u;
    if (length < 44u || !swyp_acpi_signature(table, "MCFG", 4u) || (length - 44u) % 16u != 0u) {
        return SWYP_ERR_CORRUPT;
    }
    while (cursor < length) {
        const uint8_t *entry = table + cursor;
        SwypAcpiMcfgSegment *segment;
        uint64_t base = swyp_acpi_u64(entry);
        uint16_t segment_id = swyp_acpi_u16(entry + 8u);
        uint8_t start_bus = entry[10];
        uint8_t end_bus = entry[11];
        if (base == 0u || (base & UINT64_C(0xfffff)) != 0u || start_bus > end_bus ||
            swyp_acpi_mcfg_conflict(platform, segment_id, start_bus, end_bus)) {
            return SWYP_ERR_CORRUPT;
        }
        if (platform->mcfg_segment_count >= SWYP_ACPI_MAX_MCFG_SEGMENTS) {
            return SWYP_ERR_NO_SPACE;
        }
        segment = &platform->mcfg_segments[platform->mcfg_segment_count++];
        segment->physical_base = base;
        segment->segment = segment_id;
        segment->start_bus = start_bus;
        segment->end_bus = end_bus;
        segment->reserved0 = 0u;
        cursor += 16u;
    }
    return SWYP_OK;
}

SwypStatus swyp_acpi_parse_dmar_table(const uint8_t *table, uint32_t length, SwypAcpiPlatform *platform) {
    uint32_t cursor = 48u;
    if (length < 48u || !swyp_acpi_signature(table, "DMAR", 4u)) {
        return SWYP_ERR_CORRUPT;
    }
    platform->dmar_host_address_width = (uint32_t)table[36] + 1u;
    platform->dmar_flags = table[37];
    if (platform->dmar_host_address_width > 64u) {
        return SWYP_ERR_CORRUPT;
    }
    while (cursor < length) {
        const uint8_t *entry;
        uint16_t type;
        uint16_t entry_length;
        if (length - cursor < 4u) {
            return SWYP_ERR_CORRUPT;
        }
        entry = table + cursor;
        type = swyp_acpi_u16(entry);
        entry_length = swyp_acpi_u16(entry + 2u);
        if (entry_length < 4u || entry_length > length - cursor) {
            return SWYP_ERR_CORRUPT;
        }
        if (type == 0u) {
            SwypAcpiDmarUnit *unit;
            uint64_t register_base;
            if (entry_length < 16u || platform->dmar_unit_count >= SWYP_ACPI_MAX_DMAR_UNITS) {
                return entry_length < 16u ? SWYP_ERR_CORRUPT : SWYP_ERR_NO_SPACE;
            }
            register_base = swyp_acpi_u64(entry + 8u);
            if (register_base == 0u || (register_base & UINT64_C(0xfff)) != 0u) {
                return SWYP_ERR_CORRUPT;
            }
            unit = &platform->dmar_units[platform->dmar_unit_count++];
            unit->register_base = register_base;
            unit->segment = swyp_acpi_u16(entry + 6u);
            unit->flags = entry[4];
            unit->reserved0 = 0u;
            unit->first_scope = (uint16_t)platform->dmar_scope_count;
            unit->scope_count = 0u;
            {
                uint32_t scope_cursor = 16u;
                while (scope_cursor < entry_length) {
                    const uint8_t *scope = entry + scope_cursor;
                    uint8_t scope_length;
                    uint8_t path_count;
                    SwypAcpiDmarScope *out;
                    uint32_t i;
                    if (entry_length - scope_cursor < 6u) {
                        return SWYP_ERR_CORRUPT;
                    }
                    scope_length = scope[1];
                    if (scope_length < 8u || scope_length > entry_length - scope_cursor ||
                        ((uint32_t)scope_length - 6u) % 2u != 0u) {
                        return SWYP_ERR_CORRUPT;
                    }
                    path_count = (uint8_t)(((uint32_t)scope_length - 6u) / 2u);
                    if (path_count == 0u || path_count > SWYP_ACPI_MAX_DMAR_SCOPE_PATH ||
                        platform->dmar_scope_count >= SWYP_ACPI_MAX_DMAR_SCOPES) {
                        return path_count == 0u || path_count > SWYP_ACPI_MAX_DMAR_SCOPE_PATH ? SWYP_ERR_CORRUPT
                                                                                             : SWYP_ERR_NO_SPACE;
                    }
                    out = &platform->dmar_scopes[platform->dmar_scope_count++];
                    *out = (SwypAcpiDmarScope){0};
                    out->type = scope[0];
                    out->enumeration_id = scope[4];
                    out->start_bus = scope[5];
                    out->path_count = path_count;
                    out->segment = unit->segment;
                    for (i = 0u; i < path_count; ++i) {
                        uint8_t device = scope[6u + i * 2u];
                        uint8_t function = scope[7u + i * 2u];
                        if (device > 31u || function > 7u) {
                            return SWYP_ERR_CORRUPT;
                        }
                        out->path[i].device = device;
                        out->path[i].function = function;
                    }
                    unit->scope_count += 1u;
                    scope_cursor += scope_length;
                }
            }
        } else if (type == 1u) {
            SwypAcpiDmarReserved *reserved;
            uint64_t base;
            uint64_t limit;
            if (entry_length < 24u || platform->dmar_reserved_count >= SWYP_ACPI_MAX_DMAR_RESERVED) {
                return entry_length < 24u ? SWYP_ERR_CORRUPT : SWYP_ERR_NO_SPACE;
            }
            base = swyp_acpi_u64(entry + 8u);
            limit = swyp_acpi_u64(entry + 16u);
            if (base > limit) {
                return SWYP_ERR_CORRUPT;
            }
            reserved = &platform->dmar_reserved[platform->dmar_reserved_count++];
            reserved->base = base;
            reserved->limit = limit;
            reserved->segment = swyp_acpi_u16(entry + 6u);
            reserved->first_scope = (uint16_t)platform->dmar_scope_count;
            reserved->scope_count = 0u;
            reserved->reserved0 = 0u;
            {
                uint32_t scope_cursor = 24u;
                while (scope_cursor < entry_length) {
                    const uint8_t *scope = entry + scope_cursor;
                    uint8_t scope_length;
                    uint8_t path_count;
                    SwypAcpiDmarScope *out;
                    uint32_t i;
                    if (entry_length - scope_cursor < 6u) {
                        return SWYP_ERR_CORRUPT;
                    }
                    scope_length = scope[1];
                    if (scope_length < 8u || scope_length > entry_length - scope_cursor ||
                        ((uint32_t)scope_length - 6u) % 2u != 0u) {
                        return SWYP_ERR_CORRUPT;
                    }
                    path_count = (uint8_t)(((uint32_t)scope_length - 6u) / 2u);
                    if (path_count == 0u || path_count > SWYP_ACPI_MAX_DMAR_SCOPE_PATH ||
                        platform->dmar_scope_count >= SWYP_ACPI_MAX_DMAR_SCOPES) {
                        return path_count == 0u || path_count > SWYP_ACPI_MAX_DMAR_SCOPE_PATH ? SWYP_ERR_CORRUPT
                                                                                             : SWYP_ERR_NO_SPACE;
                    }
                    out = &platform->dmar_scopes[platform->dmar_scope_count++];
                    *out = (SwypAcpiDmarScope){0};
                    out->type = scope[0];
                    out->enumeration_id = scope[4];
                    out->start_bus = scope[5];
                    out->path_count = path_count;
                    out->segment = reserved->segment;
                    for (i = 0u; i < path_count; ++i) {
                        uint8_t device = scope[6u + i * 2u];
                        uint8_t function = scope[7u + i * 2u];
                        if (device > 31u || function > 7u) {
                            return SWYP_ERR_CORRUPT;
                        }
                        out->path[i].device = device;
                        out->path[i].function = function;
                    }
                    reserved->scope_count += 1u;
                    scope_cursor += scope_length;
                }
            }
        }
        cursor += entry_length;
    }
    return cursor == length ? SWYP_OK : SWYP_ERR_CORRUPT;
}

static int swyp_acpi_dmar_direct_scope_match(const SwypAcpiDmarScope *scope, uint16_t segment, uint8_t bus,
                                              uint8_t device, uint8_t function) {
    return scope != NULL && scope->type == 1u && scope->segment == segment && scope->start_bus == bus &&
           scope->path_count == 1u && scope->path[0].device == device && scope->path[0].function == function;
}

static int swyp_acpi_dmar_scope_needs_topology(const SwypAcpiDmarScope *scope, uint16_t segment) {
    return scope != NULL && scope->segment == segment && (scope->type == 2u || scope->path_count > 1u);
}

SwypStatus swyp_acpi_dmar_select_unit(const SwypAcpiPlatform *platform, uint16_t segment, uint8_t bus,
                                      uint8_t device, uint8_t function, uint32_t *unit_index) {
    uint32_t exact = UINT32_MAX;
    uint32_t include_all = UINT32_MAX;
    uint32_t i;
    int unresolved_topology = 0;
    if (platform == NULL || unit_index == NULL || device > 31u || function > 7u) {
        return SWYP_ERR_INVALID;
    }
    *unit_index = UINT32_MAX;
    for (i = 0u; i < platform->dmar_unit_count; ++i) {
        const SwypAcpiDmarUnit *unit = &platform->dmar_units[i];
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
        if ((uint32_t)unit->first_scope + unit->scope_count > platform->dmar_scope_count) {
            return SWYP_ERR_CORRUPT;
        }
        for (j = 0u; j < unit->scope_count; ++j) {
            const SwypAcpiDmarScope *scope = &platform->dmar_scopes[unit->first_scope + j];
            if (swyp_acpi_dmar_direct_scope_match(scope, segment, bus, device, function)) {
                if (exact != UINT32_MAX && exact != i) {
                    return SWYP_ERR_CORRUPT;
                }
                exact = i;
            } else if (swyp_acpi_dmar_scope_needs_topology(scope, segment)) {
                unresolved_topology = 1;
            }
        }
    }
    if (exact != UINT32_MAX) {
        *unit_index = exact;
        return SWYP_OK;
    }
    if (unresolved_topology) {
        return SWYP_ERR_UNSUPPORTED;
    }
    if (include_all != UINT32_MAX) {
        *unit_index = include_all;
        return SWYP_OK;
    }
    return SWYP_ERR_NOT_FOUND;
}

SwypStatus swyp_acpi_dmar_reserved_for_requester(const SwypAcpiPlatform *platform, uint16_t segment, uint8_t bus,
                                                 uint8_t device, uint8_t function, uint64_t *base, uint64_t *limit) {
    uint32_t i;
    int unresolved_topology = 0;
    int found = 0;
    uint64_t found_base = 0u;
    uint64_t found_limit = 0u;
    if (platform == NULL || base == NULL || limit == NULL || device > 31u || function > 7u) {
        return SWYP_ERR_INVALID;
    }
    *base = 0u;
    *limit = 0u;
    for (i = 0u; i < platform->dmar_reserved_count; ++i) {
        const SwypAcpiDmarReserved *reserved = &platform->dmar_reserved[i];
        uint32_t j;
        if (reserved->segment != segment) {
            continue;
        }
        if ((uint32_t)reserved->first_scope + reserved->scope_count > platform->dmar_scope_count) {
            return SWYP_ERR_CORRUPT;
        }
        for (j = 0u; j < reserved->scope_count; ++j) {
            const SwypAcpiDmarScope *scope = &platform->dmar_scopes[reserved->first_scope + j];
            if (swyp_acpi_dmar_direct_scope_match(scope, segment, bus, device, function)) {
                if (found && (found_base != reserved->base || found_limit != reserved->limit)) {
                    return SWYP_ERR_UNSUPPORTED;
                }
                found = 1;
                found_base = reserved->base;
                found_limit = reserved->limit;
            } else if (swyp_acpi_dmar_scope_needs_topology(scope, segment)) {
                unresolved_topology = 1;
            }
        }
    }
    if (found) {
        *base = found_base;
        *limit = found_limit;
        return SWYP_OK;
    }
    return unresolved_topology ? SWYP_ERR_UNSUPPORTED : SWYP_ERR_NOT_FOUND;
}

static void swyp_acpi_platform_clear(SwypAcpiPlatform *platform) {
    uint8_t *bytes = (uint8_t *)(void *)platform;
    uint32_t i;
    for (i = 0u; i < (uint32_t)sizeof(*platform); ++i) {
        bytes[i] = 0u;
    }
}

SwypStatus swyp_acpi_discover(uint64_t rsdp_physical, const SwypAcpiMemoryOps *memory, SwypAcpiPlatform *platform) {
    const uint8_t *rsdp;
    const uint8_t *root;
    uint32_t rsdp_length = SWYP_ACPI_RSDP_V1_BYTES;
    uint32_t root_length;
    uint32_t entry_size;
    uint32_t entry_count;
    uint32_t i;
    uint64_t root_physical;
    int seen_madt = 0;
    int seen_mcfg = 0;
    int seen_dmar = 0;
    if (memory == NULL || memory->physical_to_virtual == NULL || platform == NULL || rsdp_physical == 0u) {
        return SWYP_ERR_INVALID;
    }
    swyp_acpi_platform_clear(platform);
    rsdp = swyp_acpi_span(memory, rsdp_physical, SWYP_ACPI_RSDP_V2_BYTES);
    if (rsdp == NULL || !swyp_acpi_signature(rsdp, "RSD PTR ", 8u) ||
        !swyp_acpi_checksum(rsdp, SWYP_ACPI_RSDP_V1_BYTES)) {
        return SWYP_ERR_CORRUPT;
    }
    if (rsdp[15] >= 2u) {
        rsdp_length = swyp_acpi_u32(rsdp + 20u);
        if (rsdp_length < SWYP_ACPI_RSDP_V2_BYTES || rsdp_length > 4096u ||
            swyp_acpi_span(memory, rsdp_physical, rsdp_length) == NULL || !swyp_acpi_checksum(rsdp, rsdp_length)) {
            return SWYP_ERR_CORRUPT;
        }
        root_physical = swyp_acpi_u64(rsdp + 24u);
        entry_size = 8u;
    } else {
        root_physical = swyp_acpi_u32(rsdp + 16u);
        entry_size = 4u;
    }
    if (root_physical == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    root = swyp_acpi_table(memory, root_physical, &root_length);
    if (root == NULL || (entry_size == 8u && !swyp_acpi_signature(root, "XSDT", 4u)) ||
        (entry_size == 4u && !swyp_acpi_signature(root, "RSDT", 4u)) ||
        (root_length - SWYP_ACPI_SDT_HEADER_BYTES) % entry_size != 0u) {
        return SWYP_ERR_CORRUPT;
    }
    entry_count = (root_length - SWYP_ACPI_SDT_HEADER_BYTES) / entry_size;
    if (entry_count > SWYP_ACPI_MAX_ROOT_ENTRIES) {
        return SWYP_ERR_NO_SPACE;
    }
    platform->rsdp_physical = rsdp_physical;
    platform->root_table_physical = root_physical;
    for (i = 0u; i < entry_count; ++i) {
        uint64_t table_physical = entry_size == 8u
                                      ? swyp_acpi_u64(root + SWYP_ACPI_SDT_HEADER_BYTES + (uint64_t)i * 8u)
                                      : swyp_acpi_u32(root + SWYP_ACPI_SDT_HEADER_BYTES + (uint64_t)i * 4u);
        uint32_t table_length;
        const uint8_t *table;
        SwypStatus status = SWYP_OK;
        if (table_physical == 0u) {
            continue;
        }
        table = swyp_acpi_table(memory, table_physical, &table_length);
        if (table == NULL) {
            return SWYP_ERR_CORRUPT;
        }
        if (swyp_acpi_signature(table, "APIC", 4u)) {
            if (seen_madt) {
                return SWYP_ERR_CORRUPT;
            }
            seen_madt = 1;
            status = swyp_acpi_parse_madt(table, table_length, platform);
        } else if (swyp_acpi_signature(table, "MCFG", 4u)) {
            if (seen_mcfg) {
                return SWYP_ERR_CORRUPT;
            }
            seen_mcfg = 1;
            status = swyp_acpi_parse_mcfg(table, table_length, platform);
        } else if (swyp_acpi_signature(table, "DMAR", 4u)) {
            if (seen_dmar) {
                return SWYP_ERR_CORRUPT;
            }
            seen_dmar = 1;
            status = swyp_acpi_parse_dmar_table(table, table_length, platform);
        }
        if (status != SWYP_OK) {
            return status;
        }
    }
    return SWYP_OK;
}
