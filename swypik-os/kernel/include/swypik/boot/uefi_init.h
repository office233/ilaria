#ifndef SWYPIK_BOOT_UEFI_INIT_H
#define SWYPIK_BOOT_UEFI_INIT_H

#include "swypik/kernel/contracts.h"
#include "swypik/uefi/uefi.h"

#define SWYP_INIT_IMAGE_MAX_BYTES UINT64_C(1048576)

/* Optional boot-volume input; no built-in program and no ambient grants.
   EFI_SUCCESS includes an explicitly recorded absence/refusal. Firmware
   cleanup failures return EFI_DEVICE_ERROR rather than proceeding. */
EFI_STATUS swyp_uefi_load_init(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table, SwypBootInfo *boot_info);

#endif
