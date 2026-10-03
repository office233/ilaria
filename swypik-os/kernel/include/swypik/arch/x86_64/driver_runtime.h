#ifndef SWYPIK_ARCH_X86_64_DRIVER_RUNTIME_H
#define SWYPIK_ARCH_X86_64_DRIVER_RUNTIME_H

#include "swypik/arch/x86_64/address_space.h"
#include "swypik/arch/x86_64/iommu.h"
#include "swypik/arch/x86_64/pci_ecam.h"
#include "swypik/kernel/device_platform.h"

#define SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY 16u
#define SWYP_X86_DRIVER_RUNTIME_VA_ALLOCATION_CAPACITY 64u
#define SWYP_X86_DRIVER_RUNTIME_VA_BASE UINT64_C(0x0000600000000000)
#define SWYP_X86_DRIVER_RUNTIME_VA_PAGES 4096u
#define SWYP_X86_DRIVER_RUNTIME_IRQ_FIRST 64u
#define SWYP_X86_DRIVER_RUNTIME_IRQ_LAST 223u
#define SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY (SWYP_X86_DRIVER_RUNTIME_IRQ_LAST - SWYP_X86_DRIVER_RUNTIME_IRQ_FIRST + 1u)

typedef struct SwypX86DriverVaAllocation {
    uint32_t active;
    uint32_t start_page;
    uint32_t page_count;
    uint32_t reserved0;
} SwypX86DriverVaAllocation;

typedef struct SwypX86DriverDomainRuntime {
    uint32_t active;
    uint32_t reserved0;
    uint64_t domain_id;
    uint64_t lease_fence;
    SwypX86AddressSpace address_space;
    uint64_t va_bitmap[SWYP_X86_DRIVER_RUNTIME_VA_PAGES / 64u];
    SwypX86DriverVaAllocation va_allocations[SWYP_X86_DRIVER_RUNTIME_VA_ALLOCATION_CAPACITY];
} SwypX86DriverDomainRuntime;

typedef struct SwypX86DriverIrqAllocation {
    uint32_t active;
    uint32_t source_id;
    uint32_t vector;
    uint32_t pending;
    uint64_t domain_id;
    uint64_t lease_fence;
} SwypX86DriverIrqAllocation;

typedef struct SwypX86DriverRuntimeManager {
    SwypPageAllocator *page_allocator;
    void *hardware_context;
    const SwypX86AddressSpaceHardwareOps *address_space_hardware_ops;
    uint64_t kernel_pml4_physical;
    SwypX86Iommu *iommu;
    SwypX86PciEcam *pci_ecam;
    SwypX86DriverDomainRuntime domains[SWYP_X86_DRIVER_RUNTIME_DOMAIN_CAPACITY];
    SwypX86DriverIrqAllocation irq_allocations[SWYP_X86_DRIVER_RUNTIME_IRQ_CAPACITY];
} SwypX86DriverRuntimeManager;

void swyp_x86_64_driver_runtime_init(SwypX86DriverRuntimeManager *manager, SwypPageAllocator *page_allocator,
                                     void *hardware_context,
                                     const SwypX86AddressSpaceHardwareOps *address_space_hardware_ops);
void swyp_x86_64_driver_runtime_set_iommu(SwypX86DriverRuntimeManager *manager, SwypX86Iommu *iommu);
void swyp_x86_64_driver_runtime_set_pci_ecam(SwypX86DriverRuntimeManager *manager, SwypX86PciEcam *pci_ecam);
SwypStatus swyp_x86_64_driver_runtime_set_kernel_root(SwypX86DriverRuntimeManager *manager,
                                                      uint64_t kernel_pml4_physical);
SwypStatus swyp_x86_64_driver_runtime_open_domain(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                  uint64_t lease_fence, SwypAddressSpace **out_address_space);
SwypStatus swyp_x86_64_driver_runtime_activate_domain(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                      uint64_t lease_fence);
SwypStatus swyp_x86_64_driver_runtime_close_domain(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                   uint64_t lease_fence);
SwypX86AddressSpace *swyp_x86_64_driver_runtime_x86_space(SwypX86DriverRuntimeManager *manager, uint64_t domain_id,
                                                         uint64_t lease_fence);
const SwypDevicePlatformRuntimeOps *swyp_x86_64_driver_runtime_platform_ops(void);

#endif
