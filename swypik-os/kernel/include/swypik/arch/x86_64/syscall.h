#ifndef SWYPIK_ARCH_X86_64_SYSCALL_H
#define SWYPIK_ARCH_X86_64_SYSCALL_H

#include "swypik/arch/x86_64/trap.h"

#define SWYP_X86_SYSCALL_VECTOR 0x80u

typedef enum SwypX86SyscallNumber {
    SWYP_X86_SYSCALL_ABI_VERSION = 0,
    SWYP_X86_SYSCALL_THREAD_ID = 1,
    SWYP_X86_SYSCALL_DOMAIN_ID = 2,
    SWYP_X86_SYSCALL_LEASE_FENCE = 3,
    SWYP_X86_SYSCALL_YIELD = 4,
    SWYP_X86_SYSCALL_EXIT = 5,
    SWYP_X86_SYSCALL_IRQ_NEXT = 6,
    SWYP_X86_SYSCALL_IRQ_ACK = 7
} SwypX86SyscallNumber;

typedef SwypStatus (*SwypX86SyscallHandler)(void *context, uint64_t number, const uint64_t args[6],
                                            SwypX86TrapFrame *frame, uint64_t *result);

typedef struct SwypX86SyscallDispatcher {
    void *context;
    SwypX86SyscallHandler handler;
    uint32_t initialized;
    uint32_t reserved0;
} SwypX86SyscallDispatcher;

void swyp_x86_syscall_dispatcher_init(SwypX86SyscallDispatcher *dispatcher, void *context,
                                      SwypX86SyscallHandler handler);
SwypStatus swyp_x86_syscall_bind_dispatcher(SwypX86SyscallDispatcher *dispatcher);
SwypStatus swyp_x86_syscall_install_idt(SwypX86PrivilegeState *privilege);
void SWYP_X86_NATIVE_ABI swyp_x86_syscall_dispatch(SwypX86TrapFrame *frame);
void swyp_x86_syscall_entry(void);

#endif
