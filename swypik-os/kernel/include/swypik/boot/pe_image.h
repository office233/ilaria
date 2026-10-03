#ifndef SWYPIK_BOOT_PE_IMAGE_H
#define SWYPIK_BOOT_PE_IMAGE_H

#include "swypik/kernel/kernel_takeover.h"

#define SWYP_PE_MAX_IDENTITY_RANGES SWYP_KERNEL_TAKEOVER_MAX_IDENTITY_RANGES

SwypStatus swyp_pe_collect_identity_ranges(const void *image_base, uint64_t image_size,
                                           SwypKernelIdentityRange *ranges, uint32_t range_capacity,
                                           uint32_t *range_count);

#endif
