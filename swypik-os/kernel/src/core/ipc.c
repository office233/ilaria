#include "swypik/kernel/ipc.h"

static void swyp_ipc_zero_message(SwypIpcMessage *message) {
    size_t i;
    uint8_t *bytes = (uint8_t *)message;
    for (i = 0; i < sizeof(*message); ++i) {
        bytes[i] = 0;
    }
}

void swyp_ipc_endpoint_init(SwypIpcEndpoint *endpoint, uint64_t endpoint_id) {
    uint32_t i;
    if (endpoint == NULL) {
        return;
    }
    endpoint->endpoint_id = endpoint_id;
    endpoint->head = 0u;
    endpoint->tail = 0u;
    endpoint->count = 0u;
    endpoint->reserved0 = 0u;
    for (i = 0; i < SWYP_IPC_QUEUE_CAPACITY; ++i) {
        swyp_ipc_zero_message(&endpoint->queue[i]);
    }
}

static SwypStatus swyp_ipc_authorize(const SwypIpcEndpoint *endpoint, const SwypCapabilityTable *capability_table,
                                     SwypCapabilityHandle capability, uint64_t domain, uint64_t lease_fence,
                                     uint64_t required_right) {
    const SwypCapabilityGrant *grant = NULL;
    SwypStatus status;
    if (endpoint == NULL || capability_table == NULL || endpoint->endpoint_id == 0u) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_capability_lookup(capability_table, capability, domain, lease_fence, required_right, &grant);
    if (status != SWYP_OK) {
        return status;
    }
    if (grant == NULL || grant->object.type != SWYP_CAP_OBJECT_IPC_ENDPOINT ||
        grant->object.object_id != endpoint->endpoint_id) {
        return SWYP_ERR_DENIED;
    }
    return SWYP_OK;
}

SwypStatus swyp_ipc_send(SwypIpcEndpoint *endpoint, const SwypCapabilityTable *capability_table,
                         SwypCapabilityHandle sender_capability, uint64_t sender_domain, uint64_t lease_fence,
                         const SwypIpcMessage *message) {
    SwypStatus status;
    SwypIpcMessage authenticated;
    if (endpoint == NULL || capability_table == NULL || message == NULL ||
        message->payload_size > SWYP_IPC_PAYLOAD_BYTES) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_ipc_authorize(endpoint, capability_table, sender_capability, sender_domain, lease_fence,
                                SWYP_CAP_RIGHT_SEND);
    if (status != SWYP_OK) {
        return status;
    }
    if (endpoint->count == SWYP_IPC_QUEUE_CAPACITY) {
        return SWYP_ERR_NO_SPACE;
    }
    authenticated = *message;
    authenticated.sender_capability = sender_capability;
    endpoint->queue[endpoint->tail] = authenticated;
    endpoint->tail = (endpoint->tail + 1u) % SWYP_IPC_QUEUE_CAPACITY;
    endpoint->count += 1u;
    return SWYP_OK;
}

SwypStatus swyp_ipc_receive(SwypIpcEndpoint *endpoint, const SwypCapabilityTable *capability_table,
                            SwypCapabilityHandle receiver_capability, uint64_t receiver_domain, uint64_t lease_fence,
                            SwypIpcMessage *message) {
    SwypStatus status;
    if (endpoint == NULL || capability_table == NULL || message == NULL) {
        return SWYP_ERR_INVALID;
    }
    status = swyp_ipc_authorize(endpoint, capability_table, receiver_capability, receiver_domain, lease_fence,
                                SWYP_CAP_RIGHT_RECEIVE);
    if (status != SWYP_OK) {
        return status;
    }
    if (endpoint->count == 0u) {
        return SWYP_ERR_NOT_FOUND;
    }
    *message = endpoint->queue[endpoint->head];
    swyp_ipc_zero_message(&endpoint->queue[endpoint->head]);
    endpoint->head = (endpoint->head + 1u) % SWYP_IPC_QUEUE_CAPACITY;
    endpoint->count -= 1u;
    return SWYP_OK;
}
