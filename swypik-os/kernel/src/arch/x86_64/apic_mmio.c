#include "swypik/arch/x86_64/apic_mmio.h"

#define SWYP_X86_IOAPIC_IOREGSEL 0x00u
#define SWYP_X86_IOAPIC_IOWIN 0x10u

static void swyp_x86_mmio_fence(void) {
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
}

static SwypStatus swyp_x86_apic_mmio_ioapic_read(void *context, uint32_t reg, uint32_t *value) {
    SwypX86ApicMmio *mmio = (SwypX86ApicMmio *)context;
    volatile uint32_t *selector;
    volatile uint32_t *window;
    if (mmio == NULL || mmio->ioapic_base == NULL || value == NULL || reg > 255u) {
        return SWYP_ERR_INVALID;
    }
    selector = (volatile uint32_t *)(mmio->ioapic_base + SWYP_X86_IOAPIC_IOREGSEL);
    window = (volatile uint32_t *)(mmio->ioapic_base + SWYP_X86_IOAPIC_IOWIN);
    *selector = reg;
    swyp_x86_mmio_fence();
    *value = *window;
    swyp_x86_mmio_fence();
    return SWYP_OK;
}

static SwypStatus swyp_x86_apic_mmio_ioapic_write(void *context, uint32_t reg, uint32_t value) {
    SwypX86ApicMmio *mmio = (SwypX86ApicMmio *)context;
    volatile uint32_t *selector;
    volatile uint32_t *window;
    if (mmio == NULL || mmio->ioapic_base == NULL || reg > 255u) {
        return SWYP_ERR_INVALID;
    }
    selector = (volatile uint32_t *)(mmio->ioapic_base + SWYP_X86_IOAPIC_IOREGSEL);
    window = (volatile uint32_t *)(mmio->ioapic_base + SWYP_X86_IOAPIC_IOWIN);
    *selector = reg;
    swyp_x86_mmio_fence();
    *window = value;
    swyp_x86_mmio_fence();
    return SWYP_OK;
}

static SwypStatus swyp_x86_apic_mmio_lapic_write(void *context, uint32_t offset, uint32_t value) {
    SwypX86ApicMmio *mmio = (SwypX86ApicMmio *)context;
    volatile uint32_t *reg;
    if (mmio == NULL || mmio->lapic_base == NULL || offset >= 4096u || (offset & 3u) != 0u) {
        return SWYP_ERR_INVALID;
    }
    reg = (volatile uint32_t *)(mmio->lapic_base + offset);
    *reg = value;
    swyp_x86_mmio_fence();
    return SWYP_OK;
}

static const SwypX86ApicHardwareOps swyp_x86_apic_mmio_hardware_ops = {
    .ioapic_read = swyp_x86_apic_mmio_ioapic_read,
    .ioapic_write = swyp_x86_apic_mmio_ioapic_write,
    .lapic_write = swyp_x86_apic_mmio_lapic_write,
};

SwypStatus swyp_x86_apic_mmio_init(SwypX86ApicMmio *mmio, volatile void *lapic_base, volatile void *ioapic_base) {
    if (mmio == NULL || lapic_base == NULL || ioapic_base == NULL ||
        (((uintptr_t)lapic_base | (uintptr_t)ioapic_base) & UINT64_C(0xfff)) != 0u) {
        return SWYP_ERR_INVALID;
    }
    mmio->lapic_base = (volatile uint8_t *)lapic_base;
    mmio->ioapic_base = (volatile uint8_t *)ioapic_base;
    return SWYP_OK;
}

const SwypX86ApicHardwareOps *swyp_x86_apic_mmio_ops(void) {
    return &swyp_x86_apic_mmio_hardware_ops;
}
