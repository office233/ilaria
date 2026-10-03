#ifndef SWYPIK_ARCH_X86_64_IRQ_H
#define SWYPIK_ARCH_X86_64_IRQ_H

#include "swypik/arch/x86_64/driver_runtime.h"
#include "swypik/arch/x86_64/privilege.h"
#include "swypik/arch/x86_64/trap.h"

#define SWYP_X86_IRQ_VECTOR_FIRST SWYP_X86_DRIVER_RUNTIME_IRQ_FIRST
#define SWYP_X86_IRQ_VECTOR_LAST SWYP_X86_DRIVER_RUNTIME_IRQ_LAST
#define SWYP_X86_IRQ_VECTOR_COUNT (SWYP_X86_IRQ_VECTOR_LAST - SWYP_X86_IRQ_VECTOR_FIRST + 1u)

typedef struct SwypX86IrqDispatcher {
    SwypX86DriverRuntimeManager *runtime;
    SwypInterruptSource *interrupts;
    uint32_t initialized;
    uint32_t reserved0;
} SwypX86IrqDispatcher;

void swyp_x86_irq_dispatcher_init(SwypX86IrqDispatcher *dispatcher, SwypX86DriverRuntimeManager *runtime,
                                  SwypInterruptSource *interrupts);
SwypStatus swyp_x86_irq_bind_dispatcher(SwypX86IrqDispatcher *dispatcher);
SwypStatus swyp_x86_irq_install_idt(SwypX86PrivilegeState *privilege);
SwypStatus swyp_x86_irq_next_pending(SwypX86IrqDispatcher *dispatcher, uint64_t domain_id, uint64_t lease_fence,
                                     uint32_t *vector, uint32_t *source_id);
SwypStatus swyp_x86_irq_complete(SwypX86IrqDispatcher *dispatcher, uint64_t domain_id, uint64_t lease_fence,
                                 uint32_t vector);
SwypStatus swyp_x86_irq_is_pending(SwypX86IrqDispatcher *dispatcher, uint64_t domain_id, uint64_t lease_fence,
                                   uint32_t vector);
void SWYP_X86_NATIVE_ABI swyp_x86_irq_dispatch(SwypX86TrapFrame *frame);

extern const uint64_t swyp_x86_irq_stub_table[SWYP_X86_IRQ_VECTOR_COUNT];

#endif
