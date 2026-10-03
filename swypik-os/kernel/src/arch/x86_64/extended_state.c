#include "swypik/arch/x86_64/extended_state.h"

#define SWYP_X86_MSR_FS_BASE UINT32_C(0xc0000100)
#define SWYP_X86_MSR_GS_BASE UINT32_C(0xc0000101)

static SwypStatus swyp_x86_extended_save_fx(void *context, SwypX86FxState *state) {
    (void)context;
    if (state == NULL || ((uintptr_t)state & UINT64_C(0xf)) != 0u) {
        return SWYP_ERR_INVALID;
    }
#if defined(__GNUC__) && defined(__x86_64__)
    __asm__ volatile("fxsave64 (%0)" : : "r"(state) : "memory");
    return SWYP_OK;
#else
    return SWYP_ERR_UNSUPPORTED;
#endif
}

static SwypStatus swyp_x86_extended_restore_fx(void *context, const SwypX86FxState *state) {
    (void)context;
    if (state == NULL || ((uintptr_t)state & UINT64_C(0xf)) != 0u) {
        return SWYP_ERR_INVALID;
    }
#if defined(__GNUC__) && defined(__x86_64__)
    __asm__ volatile("fxrstor64 (%0)" : : "r"(state) : "memory");
    return SWYP_OK;
#else
    return SWYP_ERR_UNSUPPORTED;
#endif
}

static uint64_t swyp_x86_extended_read_msr(uint32_t msr) {
    uint32_t low = 0u;
    uint32_t high = 0u;
#if defined(__GNUC__) && defined(__x86_64__)
    __asm__ volatile("rdmsr" : "=a"(low), "=d"(high) : "c"(msr));
#else
    (void)msr;
#endif
    return ((uint64_t)high << 32) | low;
}

static SwypStatus swyp_x86_extended_write_msr(uint32_t msr, uint64_t value) {
#if defined(__GNUC__) && defined(__x86_64__)
    __asm__ volatile("wrmsr" : : "c"(msr), "a"((uint32_t)value), "d"((uint32_t)(value >> 32)) : "memory");
    return SWYP_OK;
#else
    (void)msr;
    (void)value;
    return SWYP_ERR_UNSUPPORTED;
#endif
}

static uint64_t swyp_x86_extended_read_fs(void *context) {
    (void)context;
    return swyp_x86_extended_read_msr(SWYP_X86_MSR_FS_BASE);
}

static uint64_t swyp_x86_extended_read_gs(void *context) {
    (void)context;
    return swyp_x86_extended_read_msr(SWYP_X86_MSR_GS_BASE);
}

static SwypStatus swyp_x86_extended_write_fs(void *context, uint64_t value) {
    (void)context;
    return swyp_x86_extended_write_msr(SWYP_X86_MSR_FS_BASE, value);
}

static SwypStatus swyp_x86_extended_write_gs(void *context, uint64_t value) {
    (void)context;
    return swyp_x86_extended_write_msr(SWYP_X86_MSR_GS_BASE, value);
}

static const SwypX86ExtendedStateOps swyp_x86_native_extended_ops = {
    .save_fx = swyp_x86_extended_save_fx,
    .restore_fx = swyp_x86_extended_restore_fx,
    .read_fs_base = swyp_x86_extended_read_fs,
    .read_gs_base = swyp_x86_extended_read_gs,
    .write_fs_base = swyp_x86_extended_write_fs,
    .write_gs_base = swyp_x86_extended_write_gs,
};

void swyp_x86_fx_state_init_default(SwypX86FxState *state) {
    uint32_t i;
    if (state == NULL) {
        return;
    }
    for (i = 0u; i < SWYP_X86_FX_STATE_BYTES; ++i) {
        state->bytes[i] = 0u;
    }
    state->bytes[0] = UINT8_C(0x7f);
    state->bytes[1] = UINT8_C(0x03); /* x87 FCW = 0x037f */
    state->bytes[24] = UINT8_C(0x80);
    state->bytes[25] = UINT8_C(0x1f); /* MXCSR = 0x1f80 */
}

SwypStatus swyp_x86_extended_state_native_enable(void) {
#if defined(__GNUC__) && defined(__x86_64__)
    uint64_t cr0;
    uint64_t cr4;
    __asm__ volatile("mov %%cr0, %0" : "=r"(cr0));
    cr0 &= ~((UINT64_C(1) << 2) | (UINT64_C(1) << 3)); /* EM, TS */
    cr0 |= (UINT64_C(1) << 1) | (UINT64_C(1) << 5);    /* MP, NE */
    __asm__ volatile("mov %0, %%cr0" : : "r"(cr0) : "memory");
    __asm__ volatile("mov %%cr4, %0" : "=r"(cr4));
    cr4 |= (UINT64_C(1) << 9) | (UINT64_C(1) << 10); /* OSFXSR, OSXMMEXCPT */
    __asm__ volatile("mov %0, %%cr4" : : "r"(cr4) : "memory");
    __asm__ volatile("fninit" : : : "memory");
    return SWYP_OK;
#else
    return SWYP_ERR_UNSUPPORTED;
#endif
}

const SwypX86ExtendedStateOps *swyp_x86_extended_state_native_ops(void) {
    return &swyp_x86_native_extended_ops;
}
