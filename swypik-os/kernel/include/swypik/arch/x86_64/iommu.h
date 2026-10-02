#ifndef SWYPIK_ARCH_X86_64_IOMMU_H
#define SWYPIK_ARCH_X86_64_IOMMU_H

#include "swypik/kernel/capability.h"

#define SWYP_X86_IOMMU_MAPPING_CAPACITY 64u
#define SWYP_X86_IOMMU_DEVICE_CAPACITY 64u
#define SWYP_X86_IOMMU_PAGE_SIZE UINT64_C(4096)

typedef struct SwypX86IommuHardwareOps {
    SwypStatus (*attach_device)(void *context, uint64_t domain_id, uint64_t device_id, uint64_t requester_aux);
    SwypStatus (*detach_device)(void *context, uint64_t domain_id, uint64_t device_id);
    SwypStatus (*map_pages)(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                            uint64_t physical_address, uint64_t page_count, uint64_t access_rights);
    SwypStatus (*unmap_pages)(void *context, uint64_t domain_id, uint64_t device_id, uint64_t iova,
                              uint64_t page_count);
    SwypStatus (*invalidate_domain)(void *context, uint64_t domain_id);
} SwypX86IommuHardwareOps;

typedef struct SwypX86IommuDeviceBinding {
    uint32_t active;
    uint32_t reserved0;
    uint64_t domain_id;
    uint64_t lease_fence;
    uint64_t device_id;
    uint64_t requester_aux;
} SwypX86IommuDeviceBinding;

typedef struct SwypX86IommuMapping {
    uint32_t active;
    uint32_t hardware_mapped;
    uint64_t domain_id;
    uint64_t lease_fence;
    uint64_t device_id;
    uint64_t iova;
    uint64_t physical_address;
    uint64_t length;
    uint64_t access_rights;
} SwypX86IommuMapping;

typedef struct SwypX86Iommu {
    void *hardware_context;
    const SwypX86IommuHardwareOps *hardware_ops;
    uint32_t failed;
    uint32_t reserved0;
    SwypX86IommuDeviceBinding devices[SWYP_X86_IOMMU_DEVICE_CAPACITY];
    SwypX86IommuMapping mappings[SWYP_X86_IOMMU_MAPPING_CAPACITY];
} SwypX86Iommu;

void swyp_x86_iommu_init(SwypX86Iommu *iommu, void *hardware_context, const SwypX86IommuHardwareOps *hardware_ops);
SwypStatus swyp_x86_iommu_attach_device(SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence,
                                        uint64_t device_id, uint64_t requester_aux);
SwypStatus swyp_x86_iommu_detach_device(SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence,
                                        uint64_t device_id);
SwypStatus swyp_x86_iommu_map(SwypX86Iommu *iommu, const SwypCapabilityObject *dma_object,
                              const SwypCapabilityObject *memory_object, uint64_t physical_address,
                              uint64_t domain_id, uint64_t lease_fence, uint64_t length, uint64_t access_rights,
                              uint64_t *mapping_token, uint64_t *iova);
SwypStatus swyp_x86_iommu_unmap(SwypX86Iommu *iommu, uint64_t mapping_token);
int swyp_x86_iommu_domain_has_mappings(const SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence);
int swyp_x86_iommu_domain_has_devices(const SwypX86Iommu *iommu, uint64_t domain_id, uint64_t lease_fence);

#endif
