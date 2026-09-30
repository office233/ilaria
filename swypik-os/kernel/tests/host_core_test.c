#include <stdio.h>
#include <string.h>

#include "swypik/kernel/capability.h"
#include "swypik/kernel/contracts.h"
#include "swypik/kernel/device_graph.h"
#include "swypik/kernel/ipc.h"

static int failures = 0;

#define CHECK(expr)                                                                                 \
    do {                                                                                            \
        if (!(expr)) {                                                                              \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #expr);                       \
            failures += 1;                                                                         \
        }                                                                                           \
    } while (0)

static void test_boot_contracts(void) {
    SwypBootInfo boot_info;
    swyp_boot_info_init(&boot_info, SWYP_ARCH_X86_64, SWYP_FIRMWARE_UEFI, UINT64_C(0x12340000));
    CHECK(boot_info.magic == SWYP_BOOT_INFO_MAGIC);
    CHECK(boot_info.abi_version == SWYP_KERNEL_ABI_VERSION);
    CHECK(boot_info.struct_size == sizeof(boot_info));
    CHECK(boot_info.arch.arch == SWYP_ARCH_X86_64);
    CHECK(boot_info.arch.endianness == SWYP_ENDIAN_LITTLE);
    CHECK(boot_info.arch.native_word_bits == 64u);
    CHECK(boot_info.arch.base_page_shift == 12u);
    CHECK(boot_info.physical_memory.abi_version == SWYP_KERNEL_ABI_VERSION);
}

static void test_capabilities(void) {
    SwypCapabilityTable table;
    SwypCapabilityObject object = {
        .type = SWYP_CAP_OBJECT_MMIO,
        .object_id = UINT64_C(0x42),
        .base = UINT64_C(0xfebf0000),
        .length = UINT64_C(0x1000),
        .aux = 0u,
    };
    SwypCapabilityHandle handle = 0u;
    SwypCapabilityHandle replacement = 0u;
    const SwypCapabilityGrant *grant = NULL;

    swyp_capability_table_init(&table);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP, 7u, 11u, &handle) == SWYP_OK);
    CHECK(handle != 0u);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_OK);
    CHECK(grant != NULL && grant->object.base == object.base);
    CHECK(swyp_capability_lookup(&table, handle, 8u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 12u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 11u, SWYP_CAP_RIGHT_WRITE, &grant) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_CONTROL, 7u, 11u, &replacement) == SWYP_ERR_DENIED);
    CHECK(swyp_capability_revoke(&table, handle) == SWYP_OK);
    CHECK(swyp_capability_lookup(&table, handle, 7u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_STALE);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ, 7u, 12u, &replacement) == SWYP_OK);
    CHECK(replacement != handle);
}

static void test_capability_generation_exhaustion(void) {
    SwypCapabilityTable table;
    SwypCapabilityObject object = {
        .type = SWYP_CAP_OBJECT_MMIO,
        .object_id = 1u,
        .base = 0x1000u,
        .length = 0x1000u,
    };
    SwypCapabilityHandle ancient = 0u;
    SwypCapabilityHandle max_generation = (UINT64_C(0xffffffff) << 32) | UINT64_C(1);
    SwypCapabilityHandle replacement = 0u;
    const SwypCapabilityGrant *grant = NULL;

    swyp_capability_table_init(&table);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ, 7u, 11u, &ancient) == SWYP_OK);
    table.entries[0].generation = UINT32_MAX;
    table.entries[0].active = SWYP_CAPABILITY_SLOT_ACTIVE;
    table.entries[0].grant.handle = max_generation;
    CHECK(swyp_capability_revoke(&table, max_generation) == SWYP_OK);
    CHECK(table.entries[0].active == SWYP_CAPABILITY_SLOT_RETIRED);
    CHECK(table.entries[0].generation == UINT32_MAX);
    CHECK(swyp_capability_mint(&table, &object, SWYP_CAP_RIGHT_READ, 7u, 11u, &replacement) == SWYP_OK);
    CHECK((uint32_t)replacement == 2u);
    CHECK(replacement != ancient);
    CHECK(swyp_capability_lookup(&table, ancient, 7u, 11u, SWYP_CAP_RIGHT_READ, &grant) == SWYP_ERR_STALE);
}

static void test_ipc(void) {
    SwypIpcEndpoint endpoint;
    SwypCapabilityTable table;
    SwypCapabilityObject endpoint_object = {
        .type = SWYP_CAP_OBJECT_IPC_ENDPOINT,
        .object_id = 99u,
    };
    SwypCapabilityObject wrong_endpoint_object = {
        .type = SWYP_CAP_OBJECT_IPC_ENDPOINT,
        .object_id = 100u,
    };
    SwypIpcMessage message = {0};
    SwypIpcMessage received = {0};
    SwypCapabilityHandle sender = 0u;
    SwypCapabilityHandle receiver = 0u;
    SwypCapabilityHandle wrong_endpoint = 0u;
    SwypCapabilityHandle revoked = 0u;
    SwypCapabilityHandle forged = (UINT64_C(1) << 32) | UINT64_C(64);
    uint32_t i;

    swyp_ipc_endpoint_init(&endpoint, 99u);
    swyp_capability_table_init(&table);
    CHECK(swyp_capability_mint(&table, &endpoint_object, SWYP_CAP_RIGHT_SEND, 7u, 11u, &sender) == SWYP_OK);
    CHECK(swyp_capability_mint(&table, &endpoint_object, SWYP_CAP_RIGHT_RECEIVE, 8u, 12u, &receiver) == SWYP_OK);
    CHECK(swyp_capability_mint(&table, &wrong_endpoint_object, SWYP_CAP_RIGHT_SEND, 7u, 11u, &wrong_endpoint) == SWYP_OK);
    CHECK(swyp_capability_mint(&table, &endpoint_object, SWYP_CAP_RIGHT_SEND, 7u, 11u, &revoked) == SWYP_OK);
    CHECK(swyp_capability_revoke(&table, revoked) == SWYP_OK);
    message.message_type = 3u;
    message.payload_size = 4u;
    message.correlation_id = 123u;
    message.payload[0] = 0xde;
    message.payload[1] = 0xad;
    message.payload[2] = 0xbe;
    message.payload[3] = 0xef;
    message.sender_capability = forged;
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 8u, 11u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 12u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, receiver, 8u, 12u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, revoked, 7u, 11u, &message) == SWYP_ERR_STALE);
    CHECK(swyp_ipc_send(&endpoint, &table, forged, 7u, 11u, &message) == SWYP_ERR_STALE);
    CHECK(swyp_ipc_send(&endpoint, &table, wrong_endpoint, 7u, 11u, &message) == SWYP_ERR_DENIED);
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 11u, &message) == SWYP_OK);
    CHECK(swyp_ipc_receive(&endpoint, &table, receiver, 8u, 12u, &received) == SWYP_OK);
    CHECK(received.correlation_id == message.correlation_id);
    CHECK(received.sender_capability == sender);
    CHECK(memcmp(received.payload, message.payload, message.payload_size) == 0);
    CHECK(swyp_ipc_receive(&endpoint, &table, receiver, 8u, 12u, &received) == SWYP_ERR_NOT_FOUND);

    for (i = 0; i < SWYP_IPC_QUEUE_CAPACITY; ++i) {
        message.correlation_id = i;
        CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 11u, &message) == SWYP_OK);
    }
    CHECK(swyp_ipc_send(&endpoint, &table, sender, 7u, 11u, &message) == SWYP_ERR_NO_SPACE);
}

static void test_device_graph_adversarial(void) {
    SwypDeviceGraph graph;
    SwypDeviceGraph decoded;
    SwypDeviceNode root = {
        .id = 1u,
        .device_class = SWYP_DEVICE_CLASS_PLATFORM,
        .bus = SWYP_DEVICE_BUS_PLATFORM,
    };
    SwypDeviceNode child = {
        .id = 2u,
        .parent_id = 1u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
    };
    SwypDeviceResource range = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0x1000),
        .length = UINT64_C(0x100),
    };
    SwypDeviceResource invalid;
    SwypDeviceEdge edge = {
        .from_node_id = 1u,
        .to_node_id = 2u,
        .kind = SWYP_DEVICE_EDGE_CONTAINS,
    };
    SwypCapabilityObject object;
    uint64_t rights = 0u;
    uint8_t wire[512];
    uint8_t pristine[512];
    size_t wire_size = 0u;
    size_t node0;
    size_t resource0;
    size_t edge0;

    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &root) == SWYP_OK);
    CHECK(swyp_device_graph_add_node(&graph, &child) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &range) == SWYP_OK);
    CHECK(swyp_device_graph_add_edge(&graph, &edge) == SWYP_OK);
    CHECK(swyp_device_graph_encode(&graph, wire, sizeof(wire), &wire_size) == SWYP_OK);
    memcpy(pristine, wire, wire_size);
    node0 = SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES;
    resource0 = node0 + 2u * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES;
    edge0 = resource0 + SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES;

    memset(wire + node0 + 56u, 'F', 16u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    memset(wire + node0 + 72u, 'M', 24u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);

    memcpy(wire, pristine, wire_size);
    wire[18] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[node0 + 38u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[node0 + 44u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[resource0 + 12u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[edge0 + 20u] = 1u;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);

    memcpy(wire, pristine, wire_size);
    memset(wire + resource0 + 24u, 0, 8u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
    memcpy(wire, pristine, wire_size);
    wire[resource0 + 16u] = 0xf8u;
    memset(wire + resource0 + 17u, 0xff, 7u);
    wire[resource0 + 24u] = 0x10u;
    memset(wire + resource0 + 25u, 0, 7u);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);

    invalid = range;
    invalid.length = 0u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    CHECK(swyp_device_resource_capability(&invalid, &object, &rights) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.start = UINT64_MAX - 7u;
    invalid.length = 16u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    CHECK(swyp_device_resource_capability(&invalid, &object, &rights) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.kind = SWYP_DEVICE_RESOURCE_IRQ;
    invalid.start = 17u;
    invalid.length = 2u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid.kind = SWYP_DEVICE_RESOURCE_CONFIG;
    invalid.start = 4095u;
    invalid.length = 2u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid.kind = SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER;
    invalid.start = 3u;
    invalid.length = 2u;
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);
    invalid = range;
    invalid.start = UINT64_C(0x1080);
    invalid.length = UINT64_C(0x40);
    CHECK(swyp_device_graph_add_resource(&graph, &invalid) == SWYP_ERR_INVALID);

    {
        SwypDeviceGraph topology;
        SwypDeviceNode a = root;
        SwypDeviceNode b = child;
        SwypDeviceEdge ab = edge;
        SwypDeviceEdge ba = {
            .from_node_id = 2u,
            .to_node_id = 1u,
            .kind = SWYP_DEVICE_EDGE_CONTAINS,
        };
        SwypDeviceEdge self = {
            .from_node_id = 1u,
            .to_node_id = 1u,
            .kind = SWYP_DEVICE_EDGE_DEPENDS_ON,
        };
        swyp_device_graph_init(&topology);
        a.parent_id = 0u;
        b.parent_id = 1u;
        CHECK(swyp_device_graph_add_node(&topology, &a) == SWYP_OK);
        CHECK(swyp_device_graph_add_node(&topology, &b) == SWYP_OK);
        CHECK(swyp_device_graph_add_edge(&topology, &ab) == SWYP_OK);
        CHECK(swyp_device_graph_add_edge(&topology, &ab) == SWYP_ERR_INVALID);
        CHECK(swyp_device_graph_add_edge(&topology, &self) == SWYP_ERR_INVALID);
        CHECK(swyp_device_graph_add_edge(&topology, &ba) == SWYP_ERR_INVALID);
        topology.nodes[0].parent_id = 2u;
        CHECK(swyp_device_graph_validate(&topology) == SWYP_ERR_CORRUPT);
        topology.nodes[0].parent_id = 1u;
        CHECK(swyp_device_graph_validate(&topology) == SWYP_ERR_CORRUPT);
    }
}

static void test_device_graph_wire(void) {
    SwypDeviceGraph graph;
    SwypDeviceGraph decoded;
    SwypDeviceNode root = {
        .id = 1u,
        .device_class = SWYP_DEVICE_CLASS_PLATFORM,
        .bus = SWYP_DEVICE_BUS_PLATFORM,
    };
    SwypDeviceNode nic = {
        .id = 2u,
        .parent_id = 1u,
        .device_class = SWYP_DEVICE_CLASS_NETWORK,
        .bus = SWYP_DEVICE_BUS_PCI,
        .vendor_id = 0x1af4u,
        .device_id = 0x1000u,
        .class_code = 0x02u,
        .subclass = 0x00u,
        .prog_if = 0u,
        .revision = 1u,
        .iommu_group = 4u,
        .feature_bits = UINT64_C(0x5),
    };
    SwypDeviceResource mmio = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_MMIO,
        .start = UINT64_C(0xfebf0000),
        .length = UINT64_C(0x1000),
    };
    SwypDeviceResource irq = {
        .node_id = 2u,
        .kind = SWYP_DEVICE_RESOURCE_IRQ,
        .start = 17u,
        .length = 1u,
    };
    SwypDeviceEdge contains = {
        .from_node_id = 1u,
        .to_node_id = 2u,
        .kind = SWYP_DEVICE_EDGE_CONTAINS,
    };
    SwypCapabilityObject capability_object;
    uint64_t rights = 0u;
    uint8_t wire[1024];
    size_t wire_size = 0u;

    memcpy(nic.firmware_version, "virtio-1", 9u);
    memcpy(nic.model, "virtio-net", 11u);
    swyp_device_graph_init(&graph);
    CHECK(swyp_device_graph_add_node(&graph, &root) == SWYP_OK);
    CHECK(swyp_device_graph_add_node(&graph, &nic) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &mmio) == SWYP_OK);
    CHECK(swyp_device_graph_add_resource(&graph, &irq) == SWYP_OK);
    CHECK(swyp_device_graph_add_edge(&graph, &contains) == SWYP_OK);
    CHECK(swyp_device_graph_validate(&graph) == SWYP_OK);
    CHECK(swyp_device_graph_encode(&graph, wire, sizeof(wire), &wire_size) == SWYP_OK);
    CHECK(wire_size == SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES + 2u * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES +
                           2u * SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES + SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES);
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_OK);
    CHECK(decoded.node_count == 2u && decoded.resource_count == 2u && decoded.edge_count == 1u);
    CHECK(decoded.nodes[1].vendor_id == nic.vendor_id);
    CHECK(strcmp(decoded.nodes[1].model, "virtio-net") == 0);
    CHECK(swyp_device_resource_capability(&decoded.resources[0], &capability_object, &rights) == SWYP_OK);
    CHECK(capability_object.type == SWYP_CAP_OBJECT_MMIO);
    CHECK((rights & (SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_WRITE | SWYP_CAP_RIGHT_MAP)) != 0u);

    wire[0] ^= 0xffu;
    CHECK(swyp_device_graph_decode(&decoded, wire, wire_size) == SWYP_ERR_CORRUPT);
}

int main(void) {
    test_boot_contracts();
    test_capabilities();
    test_capability_generation_exhaustion();
    test_ipc();
    test_device_graph_wire();
    test_device_graph_adversarial();
    if (failures != 0) {
        fprintf(stderr, "swypik-kernel host core tests: %d failure(s)\n", failures);
        return 1;
    }
    puts("swypik-kernel host core tests: PASS");
    return 0;
}
