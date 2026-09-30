#ifndef SWYPIK_KERNEL_IPC_H
#define SWYPIK_KERNEL_IPC_H

#include "swypik/kernel/abi.h"
#include "swypik/kernel/capability.h"

#define SWYP_IPC_QUEUE_CAPACITY 8u
#define SWYP_IPC_PAYLOAD_BYTES 128u

typedef struct SwypIpcMessage {
    uint32_t message_type;
    uint32_t payload_size;
    uint64_t correlation_id;
    SwypCapabilityHandle sender_capability;
    uint8_t payload[SWYP_IPC_PAYLOAD_BYTES];
} SwypIpcMessage;

typedef struct SwypIpcEndpoint {
    uint64_t endpoint_id;
    uint32_t head;
    uint32_t tail;
    uint32_t count;
    uint32_t reserved0;
    SwypIpcMessage queue[SWYP_IPC_QUEUE_CAPACITY];
} SwypIpcEndpoint;

void swyp_ipc_endpoint_init(SwypIpcEndpoint *endpoint, uint64_t endpoint_id);
SwypStatus swyp_ipc_send(SwypIpcEndpoint *endpoint, const SwypCapabilityTable *capability_table,
                         SwypCapabilityHandle sender_capability, uint64_t sender_domain, uint64_t lease_fence,
                         const SwypIpcMessage *message);
SwypStatus swyp_ipc_receive(SwypIpcEndpoint *endpoint, const SwypCapabilityTable *capability_table,
                            SwypCapabilityHandle receiver_capability, uint64_t receiver_domain, uint64_t lease_fence,
                            SwypIpcMessage *message);

#endif
