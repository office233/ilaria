#ifndef SWYPIK_ARCH_X86_64_VTD_H
#define SWYPIK_ARCH_X86_64_VTD_H

#include "swypik/arch/x86_64/address_space.h"
#include "swypik/arch/x86_64/iommu.h"

#define SWYP_X86_VTD_DOMAIN_CAPACITY 64u
#define SWYP_X86_VTD_DEVICE_CAPACITY 64u
#define SWYP_X86_VTD_MAX_DOMAIN_TABLE_PAGES 256u
#define SWYP_X86_VTD_CONTEXT_BUS_COUNT 256u
#define SWYP_X86_VTD_POLL_LIMIT 100000u

typedef struct SwypX86VtdRegisterOps {
    SwypStatus (*read32)(void *context, uint32_t offset, uint32_t *value);
    SwypStatus (*write32)(void *context, uint32_t offset, uint32_t value);
    SwypStatus (*read64)(void *context, uint32_t offset, uint64_t *value);
    SwypStatus (*write64)(void *context, uint32_t offset, uint64_t value);
} SwypX86VtdRegisterOps;

typedef struct SwypX86VtdDomain {
    uint32_t active;
    uint16_t hardware_did;
    uint16_t device_count;
    uint64_t domain_id;
    uint64_t sl_root_physical;
    uint16_t table_page_count;
    uint16_t reserved0;
    uint32_t reserved1;
    uint64_t table_pages[SWYP_X86_VTD_MAX_DOMAIN_TABLE_PAGES];
} SwypX86VtdDomain;

typedef struct SwypX86VtdDevice {
    uint32_t active;
    uint16_t segment;
    uint8_t bus;
    uint8_t devfn;
    uint64_t domain_id;
    uint64_t device_id;
} SwypX86VtdDevice;

typedef struct SwypX86Vtd {
    SwypPageAllocator *page_allocator;
    void *memory_context;
    const SwypX86AddressSpaceHardwareOps *memory_ops;
    void *register_context;
    const SwypX86VtdRegisterOps *register_ops;
    uint16_t segment;
    uint16_t max_hardware_domains;
    uint32_t enabled;
    uint32_t failed;
    uint64_t capability;
    uint64_t extended_capability;
    uint64_t root_table_physical;
    uint64_t context_tables[SWYP_X86_VTD_CONTEXT_BUS_COUNT];
    SwypX86VtdDomain domains[SWYP_X86_VTD_DOMAIN_CAPACITY];
    SwypX86VtdDevice devices[SWYP_X86_VTD_DEVICE_CAPACITY];
} SwypX86Vtd;

SwypStatus swyp_x86_vtd_init(SwypX86Vtd *vtd, uint16_t segment, SwypPageAllocator *page_allocator,
                             void *memory_context, const SwypX86AddressSpaceHardwareOps *memory_ops,
                             void *register_context, const SwypX86VtdRegisterOps *register_ops);
SwypStatus swyp_x86_vtd_query(const SwypX86Vtd *vtd, uint64_t domain_id, uint64_t iova,
                              uint64_t *physical_address, uint64_t *access_rights);
SwypStatus swyp_x86_vtd_shutdown(SwypX86Vtd *vtd);
const SwypX86IommuHardwareOps *swyp_x86_vtd_iommu_ops(void);
int swyp_x86_vtd_is_enabled(const SwypX86Vtd *vtd);

#endif
