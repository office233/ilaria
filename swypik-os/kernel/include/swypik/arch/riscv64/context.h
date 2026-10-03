#ifndef SWYPIK_ARCH_RISCV64_CONTEXT_H
#define SWYPIK_ARCH_RISCV64_CONTEXT_H

#include "swypik/kernel/contracts.h"

typedef struct SwypRiscv64ThreadContext {
    uint64_t x[32];
    uint64_t pc;
    uint64_t sstatus;
} SwypRiscv64ThreadContext;

_Static_assert(sizeof(SwypRiscv64ThreadContext) <= SWYP_THREAD_CONTEXT_STORAGE_BYTES,
               "riscv64 thread context exceeds portable storage");

#endif
