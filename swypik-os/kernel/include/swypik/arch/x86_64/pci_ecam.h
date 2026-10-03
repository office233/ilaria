#ifndef SWYPIK_ARCH_X86_64_PCI_ECAM_H
#define SWYPIK_ARCH_X86_64_PCI_ECAM_H

#include "swypik/kernel/capability.h"

#define SWYP_X86_PCI_ECAM_SEGMENT_CAPACITY 8u

typedef struct SwypX86PciEcamHardwareOps {
    SwypStatus (*read32)(void *context, uint64_t physical_address, uint32_t *value);
    SwypStatus (*write32)(void *context, uint64_t physical_address, uint32_t value);
} SwypX86PciEcamHardwareOps;

typedef struct SwypX86PciEcamSegment {
    uint16_t segment;
    uint8_t start_bus;
    uint8_t end_bus;
    uint64_t physical_base;
} SwypX86PciEcamSegment;

typedef struct SwypX86PciEcam {
    void *hardware_context;
    const SwypX86PciEcamHardwareOps *hardware_ops;
    uint32_t segment_count;
    uint32_t reserved0;
    SwypX86PciEcamSegment segments[SWYP_X86_PCI_ECAM_SEGMENT_CAPACITY];
} SwypX86PciEcam;

uint64_t swyp_x86_pci_config_aux(uint16_t segment, uint8_t bus, uint8_t device, uint8_t function);
SwypStatus swyp_x86_pci_ecam_init(SwypX86PciEcam *pci, void *hardware_context,
                                  const SwypX86PciEcamHardwareOps *hardware_ops,
                                  const SwypX86PciEcamSegment *segments, uint32_t segment_count);
SwypStatus swyp_x86_pci_ecam_read(SwypX86PciEcam *pci, const SwypCapabilityObject *object,
                                  uint64_t absolute_offset, uint32_t width_bytes, uint64_t *value);
SwypStatus swyp_x86_pci_ecam_write(SwypX86PciEcam *pci, const SwypCapabilityObject *object,
                                   uint64_t absolute_offset, uint32_t width_bytes, uint64_t value);

#endif
