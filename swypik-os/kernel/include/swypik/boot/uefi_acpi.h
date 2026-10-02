#ifndef SWYPIK_BOOT_UEFI_ACPI_H
#define SWYPIK_BOOT_UEFI_ACPI_H

#include "swypik/kernel/contracts.h"
#include "swypik/uefi/uefi.h"

SwypStatus swyp_uefi_capture_acpi_root(const EFI_SYSTEM_TABLE *system_table, SwypBootInfo *boot_info);

#endif
