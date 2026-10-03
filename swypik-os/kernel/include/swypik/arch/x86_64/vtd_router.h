#ifndef SWYPIK_ARCH_X86_64_VTD_ROUTER_H
#define SWYPIK_ARCH_X86_64_VTD_ROUTER_H

#include "swypik/arch/x86_64/vtd.h"
#include "swypik/arch/x86_64/pci_ecam.h"
#include "swypik/firmware/acpi.h"

#define SWYP_X86_VTD_ROUTER_BINDING_CAPACITY SWYP_X86_IOMMU_DEVICE_CAPACITY

typedef struct SwypX86VtdRouteBinding {
    uint32_t active;
    uint32_t unit_index;
    uint64_t domain_id;
    uint64_t device_id;
    uint64_t requester_aux;
    uint64_t rmrr_base;
    uint64_t rmrr_length;
    uint32_t rmrr_hardware_mapped;
    uint32_t reserved0;
} SwypX86VtdRouteBinding;

typedef struct SwypX86VtdRmrrAuthorization {
    uint32_t active;
    uint32_t reserved0;
    uint64_t domain_id;
    uint64_t device_id;
    uint64_t requester_aux;
    uint64_t base;
    uint64_t length;
} SwypX86VtdRmrrAuthorization;

typedef struct SwypX86VtdRouter {
    const SwypAcpiPlatform *acpi;
    SwypX86PciEcam *pci;
    SwypX86Vtd *units[SWYP_ACPI_MAX_DMAR_UNITS];
    uint32_t unit_count;
    uint32_t failed;
    SwypX86VtdRouteBinding bindings[SWYP_X86_VTD_ROUTER_BINDING_CAPACITY];
    SwypX86VtdRmrrAuthorization rmrr_authorizations[SWYP_X86_VTD_ROUTER_BINDING_CAPACITY];
} SwypX86VtdRouter;

SwypStatus swyp_x86_vtd_router_init(SwypX86VtdRouter *router, const SwypAcpiPlatform *acpi,
                                    SwypX86Vtd *const *units, uint32_t unit_count);
void swyp_x86_vtd_router_set_pci(SwypX86VtdRouter *router, SwypX86PciEcam *pci);
SwypStatus swyp_x86_vtd_router_reserved_for_requester(SwypX86VtdRouter *router, uint64_t requester_aux,
                                                      uint64_t *base, uint64_t *limit);
SwypStatus swyp_x86_vtd_router_authorize_rmrr(SwypX86VtdRouter *router, uint64_t domain_id, uint64_t device_id,
                                              uint64_t requester_aux, uint64_t base, uint64_t length);
SwypStatus swyp_x86_vtd_router_cancel_rmrr_authorization(SwypX86VtdRouter *router, uint64_t domain_id,
                                                         uint64_t device_id, uint64_t requester_aux);
const SwypX86IommuHardwareOps *swyp_x86_vtd_router_iommu_ops(void);

#endif
