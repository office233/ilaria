#ifndef SWYPIK_KERNEL_DEVICE_BROKER_H
#define SWYPIK_KERNEL_DEVICE_BROKER_H

#include "swypik/kernel/contracts.h"
#include "swypik/kernel/driver_domain.h"

#define SWYP_DEVICE_BROKER_RECORD_CAPACITY 64u

typedef uint64_t SwypDeviceBrokerHandle;

typedef enum SwypDeviceBrokerRecordKind {
    SWYP_DEVICE_BROKER_RECORD_INVALID = 0,
    SWYP_DEVICE_BROKER_RECORD_MMIO = 1,
    SWYP_DEVICE_BROKER_RECORD_IRQ = 2,
    SWYP_DEVICE_BROKER_RECORD_DMA = 3
} SwypDeviceBrokerRecordKind;

enum {
    SWYP_DEVICE_BROKER_SLOT_FREE = 0u,
    SWYP_DEVICE_BROKER_SLOT_ACTIVE = 1u,
    SWYP_DEVICE_BROKER_SLOT_RETIRED = 2u
};

typedef struct SwypDeviceBrokerRecord {
    uint32_t generation;
    uint32_t active;
    SwypDeviceBrokerRecordKind kind;
    uint32_t reserved0;
    uint64_t domain_id;
    uint64_t lease_fence;
    SwypCapabilityHandle capability;
    SwypCapabilityHandle secondary_capability;
    uint64_t operation_rights;
    uint64_t backend_token;
} SwypDeviceBrokerRecord;

typedef struct SwypDeviceMapping {
    SwypDeviceBrokerHandle handle;
    uint64_t address;
    uint64_t length;
} SwypDeviceMapping;

typedef struct SwypDeviceIrqBinding {
    SwypDeviceBrokerHandle handle;
    uint32_t vector;
    uint32_t reserved0;
} SwypDeviceIrqBinding;

typedef struct SwypDeviceBrokerOps {
    SwypStatus (*map_mmio)(void *context, const SwypCapabilityObject *object, uint64_t domain_id, uint64_t lease_fence,
                           uint64_t offset, uint64_t length, uint64_t mmu_flags, uint64_t *backend_token,
                           uint64_t *virtual_address);
    SwypStatus (*unmap_mmio)(void *context, uint64_t backend_token);
    SwypStatus (*bind_irq)(void *context, const SwypCapabilityObject *object, uint64_t domain_id, uint64_t lease_fence,
                           uint64_t *backend_token, uint32_t *vector);
    SwypStatus (*ack_irq)(void *context, uint64_t backend_token);
    SwypStatus (*unbind_irq)(void *context, uint64_t backend_token);
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
} SwypDeviceBrokerOps;

typedef struct SwypDeviceBroker {
    SwypDriverDomainManager *domains;
    void *backend_context;
    const SwypDeviceBrokerOps *ops;
    SwypDeviceBrokerRecord records[SWYP_DEVICE_BROKER_RECORD_CAPACITY];
} SwypDeviceBroker;

void swyp_device_broker_init(SwypDeviceBroker *broker, SwypDriverDomainManager *domains, void *backend_context,
                             const SwypDeviceBrokerOps *ops);
SwypStatus swyp_device_broker_map_mmio(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                       SwypCapabilityHandle capability, uint64_t offset, uint64_t length,
                                       uint64_t access_rights, SwypDeviceMapping *out_mapping);
SwypStatus swyp_device_broker_unmap_mmio(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                         SwypDeviceBrokerHandle mapping_handle);
SwypStatus swyp_device_broker_bind_irq(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                       SwypCapabilityHandle capability, SwypDeviceIrqBinding *out_binding);
SwypStatus swyp_device_broker_ack_irq(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                      SwypDeviceBrokerHandle binding_handle);
SwypStatus swyp_device_broker_unbind_irq(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                         SwypDeviceBrokerHandle binding_handle);
SwypStatus swyp_device_broker_irq_backend_token(const SwypDeviceBroker *broker, uint64_t domain_id,
                                                uint64_t lease_fence, SwypDeviceBrokerHandle binding_handle,
                                                uint64_t *backend_token);
SwypStatus swyp_device_broker_irq_handle_for_backend(const SwypDeviceBroker *broker, uint64_t domain_id,
                                                     uint64_t lease_fence, uint64_t backend_token,
                                                     SwypDeviceBrokerHandle *binding_handle);
SwypStatus swyp_device_broker_map_dma(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                      SwypCapabilityHandle dma_capability, SwypCapabilityHandle memory_capability,
                                      uint64_t memory_offset, uint64_t length, uint64_t access_rights,
                                      SwypDeviceMapping *out_mapping);
SwypStatus swyp_device_broker_unmap_dma(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                        SwypDeviceBrokerHandle mapping_handle);
SwypStatus swyp_device_broker_config_read(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                          SwypCapabilityHandle capability, uint64_t offset, uint32_t width_bytes,
                                          uint64_t *value);
SwypStatus swyp_device_broker_config_write(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                           SwypCapabilityHandle capability, uint64_t offset, uint32_t width_bytes,
                                           uint64_t value);
SwypStatus swyp_device_broker_control_read(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                           SwypCapabilityHandle capability, uint64_t *value);
SwypStatus swyp_device_broker_control_write(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence,
                                            SwypCapabilityHandle capability, uint64_t value);
SwypStatus swyp_device_broker_revoke_domain(SwypDeviceBroker *broker, uint64_t domain_id, uint64_t lease_fence);

#endif
