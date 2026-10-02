#ifndef SWYPIK_BOOT_UEFI_HANDOFF_H
#define SWYPIK_BOOT_UEFI_HANDOFF_H

#include "swypik/kernel/contracts.h"
#include "swypik/uefi/uefi.h"

typedef SwypStatus (*SwypUefiPrepareExit)(void *context, const SwypBootInfo *boot_info);

EFI_STATUS swyp_uefi_capture_memory_map(EFI_SYSTEM_TABLE *system_table, void *storage, EFI_UINTN storage_bytes,
                                        SwypBootInfo *boot_info);
EFI_STATUS swyp_uefi_exit_boot_services(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table, void *storage,
                                        EFI_UINTN storage_bytes, SwypBootInfo *boot_info, uint32_t max_attempts);
EFI_STATUS swyp_uefi_exit_boot_services_prepared(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table,
                                                 void *storage, EFI_UINTN storage_bytes, SwypBootInfo *boot_info,
                                                 uint32_t max_attempts, SwypUefiPrepareExit prepare,
                                                 void *prepare_context);

#endif
