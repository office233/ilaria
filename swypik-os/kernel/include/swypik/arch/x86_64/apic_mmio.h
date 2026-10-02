#ifndef SWYPIK_ARCH_X86_64_APIC_MMIO_H
#define SWYPIK_ARCH_X86_64_APIC_MMIO_H

#include "swypik/arch/x86_64/apic.h"

typedef struct SwypX86ApicMmio {
    volatile uint8_t *lapic_base;
    volatile uint8_t *ioapic_base;
} SwypX86ApicMmio;

SwypStatus swyp_x86_apic_mmio_init(SwypX86ApicMmio *mmio, volatile void *lapic_base, volatile void *ioapic_base);
const SwypX86ApicHardwareOps *swyp_x86_apic_mmio_ops(void);

#endif
