#ifndef SWYPIK_KERNEL_DEVICE_PLATFORM_H
#define SWYPIK_KERNEL_DEVICE_PLATFORM_H

#include "swypik/kernel/device_broker.h"

#define SWYP_DEVICE_PLATFORM_RECORD_CAPACITY 64u

typedef enum SwypDevicePlatformRecordKind {
    SWYP_DEVICE_PLATFORM_RECORD_INVALID = 0,
    SWYP_DEVICE_PLATFORM_RECORD_MMIO = 1,
    SWYP_DEVICE_PLATFORM_RECORD_IRQ = 2
} SwypDevicePlatformRecordKind;

typedef struct SwypDevicePlatformRecord {
    uint32_t active;
    SwypDevicePlatformRecordKind kind;
    uint64_t domain_id;
    uint64_t lease_fence;
    SwypAddressSpace *address_space;
    uint64_t virtual_base;
    uint64_t page_count;
    uint32_t irq_source;
    uint32_t irq_vector;
    uint32_t mmio_mapped;
    uint32_t irq_bound;
} SwypDevicePlatformRecord;

typedef struct SwypDevicePlatformRuntimeOps {
    SwypStatus (*address_space_for_domain)(void *context, uint64_t domain_id, uint64_t lease_fence,
                                           SwypAddressSpace **out_address_space);
    SwypStatus (*reserve_device_virtual)(void *context, uint64_t domain_id, uint64_t lease_fence,
                                         uint64_t page_count, uint32_t page_shift, uint64_t *virtual_base);
    SwypStatus (*release_device_virtual)(void *context, uint64_t domain_id, uint64_t lease_fence,
                                         uint64_t virtual_base, uint64_t page_count);
    SwypStatus (*allocate_irq_vector)(void *context, uint64_t domain_id, uint64_t lease_fence,
                                      uint32_t source_id, uint32_t *vector);
    SwypStatus (*release_irq_vector)(void *context, uint64_t domain_id, uint64_t lease_fence,
                                     uint32_t source_id, uint32_t vector);
    SwypStatus (*map_dma)(void *context, const SwypCapabilityObject *dma_object,
                          const SwypCapabilityObject *memory_object, uint64_t physical_address, uint64_t domain_id,
                          uint64_t lease_fence, uint64_t length, uint64_t access_rights, uint64_t *backend_token,
                          uint64_t *iova);
    SwypStatus (*unmap_dma)(void *context, uint64_t backend_token);
    SwypStatus (*config_read)(void *context, const SwypCapabilityObject *object, uint64_t absolute_offset,
                              uint32_t width_bytes, uint64_t *value);
    SwypStatus (*config_write)(void *context, const SwypCapabilityObject *object, uint64_t absolute_offset,
                               uint32_t width_bytes, uint64_t value);
    SwypStatus (*control_read)(void *context, const SwypCapabilityObject *object, uint64_t *value);
    SwypStatus (*control_write)(void *context, const SwypCapabilityObject *object, uint64_t value);
} SwypDevicePlatformRuntimeOps;

typedef struct SwypDevicePlatform {
    void *runtime_context;
    const SwypDevicePlatformRuntimeOps *runtime_ops;
    SwypInterruptSource *interrupts;
    uint32_t page_shift;
    SwypDevicePlatformRecord records[SWYP_DEVICE_PLATFORM_RECORD_CAPACITY];
} SwypDevicePlatform;

void swyp_device_platform_init(SwypDevicePlatform *platform, void *runtime_context,
                               const SwypDevicePlatformRuntimeOps *runtime_ops, SwypInterruptSource *interrupts,
                               uint32_t page_shift);
const SwypDeviceBrokerOps *swyp_device_platform_broker_ops(void);

#endif
