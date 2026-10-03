#include "swypik/arch/x86_64/apic_router.h"

static SwypX86Apic *swyp_x86_apic_router_unit_for_source(SwypX86ApicRouter *router, uint32_t source_id) {
    uint32_t i;
    SwypX86Apic *found = NULL;
    if (router == NULL) {
        return NULL;
    }
    for (i = 0u; i < router->unit_count; ++i) {
        SwypX86Apic *unit = router->units[i];
        uint64_t end;
        if (unit == NULL || unit->redirection_count == 0u) {
            continue;
        }
        end = (uint64_t)unit->gsi_base + unit->redirection_count;
        if ((uint64_t)source_id >= unit->gsi_base && (uint64_t)source_id < end) {
            if (found != NULL) {
                router->failed = 1u;
                return NULL;
            }
            found = unit;
        }
    }
    return found;
}

static SwypStatus swyp_x86_apic_router_bind(void *context, uint32_t source_id, uint32_t vector) {
    SwypX86ApicRouter *router = (SwypX86ApicRouter *)context;
    SwypX86Apic *unit = swyp_x86_apic_router_unit_for_source(router, source_id);
    SwypInterruptSource *contract;
    if (router == NULL || router->failed != 0u || unit == NULL) {
        return router != NULL && router->failed != 0u ? SWYP_ERR_CORRUPT : SWYP_ERR_NOT_FOUND;
    }
    contract = swyp_x86_apic_contract(unit);
    return contract == NULL || contract->ops == NULL || contract->ops->bind == NULL
               ? SWYP_ERR_CORRUPT
               : contract->ops->bind(contract->context, source_id, vector);
}

static SwypStatus swyp_x86_apic_router_unbind(void *context, uint32_t source_id) {
    SwypX86ApicRouter *router = (SwypX86ApicRouter *)context;
    SwypX86Apic *unit = swyp_x86_apic_router_unit_for_source(router, source_id);
    SwypInterruptSource *contract;
    if (router == NULL || router->failed != 0u || unit == NULL) {
        return router != NULL && router->failed != 0u ? SWYP_ERR_CORRUPT : SWYP_ERR_NOT_FOUND;
    }
    contract = swyp_x86_apic_contract(unit);
    return contract == NULL || contract->ops == NULL || contract->ops->unbind == NULL
               ? SWYP_ERR_CORRUPT
               : contract->ops->unbind(contract->context, source_id);
}

static SwypStatus swyp_x86_apic_router_mask(void *context, uint32_t source_id) {
    SwypX86ApicRouter *router = (SwypX86ApicRouter *)context;
    SwypX86Apic *unit = swyp_x86_apic_router_unit_for_source(router, source_id);
    SwypInterruptSource *contract;
    if (router == NULL || router->failed != 0u || unit == NULL) {
        return router != NULL && router->failed != 0u ? SWYP_ERR_CORRUPT : SWYP_ERR_NOT_FOUND;
    }
    contract = swyp_x86_apic_contract(unit);
    return contract == NULL || contract->ops == NULL || contract->ops->mask == NULL
               ? SWYP_ERR_CORRUPT
               : contract->ops->mask(contract->context, source_id);
}

static SwypStatus swyp_x86_apic_router_unmask(void *context, uint32_t source_id) {
    SwypX86ApicRouter *router = (SwypX86ApicRouter *)context;
    SwypX86Apic *unit = swyp_x86_apic_router_unit_for_source(router, source_id);
    SwypInterruptSource *contract;
    if (router == NULL || router->failed != 0u || unit == NULL) {
        return router != NULL && router->failed != 0u ? SWYP_ERR_CORRUPT : SWYP_ERR_NOT_FOUND;
    }
    contract = swyp_x86_apic_contract(unit);
    return contract == NULL || contract->ops == NULL || contract->ops->unmask == NULL
               ? SWYP_ERR_CORRUPT
               : contract->ops->unmask(contract->context, source_id);
}

static SwypStatus swyp_x86_apic_router_eoi(void *context, uint32_t source_id) {
    SwypX86ApicRouter *router = (SwypX86ApicRouter *)context;
    SwypX86Apic *unit = swyp_x86_apic_router_unit_for_source(router, source_id);
    SwypInterruptSource *contract;
    if (router == NULL || router->failed != 0u || unit == NULL) {
        return router != NULL && router->failed != 0u ? SWYP_ERR_CORRUPT : SWYP_ERR_NOT_FOUND;
    }
    contract = swyp_x86_apic_contract(unit);
    return contract == NULL || contract->ops == NULL || contract->ops->end_of_interrupt == NULL
               ? SWYP_ERR_CORRUPT
               : contract->ops->end_of_interrupt(contract->context, source_id);
}

static const SwypInterruptSourceOps swyp_x86_apic_router_ops = {
    .bind = swyp_x86_apic_router_bind,
    .unbind = swyp_x86_apic_router_unbind,
    .mask = swyp_x86_apic_router_mask,
    .unmask = swyp_x86_apic_router_unmask,
    .end_of_interrupt = swyp_x86_apic_router_eoi,
};

SwypStatus swyp_x86_apic_router_init(SwypX86ApicRouter *router, SwypX86Apic *const *units, uint32_t unit_count) {
    uint32_t i;
    uint32_t j;
    if (router == NULL || units == NULL || unit_count == 0u || unit_count > SWYP_X86_APIC_ROUTER_MAX_UNITS) {
        return SWYP_ERR_INVALID;
    }
    *router = (SwypX86ApicRouter){0};
    router->contract.context = router;
    router->contract.ops = &swyp_x86_apic_router_ops;
    router->unit_count = unit_count;
    for (i = 0u; i < unit_count; ++i) {
        uint64_t left_end;
        if (units[i] == NULL || swyp_x86_apic_contract(units[i]) == NULL || units[i]->redirection_count == 0u) {
            *router = (SwypX86ApicRouter){0};
            return SWYP_ERR_INVALID;
        }
        left_end = (uint64_t)units[i]->gsi_base + units[i]->redirection_count;
        for (j = 0u; j < i; ++j) {
            uint64_t right_end = (uint64_t)units[j]->gsi_base + units[j]->redirection_count;
            if ((uint64_t)units[i]->gsi_base < right_end && (uint64_t)units[j]->gsi_base < left_end) {
                *router = (SwypX86ApicRouter){0};
                return SWYP_ERR_CORRUPT;
            }
        }
        router->units[i] = units[i];
    }
    return SWYP_OK;
}

SwypInterruptSource *swyp_x86_apic_router_contract(SwypX86ApicRouter *router) {
    if (router == NULL || router->failed != 0u || router->unit_count == 0u || router->contract.ops == NULL) {
        return NULL;
    }
    return &router->contract;
}
