#ifndef SWYPIK_ARCH_X86_64_CONTEXT_H
#define SWYPIK_ARCH_X86_64_CONTEXT_H

#include "swypik/kernel/contracts.h"

typedef struct SwypX86_64ThreadContext {
    uint64_t rax;
    uint64_t rbx;
    uint64_t rcx;
    uint64_t rdx;
    uint64_t rsi;
    uint64_t rdi;
    uint64_t rbp;
    uint64_t rsp;
    uint64_t r8;
    uint64_t r9;
    uint64_t r10;
    uint64_t r11;
    uint64_t r12;
    uint64_t r13;
    uint64_t r14;
    uint64_t r15;
    uint64_t rip;
    uint64_t rflags;
    uint64_t fs_base;
    uint64_t gs_base;
} SwypX86_64ThreadContext;

_Static_assert(sizeof(SwypX86_64ThreadContext) <= SWYP_THREAD_CONTEXT_STORAGE_BYTES,
               "x86_64 thread context exceeds portable storage");

#endif
