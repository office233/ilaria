#ifndef SWYPIK_ARCH_X86_64_TRAP_H
#define SWYPIK_ARCH_X86_64_TRAP_H

#include "swypik/arch/x86_64/privilege.h"

#define SWYP_X86_EXCEPTION_COUNT 32u

typedef struct SwypX86TrapFrame {
    uint64_t rax;
    uint64_t rcx;
    uint64_t rdx;
    uint64_t rbx;
    uint64_t rbp;
    uint64_t rsi;
    uint64_t rdi;
    uint64_t r8;
    uint64_t r9;
    uint64_t r10;
    uint64_t r11;
    uint64_t r12;
    uint64_t r13;
    uint64_t r14;
    uint64_t r15;
    uint64_t vector;
    uint64_t error_code;
    uint64_t rip;
    uint64_t cs;
    uint64_t rflags;
    /* RSP/SS follow in hardware memory only when CPL changed on entry. */
} SwypX86TrapFrame;

typedef SwypStatus (*SwypX86TrapHandler)(void *context, SwypX86TrapFrame *frame);

typedef struct SwypX86TrapDispatchTable {
    void *context;
    SwypX86TrapHandler handlers[SWYP_X86_EXCEPTION_COUNT];
    uint32_t initialized;
    uint32_t reserved0;
} SwypX86TrapDispatchTable;

typedef struct SwypX86FatalTrapRecord {
    uint64_t sequence;
    uint64_t vector;
    uint64_t error_code;
    uint64_t rip;
    uint64_t cs;
    uint64_t rflags;
    uint64_t user_rsp;
    uint64_t user_ss;
} SwypX86FatalTrapRecord;

_Static_assert(sizeof(SwypX86TrapFrame) == 20u * sizeof(uint64_t), "x86 trap frame layout changed");

void swyp_x86_trap_table_init(SwypX86TrapDispatchTable *table, void *context);
SwypStatus swyp_x86_trap_set_handler(SwypX86TrapDispatchTable *table, uint32_t vector, SwypX86TrapHandler handler);
SwypStatus swyp_x86_trap_install_exception_idt(SwypX86PrivilegeState *privilege, uint32_t emergency_ist_index);
int swyp_x86_trap_vector_has_error_code(uint32_t vector);
int swyp_x86_trap_from_user(const SwypX86TrapFrame *frame);
uint64_t swyp_x86_trap_user_rsp(const SwypX86TrapFrame *frame);
uint64_t swyp_x86_trap_user_ss(const SwypX86TrapFrame *frame);
SwypStatus swyp_x86_trap_bind_dispatch_table(SwypX86TrapDispatchTable *table);
SwypStatus swyp_x86_trap_record_fatal(void *context, SwypX86TrapFrame *frame);
void SWYP_X86_NATIVE_ABI swyp_x86_trap_dispatch(SwypX86TrapFrame *frame);

extern const uint64_t swyp_x86_exception_stub_table[SWYP_X86_EXCEPTION_COUNT];

#endif
