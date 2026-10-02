#ifndef SWYPIK_ARCH_X86_64_PCI_ECAM_MMIO_H
#define SWYPIK_ARCH_X86_64_PCI_ECAM_MMIO_H

#include "swypik/arch/x86_64/native_mmu.h"
#include "swypik/arch/x86_64/pci_ecam.h"

typedef struct SwypX86PciEcamMmio {
    SwypX86NativeMmu *mmu;
} SwypX86PciEcamMmio;

SwypStatus swyp_x86_pci_ecam_mmio_init(SwypX86PciEcamMmio *mmio, SwypX86NativeMmu *native_mmu);
const SwypX86PciEcamHardwareOps *swyp_x86_pci_ecam_mmio_ops(void);

#endif
