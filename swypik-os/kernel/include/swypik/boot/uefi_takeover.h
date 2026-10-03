#ifndef SWYPIK_BOOT_UEFI_TAKEOVER_H
#define SWYPIK_BOOT_UEFI_TAKEOVER_H

#include "swypik/boot/uefi_bootstrap.h"
#include "swypik/boot/uefi_handoff.h"
#include "swypik/boot/pe_image.h"

typedef enum SwypUefiTakeoverStage {
    SWYP_UEFI_TAKEOVER_STAGE_NONE = 0,
    SWYP_UEFI_TAKEOVER_STAGE_DIRECT_RANGES = 1,
    SWYP_UEFI_TAKEOVER_STAGE_PE_RANGES = 2,
    SWYP_UEFI_TAKEOVER_STAGE_IMAGE_COVERAGE = 3,
    SWYP_UEFI_TAKEOVER_STAGE_ARENA_COVERAGE = 4,
    SWYP_UEFI_TAKEOVER_STAGE_ROOT = 5,
    SWYP_UEFI_TAKEOVER_STAGE_PREPARED = 6
} SwypUefiTakeoverStage;

typedef struct SwypUefiTakeover {
    SwypUefiBootstrapArena *arena;
    const void *image_base;
    uint64_t image_size;
    SwypKernelTakeover takeover;
    SwypKernelPhysicalRange direct_ranges[SWYP_KERNEL_TAKEOVER_MAX_DIRECT_RANGES];
    SwypKernelIdentityRange identity_ranges[SWYP_KERNEL_TAKEOVER_MAX_IDENTITY_RANGES];
    uint32_t direct_range_count;
    uint32_t identity_range_count;
    SwypUefiTakeoverStage stage;
    SwypStatus last_status;
} SwypUefiTakeover;

SwypStatus swyp_uefi_takeover_init(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table,
                                   SwypUefiBootstrapArena *arena, SwypUefiTakeover *takeover);
SwypStatus swyp_uefi_takeover_prepare_exit(void *context, const SwypBootInfo *boot_info);
uint64_t swyp_uefi_takeover_root_physical(const SwypUefiTakeover *takeover);
uint64_t swyp_uefi_takeover_stack_top(const SwypUefiTakeover *takeover);
SwypStatus swyp_uefi_takeover_confirm_active(SwypUefiTakeover *takeover);

#endif
