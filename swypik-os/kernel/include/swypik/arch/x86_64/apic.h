#ifndef SWYPIK_ARCH_X86_64_APIC_H
#define SWYPIK_ARCH_X86_64_APIC_H

#include "swypik/kernel/contracts.h"

#define SWYP_X86_APIC_MAX_REDIRECTIONS 120u

typedef struct SwypX86ApicHardwareOps {
    SwypStatus (*ioapic_read)(void *context, uint32_t reg, uint32_t *value);
    SwypStatus (*ioapic_write)(void *context, uint32_t reg, uint32_t value);
    SwypStatus (*lapic_write)(void *context, uint32_t offset, uint32_t value);
} SwypX86ApicHardwareOps;

typedef struct SwypX86ApicRoute {
    uint32_t bound;
    uint32_t masked;
    uint32_t vector;
    uint32_t preserved_flags;
} SwypX86ApicRoute;

typedef struct SwypX86Apic {
    SwypInterruptSource contract;
    void *hardware_context;
    const SwypX86ApicHardwareOps *hardware_ops;
    uint32_t gsi_base;
    uint32_t redirection_count;
    uint32_t destination_apic_id;
    uint32_t failed;
    SwypX86ApicRoute routes[SWYP_X86_APIC_MAX_REDIRECTIONS];
} SwypX86Apic;

SwypStatus swyp_x86_apic_init(SwypX86Apic *apic, void *hardware_context, const SwypX86ApicHardwareOps *hardware_ops,
                              uint32_t gsi_base, uint32_t redirection_count, uint32_t destination_apic_id);
SwypInterruptSource *swyp_x86_apic_contract(SwypX86Apic *apic);

#endif
