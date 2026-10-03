#ifndef SWYPIK_ARCH_X86_64_VTD_MMIO_H
#define SWYPIK_ARCH_X86_64_VTD_MMIO_H

#include "swypik/arch/x86_64/vtd.h"

typedef struct SwypX86VtdMmio {
    volatile uint8_t *base;
    uint32_t length;
    uint32_t reserved0;
} SwypX86VtdMmio;

SwypStatus swyp_x86_vtd_mmio_init(SwypX86VtdMmio *mmio, volatile void *base, uint32_t length);
const SwypX86VtdRegisterOps *swyp_x86_vtd_mmio_ops(void);

#endif
