#include "swypik/arch/x86_64/irq.h"
#include "swypik/arch/x86_64/syscall.h"

static SwypX86IrqDispatcher *swyp_x86_active_irq_dispatcher;

static SwypX86DriverIrqAllocation *swyp_x86_irq_find(SwypX86IrqDispatcher *dispatcher, uint32_t vector) {
    uint32_t i;
    if (dispatcher == NULL || dispatcher->runtime == NULL) {
        return NULL;
    }
    for (i = 0u; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        SwypX86DriverIrqAllocation *allocation = &dispatcher->runtime->irq_allocations[i];
        if (allocation->active != 0u && allocation->vector == vector) {
            return allocation;
        }
    }
    return NULL;
}

void swyp_x86_irq_dispatcher_init(SwypX86IrqDispatcher *dispatcher, SwypX86DriverRuntimeManager *runtime,
                                  SwypInterruptSource *interrupts) {
    if (dispatcher == NULL) {
        return;
    }
    dispatcher->runtime = runtime;
    dispatcher->interrupts = interrupts;
    dispatcher->initialized = runtime != NULL && interrupts != NULL && interrupts->ops != NULL &&
                                      interrupts->ops->mask != NULL && interrupts->ops->unmask != NULL &&
                                      interrupts->ops->end_of_interrupt != NULL
                                  ? 1u
                                  : 0u;
    dispatcher->reserved0 = 0u;
}

SwypStatus swyp_x86_irq_bind_dispatcher(SwypX86IrqDispatcher *dispatcher) {
    if (dispatcher == NULL || dispatcher->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_active_irq_dispatcher = dispatcher;
    return SWYP_OK;
}

SwypStatus swyp_x86_irq_install_idt(SwypX86PrivilegeState *privilege) {
    uint32_t vector;
    if (privilege == NULL || privilege->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    for (vector = SWYP_X86_IRQ_VECTOR_FIRST; vector <= SWYP_X86_IRQ_VECTOR_LAST; ++vector) {
        uint64_t handler;
        if (vector == SWYP_X86_SYSCALL_VECTOR) {
            continue;
        }
        handler = swyp_x86_irq_stub_table[vector - SWYP_X86_IRQ_VECTOR_FIRST];
        if (handler == 0u || swyp_x86_privilege_set_idt_gate(privilege, vector, handler, 0u, 0u,
                                                             SWYP_X86_IDT_GATE_INTERRUPT) != SWYP_OK) {
            return SWYP_ERR_CORRUPT;
        }
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_irq_next_pending(SwypX86IrqDispatcher *dispatcher, uint64_t domain_id, uint64_t lease_fence,
                                     uint32_t *vector, uint32_t *source_id) {
    uint32_t i;
    if (dispatcher == NULL || dispatcher->initialized == 0u || vector == NULL || source_id == NULL ||
        domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    *vector = 0u;
    *source_id = 0u;
    for (i = 0u; i < SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY; ++i) {
        const SwypX86DriverIrqAllocation *allocation = &dispatcher->runtime->irq_allocations[i];
        if (allocation->active != 0u && allocation->pending != 0u && allocation->domain_id == domain_id &&
            allocation->lease_fence == lease_fence) {
            *vector = allocation->vector;
            *source_id = allocation->source_id;
            return SWYP_OK;
        }
    }
    return SWYP_ERR_NOT_FOUND;
}

SwypStatus swyp_x86_irq_complete(SwypX86IrqDispatcher *dispatcher, uint64_t domain_id, uint64_t lease_fence,
                                 uint32_t vector) {
    SwypX86DriverIrqAllocation *allocation;
    if (dispatcher == NULL || dispatcher->initialized == 0u || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    allocation = swyp_x86_irq_find(dispatcher, vector);
    if (allocation == NULL || allocation->domain_id != domain_id || allocation->lease_fence != lease_fence ||
        allocation->pending == 0u) {
        return SWYP_ERR_DENIED;
    }
    allocation->pending = 0u;
    return SWYP_OK;
}

SwypStatus swyp_x86_irq_is_pending(SwypX86IrqDispatcher *dispatcher, uint64_t domain_id, uint64_t lease_fence,
                                   uint32_t vector) {
    SwypX86DriverIrqAllocation *allocation;
    if (dispatcher == NULL || dispatcher->initialized == 0u || domain_id == 0u || lease_fence == 0u) {
        return SWYP_ERR_INVALID;
    }
    allocation = swyp_x86_irq_find(dispatcher, vector);
    if (allocation == NULL || allocation->domain_id != domain_id || allocation->lease_fence != lease_fence ||
        allocation->pending == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    return SWYP_OK;
}

void SWYP_X86_NATIVE_ABI swyp_x86_irq_dispatch(SwypX86TrapFrame *frame) {
    SwypX86IrqDispatcher *dispatcher = swyp_x86_active_irq_dispatcher;
    SwypX86DriverIrqAllocation *allocation;
    SwypStatus status;
    if (frame == NULL || dispatcher == NULL || dispatcher->initialized == 0u ||
        frame->vector < SWYP_X86_IRQ_VECTOR_FIRST || frame->vector > SWYP_X86_IRQ_VECTOR_LAST ||
        frame->vector == SWYP_X86_SYSCALL_VECTOR || frame->error_code != 0u) {
        swyp_x86_emergency_halt_stub();
    }
    allocation = swyp_x86_irq_find(dispatcher, (uint32_t)frame->vector);
    if (allocation == NULL) {
        swyp_x86_emergency_halt_stub();
    }
    if (allocation->pending == 0u) {
        status = dispatcher->interrupts->ops->mask(dispatcher->interrupts->context, allocation->source_id);
        if (status != SWYP_OK) {
            swyp_x86_emergency_halt_stub();
        }
        allocation->pending = 1u;
    }
    /* EOI is deliberately deferred to the capability-gated ACK syscall. The
       source is masked first, so level-triggered devices cannot storm user mode. */
}
