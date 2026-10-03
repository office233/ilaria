#include "swypik/arch/x86_64/pci_ecam_mmio.h"

static void swyp_x86_pci_mmio_fence(void) {
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
}

static volatile uint32_t *swyp_x86_pci_ecam_pointer(SwypX86PciEcamMmio *mmio, uint64_t physical_address) {
    const SwypX86AddressSpaceHardwareOps *ops;
    void *pointer;
    if (mmio == NULL || mmio->mmu == NULL || (physical_address & UINT64_C(3)) != 0u) {
        return NULL;
    }
    ops = swyp_x86_native_mmu_ops();
    if (ops == NULL || ops->physical_to_virtual == NULL) {
        return NULL;
    }
    pointer = ops->physical_to_virtual(mmio->mmu, physical_address);
    return (volatile uint32_t *)pointer;
}

static SwypStatus swyp_x86_pci_ecam_mmio_read32(void *context, uint64_t physical_address, uint32_t *value) {
    volatile uint32_t *pointer = swyp_x86_pci_ecam_pointer((SwypX86PciEcamMmio *)context, physical_address);
    if (pointer == NULL || value == NULL) {
        return SWYP_ERR_INVALID;
    }
    *value = *pointer;
    swyp_x86_pci_mmio_fence();
    return SWYP_OK;
}

static SwypStatus swyp_x86_pci_ecam_mmio_write32(void *context, uint64_t physical_address, uint32_t value) {
    volatile uint32_t *pointer = swyp_x86_pci_ecam_pointer((SwypX86PciEcamMmio *)context, physical_address);
    if (pointer == NULL) {
        return SWYP_ERR_INVALID;
    }
    *pointer = value;
    swyp_x86_pci_mmio_fence();
    return SWYP_OK;
}

static const SwypX86PciEcamHardwareOps swyp_x86_pci_ecam_mmio_ops_value = {
    .read32 = swyp_x86_pci_ecam_mmio_read32,
    .write32 = swyp_x86_pci_ecam_mmio_write32,
};

SwypStatus swyp_x86_pci_ecam_mmio_init(SwypX86PciEcamMmio *mmio, SwypX86NativeMmu *native_mmu) {
    if (mmio == NULL || native_mmu == NULL) {
        return SWYP_ERR_INVALID;
    }
    mmio->mmu = native_mmu;
    return SWYP_OK;
}

const SwypX86PciEcamHardwareOps *swyp_x86_pci_ecam_mmio_ops(void) {
    return &swyp_x86_pci_ecam_mmio_ops_value;
}
