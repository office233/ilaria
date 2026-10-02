#ifndef SWYPIK_KERNEL_DRIVER_DOMAIN_H
#define SWYPIK_KERNEL_DRIVER_DOMAIN_H

#include "swypik/kernel/capability.h"
#include "swypik/kernel/device_graph.h"

#define SWYP_DRIVER_DOMAIN_CAPACITY 16u
#define SWYP_DRIVER_DOMAIN_MAX_GRANTS SWYP_DEVICE_GRAPH_MAX_RESOURCES

enum {
    SWYP_DRIVER_DOMAIN_FREE = 0u,
    SWYP_DRIVER_DOMAIN_ACTIVE = 1u,
    SWYP_DRIVER_DOMAIN_QUIESCED = 2u
};

typedef struct SwypDriverDomainPolicy {
    /* Zero means the graph resource is not granted. Nonzero is the exact
       requested rights mask for that resource index. */
    uint64_t resource_rights[SWYP_DEVICE_GRAPH_MAX_RESOURCES];
} SwypDriverDomainPolicy;

typedef struct SwypDriverDomain {
    uint64_t domain_id;
    uint64_t node_id;
    uint64_t lease_fence;
    uint16_t grant_count;
    uint16_t active;
    uint32_t reserved0;
    SwypCapabilityHandle grants[SWYP_DRIVER_DOMAIN_MAX_GRANTS];
} SwypDriverDomain;

typedef struct SwypDriverDomainManager {
    SwypCapabilityTable *capability_table;
    SwypDriverDomain domains[SWYP_DRIVER_DOMAIN_CAPACITY];
} SwypDriverDomainManager;

void swyp_driver_domain_policy_init(SwypDriverDomainPolicy *policy);
SwypStatus swyp_driver_domain_policy_allow_resource(SwypDriverDomainPolicy *policy, uint16_t resource_index,
                                                     uint64_t rights);
SwypStatus swyp_driver_domain_policy_allow_exact_resource(SwypDriverDomainPolicy *policy, const SwypDeviceGraph *graph,
                                                           const SwypDeviceResource *resource, uint64_t rights);
void swyp_driver_domain_manager_init(SwypDriverDomainManager *manager, SwypCapabilityTable *capability_table);
SwypStatus swyp_driver_domain_open(SwypDriverDomainManager *manager, const SwypDeviceGraph *graph, uint64_t node_id,
                                   uint64_t domain_id, uint64_t lease_fence, const SwypDriverDomainPolicy *policy,
                                   const SwypDriverDomain **out_domain);
/* Explicit no-device-grants path, only for COMPUTE/PLATFORM nodes. */
SwypStatus swyp_driver_domain_open_compute(SwypDriverDomainManager *manager, const SwypDeviceGraph *graph,
                                           uint64_t node_id, uint64_t domain_id, uint64_t lease_fence,
                                           const SwypDriverDomain **out_domain);
SwypStatus swyp_driver_domain_resolve(const SwypDriverDomainManager *manager, uint64_t domain_id, uint64_t lease_fence,
                                      SwypCapabilityHandle handle, uint64_t required_rights,
                                      SwypCapabilityObjectType expected_type, const SwypCapabilityGrant **out_grant);
SwypStatus swyp_driver_domain_quiesce(SwypDriverDomainManager *manager, uint64_t domain_id, uint64_t lease_fence);
SwypStatus swyp_driver_domain_revoke(SwypDriverDomainManager *manager, uint64_t domain_id, uint64_t lease_fence);

#endif
