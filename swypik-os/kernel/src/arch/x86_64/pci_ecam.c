#include "swypik/arch/x86_64/pci_ecam.h"

#define SWYP_X86_PCI_FUNCTION_MASK UINT64_C(0x7)
#define SWYP_X86_PCI_DEVICE_MASK UINT64_C(0x1f)
#define SWYP_X86_PCI_BUS_MASK UINT64_C(0xff)
#define SWYP_X86_PCI_SEGMENT_MASK UINT64_C(0xffff)
#define SWYP_X86_PCI_AUX_USED_MASK UINT64_C(0xffffffff)

static uint8_t swyp_x86_pci_function(uint64_t aux) {
    return (uint8_t)(aux & SWYP_X86_PCI_FUNCTION_MASK);
}

static uint8_t swyp_x86_pci_device(uint64_t aux) {
    return (uint8_t)((aux >> 3) & SWYP_X86_PCI_DEVICE_MASK);
}

static uint8_t swyp_x86_pci_bus(uint64_t aux) {
    return (uint8_t)((aux >> 8) & SWYP_X86_PCI_BUS_MASK);
}

static uint16_t swyp_x86_pci_segment(uint64_t aux) {
    return (uint16_t)((aux >> 16) & SWYP_X86_PCI_SEGMENT_MASK);
}

static int swyp_x86_pci_width_valid(uint32_t width_bytes) {
    return width_bytes == 1u || width_bytes == 2u || width_bytes == 4u;
}

static const SwypX86PciEcamSegment *swyp_x86_pci_find_segment(const SwypX86PciEcam *pci, uint16_t segment,
                                                               uint8_t bus) {
    uint32_t i;
    for (i = 0; i < pci->segment_count; ++i) {
        const SwypX86PciEcamSegment *candidate = &pci->segments[i];
        if (candidate->segment == segment && bus >= candidate->start_bus && bus <= candidate->end_bus) {
            return candidate;
        }
    }
    return NULL;
}

static SwypStatus swyp_x86_pci_ecam_address(const SwypX86PciEcam *pci, const SwypCapabilityObject *object,
                                             uint64_t absolute_offset, uint64_t *physical_address) {
    const SwypX86PciEcamSegment *segment;
    uint8_t bus;
    uint8_t device;
    uint8_t function;
    uint16_t segment_id;
    uint64_t bus_offset;
    uint64_t device_offset;
    uint64_t function_offset;
    uint64_t address;
    if (pci == NULL || object == NULL || physical_address == NULL || object->type != SWYP_CAP_OBJECT_DEVICE_CONFIG ||
        (object->aux & ~SWYP_X86_PCI_AUX_USED_MASK) != 0u || absolute_offset >= UINT64_C(4096)) {
        return SWYP_ERR_INVALID;
    }
    bus = swyp_x86_pci_bus(object->aux);
    device = swyp_x86_pci_device(object->aux);
    function = swyp_x86_pci_function(object->aux);
    segment_id = swyp_x86_pci_segment(object->aux);
    segment = swyp_x86_pci_find_segment(pci, segment_id, bus);
    if (segment == NULL) {
        return SWYP_ERR_NOT_FOUND;
    }
    bus_offset = (uint64_t)(bus - segment->start_bus) << 20;
    device_offset = (uint64_t)device << 15;
    function_offset = (uint64_t)function << 12;
    if (segment->physical_base > UINT64_MAX - bus_offset ||
        segment->physical_base + bus_offset > UINT64_MAX - device_offset ||
        segment->physical_base + bus_offset + device_offset > UINT64_MAX - function_offset ||
        segment->physical_base + bus_offset + device_offset + function_offset > UINT64_MAX - absolute_offset) {
        return SWYP_ERR_INVALID;
    }
    address = segment->physical_base + bus_offset + device_offset + function_offset + absolute_offset;
    *physical_address = address;
    return SWYP_OK;
}

uint64_t swyp_x86_pci_config_aux(uint16_t segment, uint8_t bus, uint8_t device, uint8_t function) {
    if (device > 31u || function > 7u) {
        return UINT64_MAX;
    }
    return ((uint64_t)segment << 16) | ((uint64_t)bus << 8) | ((uint64_t)device << 3) | function;
}

SwypStatus swyp_x86_pci_ecam_init(SwypX86PciEcam *pci, void *hardware_context,
                                  const SwypX86PciEcamHardwareOps *hardware_ops,
                                  const SwypX86PciEcamSegment *segments, uint32_t segment_count) {
    uint32_t i;
    uint32_t j;
    if (pci == NULL || hardware_ops == NULL || hardware_ops->read32 == NULL || hardware_ops->write32 == NULL ||
        segments == NULL || segment_count == 0u || segment_count > SWYP_X86_PCI_ECAM_SEGMENT_CAPACITY) {
        return SWYP_ERR_INVALID;
    }
    pci->hardware_context = hardware_context;
    pci->hardware_ops = hardware_ops;
    pci->segment_count = segment_count;
    pci->reserved0 = 0u;
    for (i = 0; i < segment_count; ++i) {
        if (segments[i].start_bus > segments[i].end_bus || (segments[i].physical_base & UINT64_C(0xfffff)) != 0u) {
            return SWYP_ERR_INVALID;
        }
        for (j = 0; j < i; ++j) {
            if (segments[i].segment == segments[j].segment && !(segments[i].end_bus < segments[j].start_bus ||
                                                                 segments[j].end_bus < segments[i].start_bus)) {
                return SWYP_ERR_INVALID;
            }
        }
        pci->segments[i] = segments[i];
    }
    for (; i < SWYP_X86_PCI_ECAM_SEGMENT_CAPACITY; ++i) {
        pci->segments[i].segment = 0u;
        pci->segments[i].start_bus = 0u;
        pci->segments[i].end_bus = 0u;
        pci->segments[i].physical_base = 0u;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_pci_ecam_read(SwypX86PciEcam *pci, const SwypCapabilityObject *object,
                                  uint64_t absolute_offset, uint32_t width_bytes, uint64_t *value) {
    uint64_t dword_address;
    uint64_t aligned_offset;
    uint32_t dword;
    uint32_t shift;
    uint32_t mask;
    SwypStatus status;
    if (pci == NULL || value == NULL || !swyp_x86_pci_width_valid(width_bytes) ||
        (absolute_offset & (uint64_t)(width_bytes - 1u)) != 0u || absolute_offset > 4096u - width_bytes) {
        return SWYP_ERR_INVALID;
    }
    aligned_offset = absolute_offset & ~UINT64_C(3);
    status = swyp_x86_pci_ecam_address(pci, object, aligned_offset, &dword_address);
    if (status != SWYP_OK) {
        return status;
    }
    status = pci->hardware_ops->read32(pci->hardware_context, dword_address, &dword);
    if (status != SWYP_OK) {
        return status;
    }
    shift = (uint32_t)(absolute_offset & UINT64_C(3)) * 8u;
    mask = width_bytes == 4u ? UINT32_MAX : ((UINT32_C(1) << (width_bytes * 8u)) - 1u);
    *value = (dword >> shift) & mask;
    return SWYP_OK;
}

SwypStatus swyp_x86_pci_ecam_write(SwypX86PciEcam *pci, const SwypCapabilityObject *object,
                                   uint64_t absolute_offset, uint32_t width_bytes, uint64_t value) {
    uint64_t dword_address;
    uint64_t aligned_offset;
    uint32_t dword;
    uint32_t shift;
    uint32_t mask;
    uint32_t encoded;
    SwypStatus status;
    if (pci == NULL || !swyp_x86_pci_width_valid(width_bytes) ||
        (absolute_offset & (uint64_t)(width_bytes - 1u)) != 0u || absolute_offset > 4096u - width_bytes ||
        (width_bytes < 4u && value >= (UINT64_C(1) << (width_bytes * 8u))) ||
        (width_bytes == 4u && value > UINT32_MAX)) {
        return SWYP_ERR_INVALID;
    }
    aligned_offset = absolute_offset & ~UINT64_C(3);
    status = swyp_x86_pci_ecam_address(pci, object, aligned_offset, &dword_address);
    if (status != SWYP_OK) {
        return status;
    }
    if (width_bytes == 4u) {
        return pci->hardware_ops->write32(pci->hardware_context, dword_address, (uint32_t)value);
    }
    status = pci->hardware_ops->read32(pci->hardware_context, dword_address, &dword);
    if (status != SWYP_OK) {
        return status;
    }
    shift = (uint32_t)(absolute_offset & UINT64_C(3)) * 8u;
    mask = ((UINT32_C(1) << (width_bytes * 8u)) - 1u) << shift;
    encoded = (dword & ~mask) | (((uint32_t)value << shift) & mask);
    return pci->hardware_ops->write32(pci->hardware_context, dword_address, encoded);
}
