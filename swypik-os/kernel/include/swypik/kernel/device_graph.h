#ifndef SWYPIK_KERNEL_DEVICE_GRAPH_H
#define SWYPIK_KERNEL_DEVICE_GRAPH_H

#include "swypik/kernel/abi.h"
#include "swypik/kernel/capability.h"

#define SWYP_DEVICE_GRAPH_MAX_NODES 32u
#define SWYP_DEVICE_GRAPH_MAX_RESOURCES 64u
#define SWYP_DEVICE_GRAPH_MAX_EDGES 64u

#define SWYP_DEVICE_GRAPH_WIRE_MAGIC UINT32_C(0x47445753)
#define SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES 24u
#define SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES 96u
#define SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES 40u
#define SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES 24u

typedef enum SwypDeviceClass {
    SWYP_DEVICE_CLASS_UNKNOWN = 0,
    SWYP_DEVICE_CLASS_STORAGE = 1,
    SWYP_DEVICE_CLASS_NETWORK = 2,
    SWYP_DEVICE_CLASS_DISPLAY = 3,
    SWYP_DEVICE_CLASS_INPUT = 4,
    SWYP_DEVICE_CLASS_AUDIO = 5,
    SWYP_DEVICE_CLASS_CAMERA_SENSOR = 6,
    SWYP_DEVICE_CLASS_POWER = 7,
    SWYP_DEVICE_CLASS_THERMAL = 8,
    SWYP_DEVICE_CLASS_COMPUTE = 9,
    SWYP_DEVICE_CLASS_USB_CONTROLLER = 10,
    SWYP_DEVICE_CLASS_PLATFORM = 11
} SwypDeviceClass;

typedef enum SwypDeviceBus {
    SWYP_DEVICE_BUS_UNKNOWN = 0,
    SWYP_DEVICE_BUS_PCI = 1,
    SWYP_DEVICE_BUS_USB = 2,
    SWYP_DEVICE_BUS_ACPI = 3,
    SWYP_DEVICE_BUS_DEVICE_TREE = 4,
    SWYP_DEVICE_BUS_VIRTIO = 5,
    SWYP_DEVICE_BUS_PLATFORM = 6
} SwypDeviceBus;

typedef enum SwypDeviceResourceKind {
    SWYP_DEVICE_RESOURCE_INVALID = 0,
    SWYP_DEVICE_RESOURCE_MMIO = 1,
    SWYP_DEVICE_RESOURCE_PORT_IO = 2,
    SWYP_DEVICE_RESOURCE_IRQ = 3,
    SWYP_DEVICE_RESOURCE_DMA = 4,
    SWYP_DEVICE_RESOURCE_CONFIG = 5,
    SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER = 6,
    SWYP_DEVICE_RESOURCE_SHARED_MEMORY = 7
} SwypDeviceResourceKind;

typedef enum SwypDeviceEdgeKind {
    SWYP_DEVICE_EDGE_CONTAINS = 1,
    SWYP_DEVICE_EDGE_DEPENDS_ON = 2,
    SWYP_DEVICE_EDGE_INTERRUPTS = 3,
    SWYP_DEVICE_EDGE_CLOCKED_BY = 4,
    SWYP_DEVICE_EDGE_POWERED_BY = 5
} SwypDeviceEdgeKind;

typedef struct SwypDeviceNode {
    uint64_t id;
    uint64_t parent_id;
    SwypDeviceClass device_class;
    SwypDeviceBus bus;
    uint32_t flags;
    uint32_t vendor_id;
    uint32_t device_id;
    uint8_t class_code;
    uint8_t subclass;
    uint8_t prog_if;
    uint8_t revision;
    uint16_t interface_count;
    uint16_t reserved0;
    uint32_t iommu_group;
    uint64_t feature_bits;
    char firmware_version[16];
    char model[24];
} SwypDeviceNode;

typedef struct SwypDeviceResource {
    uint64_t node_id;
    SwypDeviceResourceKind kind;
    uint16_t flags;
    uint32_t reserved0;
    uint64_t start;
    uint64_t length;
    uint64_t aux;
} SwypDeviceResource;

typedef struct SwypDeviceEdge {
    uint64_t from_node_id;
    uint64_t to_node_id;
    SwypDeviceEdgeKind kind;
    uint16_t flags;
    uint32_t reserved0;
} SwypDeviceEdge;

typedef struct SwypDeviceGraph {
    uint16_t node_count;
    uint16_t resource_count;
    uint16_t edge_count;
    uint16_t reserved0;
    SwypDeviceNode nodes[SWYP_DEVICE_GRAPH_MAX_NODES];
    SwypDeviceResource resources[SWYP_DEVICE_GRAPH_MAX_RESOURCES];
    SwypDeviceEdge edges[SWYP_DEVICE_GRAPH_MAX_EDGES];
} SwypDeviceGraph;

void swyp_device_graph_init(SwypDeviceGraph *graph);
SwypStatus swyp_device_graph_add_node(SwypDeviceGraph *graph, const SwypDeviceNode *node);
SwypStatus swyp_device_graph_add_resource(SwypDeviceGraph *graph, const SwypDeviceResource *resource);
SwypStatus swyp_device_graph_add_edge(SwypDeviceGraph *graph, const SwypDeviceEdge *edge);
SwypStatus swyp_device_graph_validate(const SwypDeviceGraph *graph);
size_t swyp_device_graph_wire_size(const SwypDeviceGraph *graph);
SwypStatus swyp_device_graph_encode(const SwypDeviceGraph *graph, uint8_t *wire, size_t wire_capacity, size_t *wire_size);
SwypStatus swyp_device_graph_decode(SwypDeviceGraph *graph, const uint8_t *wire, size_t wire_size);
SwypStatus swyp_device_resource_capability(const SwypDeviceResource *resource, SwypCapabilityObject *object,
                                           uint64_t *allowed_rights);

#endif
