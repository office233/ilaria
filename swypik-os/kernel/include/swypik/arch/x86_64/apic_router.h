#ifndef SWYPIK_ARCH_X86_64_APIC_ROUTER_H
#define SWYPIK_ARCH_X86_64_APIC_ROUTER_H

#include "swypik/arch/x86_64/apic.h"

#define SWYP_X86_APIC_ROUTER_MAX_UNITS 8u

typedef struct SwypX86ApicRouter {
    SwypInterruptSource contract;
    SwypX86Apic *units[SWYP_X86_APIC_ROUTER_MAX_UNITS];
    uint32_t unit_count;
    uint32_t failed;
} SwypX86ApicRouter;

SwypStatus swyp_x86_apic_router_init(SwypX86ApicRouter *router, SwypX86Apic *const *units, uint32_t unit_count);
SwypInterruptSource *swyp_x86_apic_router_contract(SwypX86ApicRouter *router);

#endif
