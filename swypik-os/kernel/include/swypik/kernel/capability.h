#ifndef SWYPIK_KERNEL_CAPABILITY_H
#define SWYPIK_KERNEL_CAPABILITY_H

#include "swypik/kernel/abi.h"

#define SWYP_CAPABILITY_TABLE_CAPACITY 64u

enum {
    SWYP_CAPABILITY_SLOT_FREE = 0u,
    SWYP_CAPABILITY_SLOT_ACTIVE = 1u,
    SWYP_CAPABILITY_SLOT_RETIRED = 2u
};

typedef uint64_t SwypCapabilityHandle;

typedef enum SwypCapabilityObjectType {
    SWYP_CAP_OBJECT_INVALID = 0,
    SWYP_CAP_OBJECT_MMIO = 1,
    SWYP_CAP_OBJECT_PORT_IO = 2,
    SWYP_CAP_OBJECT_INTERRUPT = 3,
    SWYP_CAP_OBJECT_DMA = 4,
    SWYP_CAP_OBJECT_DEVICE_CONFIG = 5,
    SWYP_CAP_OBJECT_DEVICE_CONTROL = 6,
    SWYP_CAP_OBJECT_SHARED_MEMORY = 7,
    SWYP_CAP_OBJECT_IPC_ENDPOINT = 8
} SwypCapabilityObjectType;

enum {
    SWYP_CAP_RIGHT_READ = UINT64_C(1) << 0,
    SWYP_CAP_RIGHT_WRITE = UINT64_C(1) << 1,
    SWYP_CAP_RIGHT_MAP = UINT64_C(1) << 2,
    SWYP_CAP_RIGHT_BIND = UINT64_C(1) << 3,
    SWYP_CAP_RIGHT_ACK = UINT64_C(1) << 4,
    SWYP_CAP_RIGHT_SEND = UINT64_C(1) << 5,
    SWYP_CAP_RIGHT_RECEIVE = UINT64_C(1) << 6,
    SWYP_CAP_RIGHT_CONTROL = UINT64_C(1) << 7
};

typedef struct SwypCapabilityObject {
    SwypCapabilityObjectType type;
    uint32_t reserved0;
    uint64_t object_id;
    uint64_t base;
    uint64_t length;
    uint64_t aux;
} SwypCapabilityObject;

typedef struct SwypCapabilityGrant {
    SwypCapabilityHandle handle;
    uint64_t rights;
    uint64_t subject_domain;
    uint64_t lease_fence;
    SwypCapabilityObject object;
} SwypCapabilityGrant;

typedef struct SwypCapabilityEntry {
    uint32_t generation;
    uint32_t active;
    SwypCapabilityGrant grant;
} SwypCapabilityEntry;

typedef struct SwypCapabilityTable {
    SwypCapabilityEntry entries[SWYP_CAPABILITY_TABLE_CAPACITY];
} SwypCapabilityTable;

void swyp_capability_table_init(SwypCapabilityTable *table);
uint64_t swyp_capability_allowed_rights(SwypCapabilityObjectType type);
SwypStatus swyp_capability_mint(SwypCapabilityTable *table, const SwypCapabilityObject *object, uint64_t rights,
                                uint64_t subject_domain, uint64_t lease_fence, SwypCapabilityHandle *out_handle);
SwypStatus swyp_capability_lookup(const SwypCapabilityTable *table, SwypCapabilityHandle handle,
                                  uint64_t subject_domain, uint64_t lease_fence, uint64_t required_rights,
                                  const SwypCapabilityGrant **out_grant);
SwypStatus swyp_capability_revoke(SwypCapabilityTable *table, SwypCapabilityHandle handle);

#endif
