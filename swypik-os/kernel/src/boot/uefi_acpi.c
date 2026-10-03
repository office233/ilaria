#include "swypik/boot/uefi_acpi.h"

#define SWYP_ACPI_RSDP_V1_BYTES 20u
#define SWYP_ACPI_RSDP_V2_BYTES 36u
#define SWYP_ACPI_RSDP_MAX_BYTES 4096u
#define SWYP_UEFI_CONFIG_TABLE_MAX 1024u

static const EFI_GUID kAcpi20TableGuid = {
    UINT32_C(0x8868e871), UINT16_C(0xe4f1), UINT16_C(0x11d3),
    {0xbc, 0x22, 0x00, 0x80, 0xc7, 0x3c, 0x88, 0x81}
};

static const EFI_GUID kAcpi10TableGuid = {
    UINT32_C(0xeb9d2d30), UINT16_C(0x2d88), UINT16_C(0x11d3),
    {0x9a, 0x16, 0x00, 0x90, 0x27, 0x3f, 0xc1, 0x4d}
};

static int swyp_uefi_guid_equal(const EFI_GUID *left, const EFI_GUID *right) {
    uint32_t i;
    if (left == NULL || right == NULL || left->Data1 != right->Data1 || left->Data2 != right->Data2 ||
        left->Data3 != right->Data3) {
        return 0;
    }
    for (i = 0u; i < 8u; ++i) {
        if (left->Data4[i] != right->Data4[i]) {
            return 0;
        }
    }
    return 1;
}

static uint32_t swyp_uefi_read_u32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static int swyp_acpi_checksum_ok(const uint8_t *bytes, uint32_t length) {
    uint8_t sum = 0u;
    uint32_t i;
    if (bytes == NULL || length == 0u) {
        return 0;
    }
    for (i = 0u; i < length; ++i) {
        sum = (uint8_t)(sum + bytes[i]);
    }
    return sum == 0u;
}

static SwypStatus swyp_uefi_validate_rsdp(const void *table, uint32_t *length, uint32_t *revision) {
    const uint8_t *bytes = (const uint8_t *)table;
    static const uint8_t signature[8] = {'R', 'S', 'D', ' ', 'P', 'T', 'R', ' '};
    uint32_t i;
    uint32_t rsdp_length = SWYP_ACPI_RSDP_V1_BYTES;
    uint32_t rsdp_revision;
    if (bytes == NULL || length == NULL || revision == NULL) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0u; i < 8u; ++i) {
        if (bytes[i] != signature[i]) {
            return SWYP_ERR_CORRUPT;
        }
    }
    if (!swyp_acpi_checksum_ok(bytes, SWYP_ACPI_RSDP_V1_BYTES)) {
        return SWYP_ERR_CORRUPT;
    }
    rsdp_revision = bytes[15];
    if (rsdp_revision >= 2u) {
        rsdp_length = swyp_uefi_read_u32(bytes + 20u);
        if (rsdp_length < SWYP_ACPI_RSDP_V2_BYTES || rsdp_length > SWYP_ACPI_RSDP_MAX_BYTES ||
            !swyp_acpi_checksum_ok(bytes, rsdp_length)) {
            return SWYP_ERR_CORRUPT;
        }
    }
    *length = rsdp_length;
    *revision = rsdp_revision;
    return SWYP_OK;
}

SwypStatus swyp_uefi_capture_acpi_root(const EFI_SYSTEM_TABLE *system_table, SwypBootInfo *boot_info) {
    const EFI_CONFIGURATION_TABLE *selected = NULL;
    uint32_t selected_priority = 0u;
    EFI_UINTN i;
    uint32_t length = 0u;
    uint32_t revision = 0u;
    SwypStatus status;
    if (system_table == NULL || boot_info == NULL) {
        return SWYP_ERR_INVALID;
    }
    boot_info->acpi_rsdp_address = 0u;
    boot_info->acpi_rsdp_length = 0u;
    boot_info->acpi_revision = 0u;
    if (system_table->NumberOfTableEntries == 0u || system_table->ConfigurationTable == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (system_table->NumberOfTableEntries > SWYP_UEFI_CONFIG_TABLE_MAX) {
        return SWYP_ERR_CORRUPT;
    }
    for (i = 0u; i < system_table->NumberOfTableEntries; ++i) {
        const EFI_CONFIGURATION_TABLE *entry = &system_table->ConfigurationTable[i];
        uint32_t priority = 0u;
        if (entry->VendorTable == NULL) {
            continue;
        }
        if (swyp_uefi_guid_equal(&entry->VendorGuid, &kAcpi20TableGuid)) {
            priority = 2u;
        } else if (swyp_uefi_guid_equal(&entry->VendorGuid, &kAcpi10TableGuid)) {
            priority = 1u;
        }
        if (priority > selected_priority) {
            selected = entry;
            selected_priority = priority;
        }
    }
    if (selected == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    status = swyp_uefi_validate_rsdp(selected->VendorTable, &length, &revision);
    if (status != SWYP_OK) {
        return status;
    }
    boot_info->acpi_rsdp_address = (uint64_t)(uintptr_t)selected->VendorTable;
    boot_info->acpi_rsdp_length = length;
    boot_info->acpi_revision = revision;
    return SWYP_OK;
}
