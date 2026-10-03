#ifndef SWYPIK_ARCH_X86_64_CONTINUATION_H
#define SWYPIK_ARCH_X86_64_CONTINUATION_H

#include "swypik/arch/x86_64/privilege.h"

typedef struct SwypX86KernelContinuation {
    uint64_t rbx;
    uint64_t rbp;
    uint64_t rdi;
    uint64_t rsi;
    uint64_t r12;
    uint64_t r13;
    uint64_t r14;
    uint64_t r15;
    uint64_t rsp;
    uint64_t rip;
} SwypX86KernelContinuation;

int64_t SWYP_X86_NATIVE_ABI swyp_x86_kernel_continuation_capture(SwypX86KernelContinuation *continuation)
    __attribute__((returns_twice));
void SWYP_X86_NATIVE_ABI swyp_x86_kernel_continuation_resume(const SwypX86KernelContinuation *continuation,
                                                              int64_t value) __attribute__((noreturn));

#endif
