#include "swypik/arch/x86_64/syscall.h"

#include <stddef.h>

_Static_assert(offsetof(SwypX86TrapFrame, rax) == 0u, "syscall frame RAX offset changed");
_Static_assert(offsetof(SwypX86TrapFrame, r10) == 72u, "syscall frame R10 offset changed");
_Static_assert(offsetof(SwypX86TrapFrame, vector) == 120u, "syscall frame vector offset changed");
_Static_assert(offsetof(SwypX86TrapFrame, rip) == 136u, "syscall frame RIP offset changed");

static SwypX86SyscallDispatcher *swyp_x86_active_syscall_dispatcher;

void swyp_x86_syscall_dispatcher_init(SwypX86SyscallDispatcher *dispatcher, void *context,
                                      SwypX86SyscallHandler handler) {
    if (dispatcher == NULL) {
        return;
    }
    dispatcher->context = context;
    dispatcher->handler = handler;
    dispatcher->initialized = handler != NULL ? 1u : 0u;
    dispatcher->reserved0 = 0u;
}

SwypStatus swyp_x86_syscall_bind_dispatcher(SwypX86SyscallDispatcher *dispatcher) {
    if (dispatcher == NULL || dispatcher->initialized == 0u || dispatcher->handler == NULL) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_active_syscall_dispatcher = dispatcher;
    return SWYP_OK;
}

SwypStatus swyp_x86_syscall_install_idt(SwypX86PrivilegeState *privilege) {
    if (privilege == NULL || privilege->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    return swyp_x86_privilege_set_idt_gate(privilege, SWYP_X86_SYSCALL_VECTOR,
                                           (uint64_t)(uintptr_t)&swyp_x86_syscall_entry, 0u, 3u,
                                           SWYP_X86_IDT_GATE_INTERRUPT);
}

void SWYP_X86_NATIVE_ABI swyp_x86_syscall_dispatch(SwypX86TrapFrame *frame) {
    SwypX86SyscallDispatcher *dispatcher = swyp_x86_active_syscall_dispatcher;
    uint64_t args[6];
    uint64_t result = 0u;
    SwypStatus status;
    if (frame == NULL || frame->vector != SWYP_X86_SYSCALL_VECTOR || frame->error_code != 0u ||
        !swyp_x86_trap_from_user(frame) || frame->cs != SWYP_X86_SELECTOR_USER_CODE ||
        swyp_x86_trap_user_ss(frame) != SWYP_X86_SELECTOR_USER_DATA || dispatcher == NULL ||
        dispatcher->initialized == 0u || dispatcher->handler == NULL) {
        if (frame != NULL) {
            frame->rax = (uint64_t)(int64_t)SWYP_ERR_DENIED;
        }
        return;
    }
    args[0] = frame->rdi;
    args[1] = frame->rsi;
    args[2] = frame->rdx;
    args[3] = frame->r10;
    args[4] = frame->r8;
    args[5] = frame->r9;
    status = dispatcher->handler(dispatcher->context, frame->rax, args, frame, &result);
    frame->rax = status == SWYP_OK ? result : (uint64_t)(int64_t)status;
}
