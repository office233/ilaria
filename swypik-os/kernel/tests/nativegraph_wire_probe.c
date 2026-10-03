#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "swypik/kernel/device_graph.h"

#define NATIVEGRAPH_MAX_WIRE_BYTES                                                                    \
    (SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES +                                                            \
     SWYP_DEVICE_GRAPH_MAX_NODES * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES +                               \
     SWYP_DEVICE_GRAPH_MAX_RESOURCES * SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES +                       \
     SWYP_DEVICE_GRAPH_MAX_EDGES * SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES)

static void print_json_string(const char *value) {
    const unsigned char *p = (const unsigned char *)value;
    putchar('"');
    while (*p != 0u) {
        switch (*p) {
        case '"':
            fputs("\\\"", stdout);
            break;
        case '\\':
            fputs("\\\\", stdout);
            break;
        case '\b':
            fputs("\\b", stdout);
            break;
        case '\f':
            fputs("\\f", stdout);
            break;
        case '\n':
            fputs("\\n", stdout);
            break;
        case '\r':
            fputs("\\r", stdout);
            break;
        case '\t':
            fputs("\\t", stdout);
            break;
        default:
            if (*p < 0x20u) {
                printf("\\u%04x", (unsigned int)*p);
            } else {
                putchar((int)*p);
            }
            break;
        }
        ++p;
    }
    putchar('"');
}

static int read_wire(const char *path, uint8_t *wire, size_t capacity, size_t *wire_size) {
    FILE *file;
    long size;
    size_t read_size;

    if (path == NULL || wire == NULL || wire_size == NULL) {
        return 0;
    }
    file = fopen(path, "rb");
    if (file == NULL) {
        perror("fopen");
        return 0;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        perror("fseek");
        fclose(file);
        return 0;
    }
    size = ftell(file);
    if (size < 0 || (uint64_t)size > (uint64_t)capacity) {
        fprintf(stderr, "wire size out of probe bounds: %ld\n", size);
        fclose(file);
        return 0;
    }
    if (fseek(file, 0, SEEK_SET) != 0) {
        perror("fseek");
        fclose(file);
        return 0;
    }
    read_size = fread(wire, 1u, (size_t)size, file);
    if (read_size != (size_t)size || ferror(file)) {
        fprintf(stderr, "short wire read: %zu/%ld\n", read_size, size);
        fclose(file);
        return 0;
    }
    fclose(file);
    *wire_size = read_size;
    return 1;
}

static void print_node(const SwypDeviceNode *node) {
    fputs("{\"ID\":", stdout);
    printf("%" PRIu64, node->id);
    fputs(",\"ParentID\":", stdout);
    printf("%" PRIu64, node->parent_id);
    fputs(",\"DeviceClass\":", stdout);
    printf("%u", (unsigned int)node->device_class);
    fputs(",\"Bus\":", stdout);
    printf("%u", (unsigned int)node->bus);
    fputs(",\"Flags\":", stdout);
    printf("%" PRIu32, node->flags);
    fputs(",\"VendorID\":", stdout);
    printf("%" PRIu32, node->vendor_id);
    fputs(",\"DeviceID\":", stdout);
    printf("%" PRIu32, node->device_id);
    fputs(",\"ClassCode\":", stdout);
    printf("%u", (unsigned int)node->class_code);
    fputs(",\"Subclass\":", stdout);
    printf("%u", (unsigned int)node->subclass);
    fputs(",\"ProgIF\":", stdout);
    printf("%u", (unsigned int)node->prog_if);
    fputs(",\"Revision\":", stdout);
    printf("%u", (unsigned int)node->revision);
    fputs(",\"InterfaceCount\":", stdout);
    printf("%u", (unsigned int)node->interface_count);
    fputs(",\"IOMMUGroup\":", stdout);
    printf("%" PRIu32, node->iommu_group);
    fputs(",\"FeatureBits\":", stdout);
    printf("%" PRIu64, node->feature_bits);
    fputs(",\"FirmwareVersion\":", stdout);
    print_json_string(node->firmware_version);
    fputs(",\"Model\":", stdout);
    print_json_string(node->model);
    putchar('}');
}

static void print_resource(const SwypDeviceResource *resource) {
    fputs("{\"NodeID\":", stdout);
    printf("%" PRIu64, resource->node_id);
    fputs(",\"Kind\":", stdout);
    printf("%u", (unsigned int)resource->kind);
    fputs(",\"Flags\":", stdout);
    printf("%u", (unsigned int)resource->flags);
    fputs(",\"Start\":", stdout);
    printf("%" PRIu64, resource->start);
    fputs(",\"Length\":", stdout);
    printf("%" PRIu64, resource->length);
    fputs(",\"Aux\":", stdout);
    printf("%" PRIu64, resource->aux);
    putchar('}');
}

static void print_edge(const SwypDeviceEdge *edge) {
    fputs("{\"FromNodeID\":", stdout);
    printf("%" PRIu64, edge->from_node_id);
    fputs(",\"ToNodeID\":", stdout);
    printf("%" PRIu64, edge->to_node_id);
    fputs(",\"Kind\":", stdout);
    printf("%u", (unsigned int)edge->kind);
    fputs(",\"Flags\":", stdout);
    printf("%u", (unsigned int)edge->flags);
    putchar('}');
}

int main(int argc, char **argv) {
    static uint8_t wire[NATIVEGRAPH_MAX_WIRE_BYTES];
    SwypDeviceGraph graph;
    SwypStatus status;
    size_t wire_size = 0u;
    uint16_t i;

    if (argc != 2) {
        fprintf(stderr, "usage: nativegraph_wire_probe WIRE.bin\n");
        return 2;
    }
    if (!read_wire(argv[1], wire, sizeof(wire), &wire_size)) {
        return 3;
    }

    status = swyp_device_graph_decode(&graph, wire, wire_size);
    if (status != SWYP_OK) {
        fprintf(stderr, "swyp_device_graph_decode failed: %d\n", (int)status);
        return 4;
    }

    fputs("{\"NodeCount\":", stdout);
    printf("%u", (unsigned int)graph.node_count);
    fputs(",\"ResourceCount\":", stdout);
    printf("%u", (unsigned int)graph.resource_count);
    fputs(",\"EdgeCount\":", stdout);
    printf("%u", (unsigned int)graph.edge_count);

    fputs(",\"Nodes\":[", stdout);
    for (i = 0u; i < graph.node_count; ++i) {
        if (i != 0u) {
            putchar(',');
        }
        print_node(&graph.nodes[i]);
    }
    fputs("],\"Resources\":[", stdout);
    for (i = 0u; i < graph.resource_count; ++i) {
        if (i != 0u) {
            putchar(',');
        }
        print_resource(&graph.resources[i]);
    }
    fputs("],\"Edges\":[", stdout);
    for (i = 0u; i < graph.edge_count; ++i) {
        if (i != 0u) {
            putchar(',');
        }
        print_edge(&graph.edges[i]);
    }
    fputs("]}\n", stdout);
    return 0;
}
