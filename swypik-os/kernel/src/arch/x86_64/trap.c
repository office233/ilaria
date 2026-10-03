#include "swypik/arch/x86_64/trap.h"

#include <stddef.h>

static SwypX86TrapDispatchTable *swyp_x86_active_trap_table;

void swyp_x86_trap_table_init(SwypX86TrapDispatchTable *table, void *context) {
    uint32_t i;
    if (table == NULL) {
        return;
    }
    table->context = context;
    for (i = 0u; i < SWYP_X86_EXCEPTION_COUNT; ++i) {
        table->handlers[i] = NULL;
    }
    table->initialized = 1u;
    table->reserved0 = 0u;
}

SwypStatus swyp_x86_trap_set_handler(SwypX86TrapDispatchTable *table, uint32_t vector, SwypX86TrapHandler handler) {
    if (table == NULL || table->initialized == 0u || vector >= SWYP_X86_EXCEPTION_COUNT || handler == NULL) {
        return SWYP_ERR_INVALID;
    }
    table->handlers[vector] = handler;
    return SWYP_OK;
}

int swyp_x86_trap_vector_has_error_code(uint32_t vector) {
    switch (vector) {
    case 8u:  /* #DF */
    case 10u: /* #TS */
    case 11u: /* #NP */
    case 12u: /* #SS */
    case 13u: /* #GP */
    case 14u: /* #PF */
    case 17u: /* #AC */
    case 21u: /* #CP */
    case 29u: /* #VC */
    case 30u: /* #SX */
        return 1;
    default:
        return 0;
    }
}

int swyp_x86_trap_from_user(const SwypX86TrapFrame *frame) {
    return frame != NULL && (frame->cs & UINT64_C(0x3)) == UINT64_C(0x3);
}

int swyp_x86_trap_is_task_exception(uint64_t vector) {
    switch (vector) {
    case 0u: case 1u: case 3u: case 4u: case 5u: case 6u:
    case 10u: case 11u: case 12u: case 13u: case 14u:
    case 16u: case 17u: case 19u: case 21u:
        return 1;
    default:
        /* NMI, double fault, machine check and system/reserved exceptions
           are not evidence of a confined task fault, even with user CS. */
        return 0;
    }
}

uint64_t swyp_x86_trap_fault_address(const SwypX86TrapFrame *frame) {
    uint64_t address = 0u;
    if (frame != NULL && frame->vector == 14u) {
        __asm__ volatile("mov %%cr2, %0" : "=r"(address));
    }
    return address;
}

uint64_t swyp_x86_trap_user_rsp(const SwypX86TrapFrame *frame) {
    const uint64_t *hardware_tail;
    if (!swyp_x86_trap_from_user(frame)) {
        return 0u;
    }
    hardware_tail = (const uint64_t *)(const void *)(frame + 1);
    return hardware_tail[0];
}

uint64_t swyp_x86_trap_user_ss(const SwypX86TrapFrame *frame) {
    const uint64_t *hardware_tail;
    if (!swyp_x86_trap_from_user(frame)) {
        return 0u;
    }
    hardware_tail = (const uint64_t *)(const void *)(frame + 1);
    return hardware_tail[1];
}

SwypStatus swyp_x86_trap_install_exception_idt(SwypX86PrivilegeState *privilege, uint32_t emergency_ist_index) {
    uint32_t vector;
    if (privilege == NULL || privilege->initialized == 0u || emergency_ist_index == 0u || emergency_ist_index > 7u) {
        return SWYP_ERR_INVALID;
    }
    for (vector = 0u; vector < SWYP_X86_EXCEPTION_COUNT; ++vector) {
        uint32_t ist = (vector == 2u || vector == 8u || vector == 18u) ? emergency_ist_index : 0u;
        uint32_t dpl = (vector == 3u || vector == 4u) ? 3u : 0u;
        SwypX86IdtGateType type = (vector == 3u || vector == 4u) ? SWYP_X86_IDT_GATE_TRAP
                                                                : SWYP_X86_IDT_GATE_INTERRUPT;
        SwypStatus status = swyp_x86_privilege_set_idt_gate(privilege, vector,
                                                            swyp_x86_exception_stub_table[vector], ist, dpl, type);
        if (status != SWYP_OK) {
            return status;
        }
    }
    return swyp_x86_privilege_validate(privilege);
}

SwypStatus swyp_x86_trap_bind_dispatch_table(SwypX86TrapDispatchTable *table) {
    if (table == NULL || table->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_active_trap_table = table;
    return SWYP_OK;
}

SwypStatus swyp_x86_trap_record_fatal(void *context, SwypX86TrapFrame *frame) {
    SwypX86FatalTrapRecord *record = (SwypX86FatalTrapRecord *)context;
    if (record == NULL || frame == NULL || frame->vector >= SWYP_X86_EXCEPTION_COUNT) {
        return SWYP_ERR_INVALID;
    }
    record->sequence += 1u;
    record->vector = frame->vector;
    record->error_code = frame->error_code;
    record->rip = frame->rip;
    record->cs = frame->cs;
    record->rflags = frame->rflags;
    record->user_rsp = swyp_x86_trap_user_rsp(frame);
    record->user_ss = swyp_x86_trap_user_ss(frame);
    return SWYP_ERR_CORRUPT;
}

void SWYP_X86_NATIVE_ABI swyp_x86_trap_dispatch(SwypX86TrapFrame *frame) {
    SwypX86TrapDispatchTable *table = swyp_x86_active_trap_table;
    SwypStatus status;
    if (frame == NULL || frame->vector >= SWYP_X86_EXCEPTION_COUNT || table == NULL || table->initialized == 0u ||
        table->handlers[frame->vector] == NULL) {
        swyp_x86_emergency_halt_stub();
    }
    status = table->handlers[frame->vector](table->context, frame);
    if (status != SWYP_OK) {
        swyp_x86_emergency_halt_stub();
    }
}
