#include "swypik/kernel/device_graph.h"

static void swyp_zero_bytes(void *ptr, size_t size) {
    uint8_t *bytes = (uint8_t *)ptr;
    size_t i;
    for (i = 0; i < size; ++i) {
        bytes[i] = 0;
    }
}

static void swyp_copy_bytes(uint8_t *dst, const uint8_t *src, size_t size) {
    size_t i;
    for (i = 0; i < size; ++i) {
        dst[i] = src[i];
    }
}

static void swyp_put_u16(uint8_t *dst, uint16_t value) {
    dst[0] = (uint8_t)(value & 0xffu);
    dst[1] = (uint8_t)((value >> 8) & 0xffu);
}

static void swyp_put_u32(uint8_t *dst, uint32_t value) {
    dst[0] = (uint8_t)(value & 0xffu);
    dst[1] = (uint8_t)((value >> 8) & 0xffu);
    dst[2] = (uint8_t)((value >> 16) & 0xffu);
    dst[3] = (uint8_t)((value >> 24) & 0xffu);
}

static void swyp_put_u64(uint8_t *dst, uint64_t value) {
    uint32_t i;
    for (i = 0; i < 8u; ++i) {
        dst[i] = (uint8_t)((value >> (i * 8u)) & 0xffu);
    }
}

static uint16_t swyp_get_u16(const uint8_t *src) {
    return (uint16_t)((uint16_t)src[0] | ((uint16_t)src[1] << 8));
}

static uint32_t swyp_get_u32(const uint8_t *src) {
    return (uint32_t)src[0] |
           ((uint32_t)src[1] << 8) |
           ((uint32_t)src[2] << 16) |
           ((uint32_t)src[3] << 24);
}

static uint64_t swyp_get_u64(const uint8_t *src) {
    uint64_t value = 0u;
    uint32_t i;
    for (i = 0; i < 8u; ++i) {
        value |= (uint64_t)src[i] << (i * 8u);
    }
    return value;
}

static int swyp_bytes_are_zero(const uint8_t *bytes, size_t size) {
    size_t i;
    for (i = 0; i < size; ++i) {
        if (bytes[i] != 0u) {
            return 0;
        }
    }
    return 1;
}

static int swyp_fixed_string_is_canonical(const uint8_t *bytes, size_t size) {
    size_t i;
    size_t terminator = size;
    for (i = 0; i < size; ++i) {
        if (bytes[i] == 0u) {
            terminator = i;
            break;
        }
    }
    if (terminator == size) {
        return 0;
    }
    return swyp_bytes_are_zero(bytes + terminator, size - terminator);
}

static int swyp_device_graph_has_node(const SwypDeviceGraph *graph, uint64_t id) {
    uint16_t i;
    if (id == 0u) {
        return 0;
    }
    for (i = 0; i < graph->node_count; ++i) {
        if (graph->nodes[i].id == id) {
            return 1;
        }
    }
    return 0;
}

static int swyp_resource_range_valid(const SwypDeviceResource *resource) {
    if (resource->length == 0u) {
        return 0;
    }
    switch (resource->kind) {
    case SWYP_DEVICE_RESOURCE_MMIO:
        return resource->length <= UINT64_MAX - resource->start;
    case SWYP_DEVICE_RESOURCE_DMA:
    case SWYP_DEVICE_RESOURCE_SHARED_MEMORY:
        return (resource->start & UINT64_C(0xfff)) == 0u && (resource->length & UINT64_C(0xfff)) == 0u &&
               resource->length <= UINT64_MAX - resource->start;
    case SWYP_DEVICE_RESOURCE_PORT_IO:
        return resource->start <= UINT16_MAX && resource->length <= (UINT64_C(0x10000) - resource->start);
    case SWYP_DEVICE_RESOURCE_IRQ:
        return resource->length == 1u && resource->start <= UINT32_MAX;
    case SWYP_DEVICE_RESOURCE_CONFIG:
        return resource->start < UINT64_C(4096) && resource->length <= (UINT64_C(4096) - resource->start);
    case SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER:
        return resource->length == 1u;
    default:
        return 0;
    }
}

static int swyp_resource_ranges_overlap(const SwypDeviceResource *left, const SwypDeviceResource *right) {
    uint64_t left_end = left->start + left->length;
    uint64_t right_end = right->start + right->length;
    return left->start < right_end && right->start < left_end;
}

static int swyp_resource_overlap_is_forbidden(const SwypDeviceResource *left, const SwypDeviceResource *right) {
    if (left->kind != right->kind) {
        return 0;
    }
    switch (left->kind) {
    case SWYP_DEVICE_RESOURCE_MMIO:
    case SWYP_DEVICE_RESOURCE_PORT_IO:
    case SWYP_DEVICE_RESOURCE_DMA:
    case SWYP_DEVICE_RESOURCE_SHARED_MEMORY:
        return swyp_resource_ranges_overlap(left, right);
    case SWYP_DEVICE_RESOURCE_CONFIG:
        return left->node_id == right->node_id && swyp_resource_ranges_overlap(left, right);
    case SWYP_DEVICE_RESOURCE_IRQ:
    case SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER:
        return left->node_id == right->node_id && left->start == right->start;
    default:
        return 0;
    }
}

static int swyp_hierarchy_visit(const SwypDeviceGraph *graph, uint16_t node_index, uint8_t *marks) {
    uint16_t i;
    uint64_t node_id = graph->nodes[node_index].id;
    if (marks[node_index] == 1u) {
        return 0;
    }
    if (marks[node_index] == 2u) {
        return 1;
    }
    marks[node_index] = 1u;
    for (i = 0; i < graph->node_count; ++i) {
        uint16_t edge_index;
        int is_child = graph->nodes[i].parent_id == node_id;
        for (edge_index = 0; !is_child && edge_index < graph->edge_count; ++edge_index) {
            const SwypDeviceEdge *edge = &graph->edges[edge_index];
            if (edge->kind == SWYP_DEVICE_EDGE_CONTAINS && edge->from_node_id == node_id &&
                edge->to_node_id == graph->nodes[i].id) {
                is_child = 1;
            }
        }
        if (is_child && !swyp_hierarchy_visit(graph, i, marks)) {
            return 0;
        }
    }
    marks[node_index] = 2u;
    return 1;
}

static int swyp_device_graph_hierarchy_is_acyclic(const SwypDeviceGraph *graph) {
    uint8_t marks[SWYP_DEVICE_GRAPH_MAX_NODES] = {0};
    uint16_t i;
    for (i = 0; i < graph->node_count; ++i) {
        if (!swyp_hierarchy_visit(graph, i, marks)) {
            return 0;
        }
    }
    return 1;
}

void swyp_device_graph_init(SwypDeviceGraph *graph) {
    if (graph != NULL) {
        swyp_zero_bytes(graph, sizeof(*graph));
    }
}

SwypStatus swyp_device_graph_add_node(SwypDeviceGraph *graph, const SwypDeviceNode *node) {
    if (graph == NULL || node == NULL || node->id == 0u || node->parent_id == node->id) {
        return SWYP_ERR_INVALID;
    }
    if (graph->node_count >= SWYP_DEVICE_GRAPH_MAX_NODES) {
        return SWYP_ERR_NO_SPACE;
    }
    if (swyp_device_graph_has_node(graph, node->id)) {
        return SWYP_ERR_INVALID;
    }
    graph->nodes[graph->node_count++] = *node;
    return SWYP_OK;
}

SwypStatus swyp_device_graph_add_resource(SwypDeviceGraph *graph, const SwypDeviceResource *resource) {
    uint16_t i;
    if (graph == NULL || resource == NULL || resource->kind == SWYP_DEVICE_RESOURCE_INVALID ||
        resource->kind > SWYP_DEVICE_RESOURCE_SHARED_MEMORY || !swyp_device_graph_has_node(graph, resource->node_id) ||
        !swyp_resource_range_valid(resource)) {
        return SWYP_ERR_INVALID;
    }
    if (graph->resource_count >= SWYP_DEVICE_GRAPH_MAX_RESOURCES) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = 0; i < graph->resource_count; ++i) {
        if (swyp_resource_overlap_is_forbidden(&graph->resources[i], resource)) {
            return SWYP_ERR_INVALID;
        }
    }
    graph->resources[graph->resource_count++] = *resource;
    return SWYP_OK;
}

SwypStatus swyp_device_graph_add_edge(SwypDeviceGraph *graph, const SwypDeviceEdge *edge) {
    uint16_t i;
    if (graph == NULL || edge == NULL || !swyp_device_graph_has_node(graph, edge->from_node_id) ||
        !swyp_device_graph_has_node(graph, edge->to_node_id) || edge->kind < SWYP_DEVICE_EDGE_CONTAINS ||
        edge->kind > SWYP_DEVICE_EDGE_POWERED_BY || edge->from_node_id == edge->to_node_id) {
        return SWYP_ERR_INVALID;
    }
    if (graph->edge_count >= SWYP_DEVICE_GRAPH_MAX_EDGES) {
        return SWYP_ERR_NO_SPACE;
    }
    for (i = 0; i < graph->edge_count; ++i) {
        if (graph->edges[i].from_node_id == edge->from_node_id && graph->edges[i].to_node_id == edge->to_node_id &&
            graph->edges[i].kind == edge->kind) {
            return SWYP_ERR_INVALID;
        }
    }
    graph->edges[graph->edge_count++] = *edge;
    if (!swyp_device_graph_hierarchy_is_acyclic(graph)) {
        graph->edge_count -= 1u;
        return SWYP_ERR_INVALID;
    }
    return SWYP_OK;
}

SwypStatus swyp_device_graph_validate(const SwypDeviceGraph *graph) {
    uint16_t i;
    uint16_t j;
    if (graph == NULL || graph->node_count > SWYP_DEVICE_GRAPH_MAX_NODES || graph->reserved0 != 0u ||
        graph->resource_count > SWYP_DEVICE_GRAPH_MAX_RESOURCES || graph->edge_count > SWYP_DEVICE_GRAPH_MAX_EDGES) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0; i < graph->node_count; ++i) {
        const SwypDeviceNode *node = &graph->nodes[i];
        if (node->id == 0u || node->reserved0 != 0u || node->parent_id == node->id ||
            !swyp_fixed_string_is_canonical((const uint8_t *)node->firmware_version, sizeof(node->firmware_version)) ||
            !swyp_fixed_string_is_canonical((const uint8_t *)node->model, sizeof(node->model)) ||
            node->device_class < SWYP_DEVICE_CLASS_UNKNOWN ||
            node->device_class > SWYP_DEVICE_CLASS_PLATFORM || node->bus < SWYP_DEVICE_BUS_UNKNOWN ||
            node->bus > SWYP_DEVICE_BUS_PLATFORM) {
            return SWYP_ERR_CORRUPT;
        }
        if (node->parent_id != 0u && !swyp_device_graph_has_node(graph, node->parent_id)) {
            return SWYP_ERR_CORRUPT;
        }
        for (j = (uint16_t)(i + 1u); j < graph->node_count; ++j) {
            if (node->id == graph->nodes[j].id) {
                return SWYP_ERR_CORRUPT;
            }
        }
    }
    for (i = 0; i < graph->resource_count; ++i) {
        const SwypDeviceResource *resource = &graph->resources[i];
        if (!swyp_device_graph_has_node(graph, resource->node_id) || resource->reserved0 != 0u ||
            resource->kind == SWYP_DEVICE_RESOURCE_INVALID || resource->kind > SWYP_DEVICE_RESOURCE_SHARED_MEMORY ||
            !swyp_resource_range_valid(resource)) {
            return SWYP_ERR_CORRUPT;
        }
    }
    for (i = 0; i < graph->resource_count; ++i) {
        const SwypDeviceResource *resource = &graph->resources[i];
        for (j = (uint16_t)(i + 1u); j < graph->resource_count; ++j) {
            if (swyp_resource_overlap_is_forbidden(resource, &graph->resources[j])) {
                return SWYP_ERR_CORRUPT;
            }
        }
    }
    for (i = 0; i < graph->edge_count; ++i) {
        const SwypDeviceEdge *edge = &graph->edges[i];
        if (!swyp_device_graph_has_node(graph, edge->from_node_id) ||
            !swyp_device_graph_has_node(graph, edge->to_node_id) || edge->reserved0 != 0u ||
            edge->from_node_id == edge->to_node_id || edge->kind < SWYP_DEVICE_EDGE_CONTAINS ||
            edge->kind > SWYP_DEVICE_EDGE_POWERED_BY) {
            return SWYP_ERR_CORRUPT;
        }
        for (j = (uint16_t)(i + 1u); j < graph->edge_count; ++j) {
            if (edge->from_node_id == graph->edges[j].from_node_id && edge->to_node_id == graph->edges[j].to_node_id &&
                edge->kind == graph->edges[j].kind) {
                return SWYP_ERR_CORRUPT;
            }
        }
    }
    if (!swyp_device_graph_hierarchy_is_acyclic(graph)) {
        return SWYP_ERR_CORRUPT;
    }
    return SWYP_OK;
}

size_t swyp_device_graph_wire_size(const SwypDeviceGraph *graph) {
    if (graph == NULL) {
        return 0u;
    }
    return SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES +
           (size_t)graph->node_count * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES +
           (size_t)graph->resource_count * SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES +
           (size_t)graph->edge_count * SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES;
}

static void swyp_encode_node(uint8_t *dst, const SwypDeviceNode *node) {
    swyp_zero_bytes(dst, SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES);
    swyp_put_u64(dst + 0u, node->id);
    swyp_put_u64(dst + 8u, node->parent_id);
    swyp_put_u16(dst + 16u, (uint16_t)node->device_class);
    swyp_put_u16(dst + 18u, (uint16_t)node->bus);
    swyp_put_u32(dst + 20u, node->flags);
    swyp_put_u32(dst + 24u, node->vendor_id);
    swyp_put_u32(dst + 28u, node->device_id);
    dst[32] = node->class_code;
    dst[33] = node->subclass;
    dst[34] = node->prog_if;
    dst[35] = node->revision;
    swyp_put_u16(dst + 36u, node->interface_count);
    swyp_put_u32(dst + 40u, node->iommu_group);
    swyp_put_u64(dst + 48u, node->feature_bits);
    swyp_copy_bytes(dst + 56u, (const uint8_t *)node->firmware_version, sizeof(node->firmware_version));
    swyp_copy_bytes(dst + 72u, (const uint8_t *)node->model, 24u);
}

static void swyp_decode_node(SwypDeviceNode *node, const uint8_t *src) {
    swyp_zero_bytes(node, sizeof(*node));
    node->id = swyp_get_u64(src + 0u);
    node->parent_id = swyp_get_u64(src + 8u);
    node->device_class = (SwypDeviceClass)swyp_get_u16(src + 16u);
    node->bus = (SwypDeviceBus)swyp_get_u16(src + 18u);
    node->flags = swyp_get_u32(src + 20u);
    node->vendor_id = swyp_get_u32(src + 24u);
    node->device_id = swyp_get_u32(src + 28u);
    node->class_code = src[32];
    node->subclass = src[33];
    node->prog_if = src[34];
    node->revision = src[35];
    node->interface_count = swyp_get_u16(src + 36u);
    node->iommu_group = swyp_get_u32(src + 40u);
    node->feature_bits = swyp_get_u64(src + 48u);
    swyp_copy_bytes((uint8_t *)node->firmware_version, src + 56u, sizeof(node->firmware_version));
    swyp_copy_bytes((uint8_t *)node->model, src + 72u, 24u);
}

SwypStatus swyp_device_graph_encode(const SwypDeviceGraph *graph, uint8_t *wire, size_t wire_capacity, size_t *wire_size) {
    size_t required;
    size_t offset;
    uint16_t i;
    if (graph == NULL || wire == NULL || wire_size == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_device_graph_validate(graph) != SWYP_OK) {
        return SWYP_ERR_CORRUPT;
    }
    required = swyp_device_graph_wire_size(graph);
    if (required > wire_capacity || required > UINT32_MAX) {
        return SWYP_ERR_NO_SPACE;
    }
    swyp_zero_bytes(wire, required);
    swyp_put_u32(wire + 0u, SWYP_DEVICE_GRAPH_WIRE_MAGIC);
    swyp_put_u16(wire + 4u, SWYP_DEVICE_GRAPH_WIRE_VERSION);
    swyp_put_u16(wire + 6u, SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES);
    swyp_put_u32(wire + 8u, (uint32_t)required);
    swyp_put_u16(wire + 12u, graph->node_count);
    swyp_put_u16(wire + 14u, graph->resource_count);
    swyp_put_u16(wire + 16u, graph->edge_count);
    swyp_put_u16(wire + 18u, 0u);
    swyp_put_u32(wire + 20u, 0u);

    offset = SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES;
    for (i = 0; i < graph->node_count; ++i) {
        swyp_encode_node(wire + offset, &graph->nodes[i]);
        offset += SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES;
    }
    for (i = 0; i < graph->resource_count; ++i) {
        const SwypDeviceResource *resource = &graph->resources[i];
        swyp_put_u64(wire + offset + 0u, resource->node_id);
        swyp_put_u16(wire + offset + 8u, (uint16_t)resource->kind);
        swyp_put_u16(wire + offset + 10u, resource->flags);
        swyp_put_u32(wire + offset + 12u, 0u);
        swyp_put_u64(wire + offset + 16u, resource->start);
        swyp_put_u64(wire + offset + 24u, resource->length);
        swyp_put_u64(wire + offset + 32u, resource->aux);
        offset += SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES;
    }
    for (i = 0; i < graph->edge_count; ++i) {
        const SwypDeviceEdge *edge = &graph->edges[i];
        swyp_put_u64(wire + offset + 0u, edge->from_node_id);
        swyp_put_u64(wire + offset + 8u, edge->to_node_id);
        swyp_put_u16(wire + offset + 16u, (uint16_t)edge->kind);
        swyp_put_u16(wire + offset + 18u, edge->flags);
        swyp_put_u32(wire + offset + 20u, 0u);
        offset += SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES;
    }
    *wire_size = required;
    return SWYP_OK;
}

SwypStatus swyp_device_graph_decode(SwypDeviceGraph *graph, const uint8_t *wire, size_t wire_size) {
    uint16_t node_count;
    uint16_t resource_count;
    uint16_t edge_count;
    uint32_t encoded_size;
    size_t expected;
    size_t offset;
    uint16_t i;
    if (graph == NULL || wire == NULL || wire_size < SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES) {
        return SWYP_ERR_INVALID;
    }
    if (swyp_get_u32(wire + 0u) != SWYP_DEVICE_GRAPH_WIRE_MAGIC ||
        swyp_get_u16(wire + 4u) != SWYP_DEVICE_GRAPH_WIRE_VERSION ||
        swyp_get_u16(wire + 6u) != SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES) {
        return SWYP_ERR_CORRUPT;
    }
    encoded_size = swyp_get_u32(wire + 8u);
    node_count = swyp_get_u16(wire + 12u);
    resource_count = swyp_get_u16(wire + 14u);
    edge_count = swyp_get_u16(wire + 16u);
    if (!swyp_bytes_are_zero(wire + 18u, 6u)) {
        return SWYP_ERR_CORRUPT;
    }
    if (node_count > SWYP_DEVICE_GRAPH_MAX_NODES || resource_count > SWYP_DEVICE_GRAPH_MAX_RESOURCES ||
        edge_count > SWYP_DEVICE_GRAPH_MAX_EDGES) {
        return SWYP_ERR_NO_SPACE;
    }
    expected = SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES +
               (size_t)node_count * SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES +
               (size_t)resource_count * SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES +
               (size_t)edge_count * SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES;
    if (encoded_size != wire_size || expected != wire_size) {
        return SWYP_ERR_CORRUPT;
    }

    swyp_device_graph_init(graph);
    graph->node_count = node_count;
    graph->resource_count = resource_count;
    graph->edge_count = edge_count;
    offset = SWYP_DEVICE_GRAPH_WIRE_HEADER_BYTES;
    for (i = 0; i < node_count; ++i) {
        if (!swyp_bytes_are_zero(wire + offset + 38u, 2u) || !swyp_bytes_are_zero(wire + offset + 44u, 4u) ||
            !swyp_fixed_string_is_canonical(wire + offset + 56u, 16u) ||
            !swyp_fixed_string_is_canonical(wire + offset + 72u, 24u)) {
            return SWYP_ERR_CORRUPT;
        }
        swyp_decode_node(&graph->nodes[i], wire + offset);
        offset += SWYP_DEVICE_GRAPH_WIRE_NODE_BYTES;
    }
    for (i = 0; i < resource_count; ++i) {
        SwypDeviceResource *resource = &graph->resources[i];
        if (!swyp_bytes_are_zero(wire + offset + 12u, 4u)) {
            return SWYP_ERR_CORRUPT;
        }
        resource->node_id = swyp_get_u64(wire + offset + 0u);
        resource->kind = (SwypDeviceResourceKind)swyp_get_u16(wire + offset + 8u);
        resource->flags = swyp_get_u16(wire + offset + 10u);
        resource->reserved0 = 0u;
        resource->start = swyp_get_u64(wire + offset + 16u);
        resource->length = swyp_get_u64(wire + offset + 24u);
        resource->aux = swyp_get_u64(wire + offset + 32u);
        offset += SWYP_DEVICE_GRAPH_WIRE_RESOURCE_BYTES;
    }
    for (i = 0; i < edge_count; ++i) {
        SwypDeviceEdge *edge = &graph->edges[i];
        if (!swyp_bytes_are_zero(wire + offset + 20u, 4u)) {
            return SWYP_ERR_CORRUPT;
        }
        edge->from_node_id = swyp_get_u64(wire + offset + 0u);
        edge->to_node_id = swyp_get_u64(wire + offset + 8u);
        edge->kind = (SwypDeviceEdgeKind)swyp_get_u16(wire + offset + 16u);
        edge->flags = swyp_get_u16(wire + offset + 18u);
        edge->reserved0 = 0u;
        offset += SWYP_DEVICE_GRAPH_WIRE_EDGE_BYTES;
    }
    return swyp_device_graph_validate(graph);
}

SwypStatus swyp_device_resource_capability(const SwypDeviceResource *resource, SwypCapabilityObject *object,
                                            uint64_t *allowed_rights) {
    if (resource == NULL || object == NULL || allowed_rights == NULL || resource->node_id == 0u ||
        resource->reserved0 != 0u || !swyp_resource_range_valid(resource)) {
        return SWYP_ERR_INVALID;
    }
    object->object_id = resource->node_id;
    object->base = resource->start;
    object->length = resource->length;
    object->aux = resource->aux;
    object->reserved0 = 0u;
    switch (resource->kind) {
    case SWYP_DEVICE_RESOURCE_MMIO:
        object->type = SWYP_CAP_OBJECT_MMIO;
        break;
    case SWYP_DEVICE_RESOURCE_PORT_IO:
        object->type = SWYP_CAP_OBJECT_PORT_IO;
        break;
    case SWYP_DEVICE_RESOURCE_IRQ:
        object->type = SWYP_CAP_OBJECT_INTERRUPT;
        break;
    case SWYP_DEVICE_RESOURCE_DMA:
        object->type = SWYP_CAP_OBJECT_DMA;
        break;
    case SWYP_DEVICE_RESOURCE_CONFIG:
        object->type = SWYP_CAP_OBJECT_DEVICE_CONFIG;
        break;
    case SWYP_DEVICE_RESOURCE_CLOCK_RESET_POWER:
        object->type = SWYP_CAP_OBJECT_DEVICE_CONTROL;
        break;
    case SWYP_DEVICE_RESOURCE_SHARED_MEMORY:
        object->type = SWYP_CAP_OBJECT_SHARED_MEMORY;
        break;
    default:
        object->type = SWYP_CAP_OBJECT_INVALID;
        return SWYP_ERR_UNSUPPORTED;
    }
    *allowed_rights = swyp_capability_allowed_rights(object->type);
    return SWYP_OK;
}
