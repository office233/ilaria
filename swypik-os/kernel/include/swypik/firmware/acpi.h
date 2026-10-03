#ifndef SWYPIK_FIRMWARE_ACPI_H
#define SWYPIK_FIRMWARE_ACPI_H

#include "swypik/kernel/abi.h"

#define SWYP_ACPI_MAX_ROOT_ENTRIES 256u
#define SWYP_ACPI_MAX_TABLE_BYTES (1024u * 1024u)
#define SWYP_ACPI_MAX_CPUS 128u
#define SWYP_ACPI_MAX_IOAPICS 8u
#define SWYP_ACPI_MAX_ISO 32u
#define SWYP_ACPI_MAX_MCFG_SEGMENTS 16u
#define SWYP_ACPI_MAX_DMAR_UNITS 16u
#define SWYP_ACPI_MAX_DMAR_RESERVED 32u
#define SWYP_ACPI_MAX_DMAR_SCOPES 128u
#define SWYP_ACPI_MAX_DMAR_SCOPE_PATH 8u

typedef struct SwypAcpiMemoryOps {
    void *context;
    void *(*physical_to_virtual)(void *context, uint64_t physical_address);
} SwypAcpiMemoryOps;

typedef struct SwypAcpiCpu {
    uint32_t apic_id;
    uint32_t acpi_uid;
    uint32_t flags;
    uint32_t x2apic;
} SwypAcpiCpu;

typedef struct SwypAcpiIoApic {
    uint32_t id;
    uint32_t address;
    uint32_t gsi_base;
    uint32_t reserved0;
} SwypAcpiIoApic;

typedef struct SwypAcpiInterruptOverride {
    uint8_t bus;
    uint8_t source;
    uint16_t flags;
    uint32_t gsi;
} SwypAcpiInterruptOverride;

typedef struct SwypAcpiMcfgSegment {
    uint64_t physical_base;
    uint16_t segment;
    uint8_t start_bus;
    uint8_t end_bus;
    uint32_t reserved0;
} SwypAcpiMcfgSegment;

typedef struct SwypAcpiDmarUnit {
    uint64_t register_base;
    uint16_t segment;
    uint8_t flags;
    uint8_t reserved0;
    uint16_t first_scope;
    uint16_t scope_count;
} SwypAcpiDmarUnit;

typedef struct SwypAcpiDmarReserved {
    uint64_t base;
    uint64_t limit;
    uint16_t segment;
    uint16_t first_scope;
    uint16_t scope_count;
    uint16_t reserved0;
} SwypAcpiDmarReserved;

typedef struct SwypAcpiDmarPathElement {
    uint8_t device;
    uint8_t function;
} SwypAcpiDmarPathElement;

typedef struct SwypAcpiDmarScope {
    uint8_t type;
    uint8_t enumeration_id;
    uint8_t start_bus;
    uint8_t path_count;
    uint16_t segment;
    uint16_t reserved0;
    SwypAcpiDmarPathElement path[SWYP_ACPI_MAX_DMAR_SCOPE_PATH];
} SwypAcpiDmarScope;

typedef struct SwypAcpiPlatform {
    uint64_t rsdp_physical;
    uint64_t root_table_physical;
    uint64_t local_apic_address;
    uint32_t madt_flags;
    uint32_t cpu_count;
    uint32_t ioapic_count;
    uint32_t interrupt_override_count;
    uint32_t mcfg_segment_count;
    uint32_t dmar_unit_count;
    uint32_t dmar_reserved_count;
    uint32_t dmar_scope_count;
    uint32_t dmar_flags;
    uint32_t dmar_host_address_width;
    SwypAcpiCpu cpus[SWYP_ACPI_MAX_CPUS];
    SwypAcpiIoApic ioapics[SWYP_ACPI_MAX_IOAPICS];
    SwypAcpiInterruptOverride interrupt_overrides[SWYP_ACPI_MAX_ISO];
    SwypAcpiMcfgSegment mcfg_segments[SWYP_ACPI_MAX_MCFG_SEGMENTS];
    SwypAcpiDmarUnit dmar_units[SWYP_ACPI_MAX_DMAR_UNITS];
    SwypAcpiDmarReserved dmar_reserved[SWYP_ACPI_MAX_DMAR_RESERVED];
    SwypAcpiDmarScope dmar_scopes[SWYP_ACPI_MAX_DMAR_SCOPES];
} SwypAcpiPlatform;

SwypStatus swyp_acpi_discover(uint64_t rsdp_physical, const SwypAcpiMemoryOps *memory, SwypAcpiPlatform *platform);
SwypStatus swyp_acpi_parse_dmar_table(const uint8_t *table, uint32_t length, SwypAcpiPlatform *platform);
SwypStatus swyp_acpi_dmar_select_unit(const SwypAcpiPlatform *platform, uint16_t segment, uint8_t bus,
                                      uint8_t device, uint8_t function, uint32_t *unit_index);
SwypStatus swyp_acpi_dmar_reserved_for_requester(const SwypAcpiPlatform *platform, uint16_t segment, uint8_t bus,
                                                 uint8_t device, uint8_t function, uint64_t *base, uint64_t *limit);

#endif
