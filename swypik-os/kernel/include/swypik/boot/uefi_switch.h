#ifndef SWYPIK_BOOT_UEFI_SWITCH_H
#define SWYPIK_BOOT_UEFI_SWITCH_H

#include "swypik/uefi/uefi.h"

typedef void(SWYP_EFIAPI *SwypUefiTakeoverContinuation)(void *context);

void SWYP_EFIAPI swyp_uefi_takeover_switch(uint64_t root_physical, uint64_t stack_top,
                                           SwypUefiTakeoverContinuation continuation,
                                           void *context) __attribute__((noreturn));

#endif
