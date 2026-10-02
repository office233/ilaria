#ifndef SWYPIK_ARCH_X86_64_EXTENDED_STATE_H
#define SWYPIK_ARCH_X86_64_EXTENDED_STATE_H

#include "swypik/kernel/abi.h"

#define SWYP_X86_FX_STATE_BYTES 512u

typedef struct SwypX86FxState {
    _Alignas(16) uint8_t bytes[SWYP_X86_FX_STATE_BYTES];
} SwypX86FxState;

typedef struct SwypX86ExtendedStateOps {
    SwypStatus (*save_fx)(void *context, SwypX86FxState *state);
    SwypStatus (*restore_fx)(void *context, const SwypX86FxState *state);
    uint64_t (*read_fs_base)(void *context);
    uint64_t (*read_gs_base)(void *context);
    SwypStatus (*write_fs_base)(void *context, uint64_t value);
    SwypStatus (*write_gs_base)(void *context, uint64_t value);
} SwypX86ExtendedStateOps;

void swyp_x86_fx_state_init_default(SwypX86FxState *state);
SwypStatus swyp_x86_extended_state_native_enable(void);
const SwypX86ExtendedStateOps *swyp_x86_extended_state_native_ops(void);

#endif
