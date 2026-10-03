#include "swypik/arch/x86_64/apic.h"

#define SWYP_X86_IOAPIC_REDIR_BASE 0x10u
#define SWYP_X86_IOAPIC_POLARITY_LOW (1u << 13)
#define SWYP_X86_IOAPIC_TRIGGER_LEVEL (1u << 15)
#define SWYP_X86_IOAPIC_MASKED (1u << 16)
#define SWYP_X86_IOAPIC_PRESERVED (SWYP_X86_IOAPIC_POLARITY_LOW | SWYP_X86_IOAPIC_TRIGGER_LEVEL)
#define SWYP_X86_LAPIC_EOI 0xB0u

static SwypStatus swyp_x86_apic_route_index(const SwypX86Apic *apic, uint32_t source_id, uint32_t *index) {
    uint64_t end;
    if (apic == NULL || index == NULL || apic->redirection_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    end = (uint64_t)apic->gsi_base + (uint64_t)apic->redirection_count;
    if ((uint64_t)source_id < apic->gsi_base || (uint64_t)source_id >= end) {
        return SWYP_ERR_NOT_FOUND;
    }
    *index = source_id - apic->gsi_base;
    return SWYP_OK;
}

static uint32_t swyp_x86_apic_low_reg(uint32_t index) {
    return SWYP_X86_IOAPIC_REDIR_BASE + index * 2u;
}

static uint32_t swyp_x86_apic_high_reg(uint32_t index) {
    return swyp_x86_apic_low_reg(index) + 1u;
}

static SwypStatus swyp_x86_apic_bind(void *context, uint32_t source_id, uint32_t vector) {
    SwypX86Apic *apic = (SwypX86Apic *)context;
    SwypX86ApicRoute *route;
    uint32_t index;
    uint32_t old_low = 0u;
    uint32_t old_high = 0u;
    uint32_t new_low;
    SwypStatus status;
    if (apic == NULL || apic->failed != 0u || vector < 32u || vector >= 255u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_apic_route_index(apic, source_id, &index);
    if (status != SWYP_OK) {
        return status;
    }
    route = &apic->routes[index];
    if (route->bound != 0u) {
        return SWYP_ERR_DENIED;
    }
    status = apic->hardware_ops->ioapic_read(apic->hardware_context, swyp_x86_apic_low_reg(index), &old_low);
    if (status != SWYP_OK) {
        return status;
    }
    status = apic->hardware_ops->ioapic_read(apic->hardware_context, swyp_x86_apic_high_reg(index), &old_high);
    if (status != SWYP_OK) {
        return status;
    }
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index),
                                               old_low | SWYP_X86_IOAPIC_MASKED);
    if (status != SWYP_OK) {
        return status;
    }
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_high_reg(index),
                                               apic->destination_apic_id << 24);
    if (status != SWYP_OK) {
        if (apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index), old_low) !=
            SWYP_OK) {
            apic->failed = 1u;
        }
        return status;
    }
    new_low = vector | (old_low & SWYP_X86_IOAPIC_PRESERVED) | SWYP_X86_IOAPIC_MASKED;
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index), new_low);
    if (status != SWYP_OK) {
        SwypStatus rollback_high =
            apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_high_reg(index), old_high);
        SwypStatus rollback_low =
            apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index), old_low);
        if (rollback_high != SWYP_OK || rollback_low != SWYP_OK) {
            apic->failed = 1u;
        }
        return status;
    }
    route->bound = 1u;
    route->masked = 1u;
    route->vector = vector;
    route->preserved_flags = old_low & SWYP_X86_IOAPIC_PRESERVED;
    return SWYP_OK;
}

static SwypStatus swyp_x86_apic_mask(void *context, uint32_t source_id) {
    SwypX86Apic *apic = (SwypX86Apic *)context;
    SwypX86ApicRoute *route;
    uint32_t index;
    uint32_t low;
    SwypStatus status;
    if (apic == NULL || apic->failed != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_apic_route_index(apic, source_id, &index);
    if (status != SWYP_OK) {
        return status;
    }
    route = &apic->routes[index];
    if (route->bound == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    low = route->vector | route->preserved_flags | SWYP_X86_IOAPIC_MASKED;
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index), low);
    if (status == SWYP_OK) {
        route->masked = 1u;
    }
    return status;
}

static SwypStatus swyp_x86_apic_unmask(void *context, uint32_t source_id) {
    SwypX86Apic *apic = (SwypX86Apic *)context;
    SwypX86ApicRoute *route;
    uint32_t index;
    uint32_t low;
    SwypStatus status;
    if (apic == NULL || apic->failed != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_apic_route_index(apic, source_id, &index);
    if (status != SWYP_OK) {
        return status;
    }
    route = &apic->routes[index];
    if (route->bound == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    low = route->vector | route->preserved_flags;
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index), low);
    if (status == SWYP_OK) {
        route->masked = 0u;
    }
    return status;
}

static SwypStatus swyp_x86_apic_unbind(void *context, uint32_t source_id) {
    SwypX86Apic *apic = (SwypX86Apic *)context;
    SwypX86ApicRoute *route;
    uint32_t index;
    SwypStatus status;
    if (apic == NULL || apic->failed != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_apic_route_index(apic, source_id, &index);
    if (status != SWYP_OK) {
        return status;
    }
    route = &apic->routes[index];
    if (route->bound == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    status = swyp_x86_apic_mask(context, source_id);
    if (status != SWYP_OK) {
        return status;
    }
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_high_reg(index), 0u);
    if (status != SWYP_OK) {
        return status;
    }
    status = apic->hardware_ops->ioapic_write(apic->hardware_context, swyp_x86_apic_low_reg(index),
                                               route->preserved_flags | SWYP_X86_IOAPIC_MASKED);
    if (status != SWYP_OK) {
        return status;
    }
    route->bound = 0u;
    route->masked = 1u;
    route->vector = 0u;
    return SWYP_OK;
}

static SwypStatus swyp_x86_apic_eoi(void *context, uint32_t source_id) {
    SwypX86Apic *apic = (SwypX86Apic *)context;
    uint32_t index;
    SwypStatus status;
    if (apic == NULL || apic->failed != 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_x86_apic_route_index(apic, source_id, &index);
    if (status != SWYP_OK) {
        return status;
    }
    if (apic->routes[index].bound == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    return apic->hardware_ops->lapic_write(apic->hardware_context, SWYP_X86_LAPIC_EOI, 0u);
}

static const SwypInterruptSourceOps swyp_x86_apic_interrupt_ops = {
    .bind = swyp_x86_apic_bind,
    .unbind = swyp_x86_apic_unbind,
    .mask = swyp_x86_apic_mask,
    .unmask = swyp_x86_apic_unmask,
    .end_of_interrupt = swyp_x86_apic_eoi,
};

SwypStatus swyp_x86_apic_init(SwypX86Apic *apic, void *hardware_context, const SwypX86ApicHardwareOps *hardware_ops,
                              uint32_t gsi_base, uint32_t redirection_count, uint32_t destination_apic_id) {
    uint32_t i;
    if (apic == NULL || hardware_ops == NULL || hardware_ops->ioapic_read == NULL ||
        hardware_ops->ioapic_write == NULL || hardware_ops->lapic_write == NULL || redirection_count == 0u ||
        redirection_count > SWYP_X86_APIC_MAX_REDIRECTIONS || destination_apic_id > 255u ||
        (uint64_t)gsi_base + redirection_count > UINT32_MAX) {
        return SWYP_ERR_INVALID;
    }
    apic->contract.context = apic;
    apic->contract.ops = &swyp_x86_apic_interrupt_ops;
    apic->hardware_context = hardware_context;
    apic->hardware_ops = hardware_ops;
    apic->gsi_base = gsi_base;
    apic->redirection_count = redirection_count;
    apic->destination_apic_id = destination_apic_id;
    apic->failed = 0u;
    for (i = 0; i < SWYP_X86_APIC_MAX_REDIRECTIONS; ++i) {
        apic->routes[i].bound = 0u;
        apic->routes[i].masked = 1u;
        apic->routes[i].vector = 0u;
        apic->routes[i].preserved_flags = 0u;
    }
    return SWYP_OK;
}

SwypInterruptSource *swyp_x86_apic_contract(SwypX86Apic *apic) {
    if (apic == NULL || apic->failed != 0u || apic->contract.ops == NULL) {
        return NULL;
    }
    return &apic->contract;
}
