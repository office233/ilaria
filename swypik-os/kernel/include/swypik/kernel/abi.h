#ifndef SWYPIK_KERNEL_ABI_H
#define SWYPIK_KERNEL_ABI_H

#include <stddef.h>
#include <stdint.h>

#define SWYP_KERNEL_ABI_VERSION 1u
#define SWYP_DEVICE_GRAPH_WIRE_VERSION 1u

typedef enum SwypStatus {
    SWYP_OK = 0,
    SWYP_ERR_INVALID = -1,
    SWYP_ERR_NO_SPACE = -2,
    SWYP_ERR_NOT_FOUND = -3,
    SWYP_ERR_DENIED = -4,
    SWYP_ERR_STALE = -5,
    SWYP_ERR_CORRUPT = -6,
    SWYP_ERR_UNSUPPORTED = -7,
    SWYP_ERR_FAULT = -8
} SwypStatus;

typedef enum SwypArch {
    SWYP_ARCH_UNKNOWN = 0,
    SWYP_ARCH_X86_64 = 1,
    SWYP_ARCH_ARM64 = 2,
    SWYP_ARCH_RISCV64 = 3
} SwypArch;

typedef enum SwypEndianness {
    SWYP_ENDIAN_UNKNOWN = 0,
    SWYP_ENDIAN_LITTLE = 1,
    SWYP_ENDIAN_BIG = 2
} SwypEndianness;

#endif
