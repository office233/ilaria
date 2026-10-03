#ifndef SWYPIK_ARCH_ARM64_CONTEXT_H
#define SWYPIK_ARCH_ARM64_CONTEXT_H

#include "swypik/kernel/contracts.h"

typedef struct SwypArm64ThreadContext {
    uint64_t x[31];
    uint64_t sp;
    uint64_t pc;
    uint64_t pstate;
} SwypArm64ThreadContext;

_Static_assert(sizeof(SwypArm64ThreadContext) <= SWYP_THREAD_CONTEXT_STORAGE_BYTES,
               "arm64 thread context exceeds portable storage");

#endif
