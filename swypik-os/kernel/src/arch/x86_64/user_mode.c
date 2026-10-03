#include "swypik/arch/x86_64/user_mode.h"

#include <stddef.h>

_Static_assert(sizeof(SwypX86_64ThreadContext) == 160u, "user entry assembly context size changed");
_Static_assert(offsetof(SwypX86_64ThreadContext, rsp) == 56u, "user entry RSP offset changed");
_Static_assert(offsetof(SwypX86_64ThreadContext, r10) == 80u, "user entry R10 offset changed");
_Static_assert(offsetof(SwypX86_64ThreadContext, rip) == 128u, "user entry RIP offset changed");
_Static_assert(offsetof(SwypX86_64ThreadContext, rflags) == 136u, "user entry RFLAGS offset changed");
_Static_assert(offsetof(SwypX86UserLaunch, code_selector) == 160u, "user entry CS offset changed");
_Static_assert(offsetof(SwypX86UserLaunch, data_selector) == 162u, "user entry SS offset changed");

static int swyp_x86_user_address_valid(uint64_t address) {
    return address != 0u && address <= SWYP_X86_64_USER_CANONICAL_MAX;
}

static uint64_t swyp_x86_user_sanitize_rflags(uint64_t flags, int interrupts_enabled) {
    const uint64_t forbidden = SWYP_X86_RFLAGS_IOPL_MASK | SWYP_X86_RFLAGS_NT | SWYP_X86_RFLAGS_RF |
                               SWYP_X86_RFLAGS_VM | SWYP_X86_RFLAGS_AC | SWYP_X86_RFLAGS_VIF | SWYP_X86_RFLAGS_VIP;
    flags &= ~forbidden;
    flags |= SWYP_X86_RFLAGS_FIXED;
    if (interrupts_enabled) {
        flags |= SWYP_X86_RFLAGS_IF;
    } else {
        flags &= ~SWYP_X86_RFLAGS_IF;
    }
    return flags;
}

static SwypStatus swyp_x86_user_launch_check(const SwypX86UserLaunch *launch, int initial) {
    if (launch == NULL || launch->code_selector != SWYP_X86_SELECTOR_USER_CODE ||
        launch->data_selector != SWYP_X86_SELECTOR_USER_DATA ||
        !swyp_x86_user_address_valid(launch->context.rip) || !swyp_x86_user_address_valid(launch->context.rsp) ||
        (initial && (launch->context.rsp & UINT64_C(0xf)) != 0u) ||
        (launch->context.rflags & SWYP_X86_RFLAGS_FIXED) == 0u ||
        (launch->context.rflags & (SWYP_X86_RFLAGS_IOPL_MASK | SWYP_X86_RFLAGS_NT | SWYP_X86_RFLAGS_RF |
                                   SWYP_X86_RFLAGS_VM | SWYP_X86_RFLAGS_AC | SWYP_X86_RFLAGS_VIF |
                                   SWYP_X86_RFLAGS_VIP)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_user_launch_validate(const SwypX86UserLaunch *launch) {
    return swyp_x86_user_launch_check(launch, 1);
}

static SwypStatus swyp_x86_user_prepare(const SwypThreadContext *thread_context, int interrupts_enabled,
                                        SwypX86UserLaunch *launch, int initial);

SwypStatus swyp_x86_user_launch_prepare(const SwypThreadContext *thread_context, SwypX86UserLaunch *launch) {
    return swyp_x86_user_launch_prepare_interruptible(thread_context, 0, launch);
}

SwypStatus swyp_x86_user_launch_prepare_interruptible(const SwypThreadContext *thread_context,
                                                      int interrupts_enabled, SwypX86UserLaunch *launch) {
    return swyp_x86_user_prepare(thread_context, interrupts_enabled, launch, 1);
}

SwypStatus swyp_x86_user_resume_prepare(const SwypThreadContext *thread_context, int interrupts_enabled,
                                        SwypX86UserLaunch *launch) {
    return swyp_x86_user_prepare(thread_context, interrupts_enabled, launch, 0);
}

static SwypStatus swyp_x86_user_prepare(const SwypThreadContext *thread_context, int interrupts_enabled,
                                        SwypX86UserLaunch *launch, int initial) {
    const SwypX86_64ThreadContext *context;
    if (thread_context == NULL || launch == NULL || thread_context->abi_version != SWYP_KERNEL_ABI_VERSION ||
        thread_context->struct_size != sizeof(*thread_context) || thread_context->arch != SWYP_ARCH_X86_64 ||
        thread_context->used_bytes != sizeof(SwypX86_64ThreadContext) ||
        (!initial && (thread_context->flags & SWYP_X86_CONTEXT_CAPTURED_USER) == 0u)) {
        return SWYP_ERR_INVALID;
    }
    context = (const SwypX86_64ThreadContext *)(const void *)thread_context->storage;
    launch->context = *context;
    launch->context.rflags = swyp_x86_user_sanitize_rflags(context->rflags, interrupts_enabled != 0);
    launch->code_selector = SWYP_X86_SELECTOR_USER_CODE;
    launch->data_selector = SWYP_X86_SELECTOR_USER_DATA;
    launch->reserved0 = 0u;
    return swyp_x86_user_launch_check(launch, initial);
}

static SwypStatus swyp_x86_user_context_capture(SwypThreadContext *thread_context, const SwypX86TrapFrame *frame,
                                                int resumable) {
    SwypX86_64ThreadContext *context;
    uint64_t user_rsp;
    uint64_t user_ss;
    if (thread_context == NULL || frame == NULL || thread_context->abi_version != SWYP_KERNEL_ABI_VERSION ||
        thread_context->struct_size != sizeof(*thread_context) || thread_context->arch != SWYP_ARCH_X86_64 ||
        thread_context->used_bytes != sizeof(SwypX86_64ThreadContext) || !swyp_x86_trap_from_user(frame) ||
        frame->cs != SWYP_X86_SELECTOR_USER_CODE) {
        return SWYP_ERR_INVALID;
    }
    user_rsp = swyp_x86_trap_user_rsp(frame);
    user_ss = swyp_x86_trap_user_ss(frame);
    if (user_ss != SWYP_X86_SELECTOR_USER_DATA ||
        (resumable && (!swyp_x86_user_address_valid(frame->rip) ||
                       !swyp_x86_user_address_valid(user_rsp)))) {
        return SWYP_ERR_DENIED;
    }
    context = (SwypX86_64ThreadContext *)(void *)thread_context->storage;
    context->rax = frame->rax;
    context->rbx = frame->rbx;
    context->rcx = frame->rcx;
    context->rdx = frame->rdx;
    context->rsi = frame->rsi;
    context->rdi = frame->rdi;
    context->rbp = frame->rbp;
    context->rsp = user_rsp;
    context->r8 = frame->r8;
    context->r9 = frame->r9;
    context->r10 = frame->r10;
    context->r11 = frame->r11;
    context->r12 = frame->r12;
    context->r13 = frame->r13;
    context->r14 = frame->r14;
    context->r15 = frame->r15;
    context->rip = frame->rip;
    context->rflags = swyp_x86_user_sanitize_rflags(frame->rflags, (frame->rflags & SWYP_X86_RFLAGS_IF) != 0u);
    if (resumable) {
        thread_context->flags |= SWYP_X86_CONTEXT_CAPTURED_USER;
    } else {
        thread_context->flags &= ~SWYP_X86_CONTEXT_CAPTURED_USER;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_user_context_capture_trap(SwypThreadContext *thread_context, const SwypX86TrapFrame *frame) {
    return swyp_x86_user_context_capture(thread_context, frame, 1);
}

SwypStatus swyp_x86_user_context_capture_fault(SwypThreadContext *thread_context, const SwypX86TrapFrame *frame) {
    /* A terminal snapshot must accept the bad RIP/RSP that caused the fault.
       It is never a launch context: the entire admitted epoch is stopped. */
    return swyp_x86_user_context_capture(thread_context, frame, 0);
}
