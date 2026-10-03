#include "swypik/arch/x86_64/vtd_mmio.h"

static int swyp_vtd_mmio_range(const SwypX86VtdMmio *mmio, uint32_t offset, uint32_t width) {
    return mmio != NULL && mmio->base != NULL && width != 0u && offset <= mmio->length && width <= mmio->length - offset;
}

static SwypStatus swyp_vtd_mmio_read32(void *context, uint32_t offset, uint32_t *value) {
    SwypX86VtdMmio *mmio = (SwypX86VtdMmio *)context;
    if (value == NULL || (offset & 3u) != 0u || !swyp_vtd_mmio_range(mmio, offset, 4u)) {
        return SWYP_ERR_INVALID;
    }
    *value = *(volatile uint32_t *)(void *)(mmio->base + offset);
    return SWYP_OK;
}

static SwypStatus swyp_vtd_mmio_write32(void *context, uint32_t offset, uint32_t value) {
    SwypX86VtdMmio *mmio = (SwypX86VtdMmio *)context;
    if ((offset & 3u) != 0u || !swyp_vtd_mmio_range(mmio, offset, 4u)) {
        return SWYP_ERR_INVALID;
    }
    *(volatile uint32_t *)(void *)(mmio->base + offset) = value;
    __asm__ volatile("" : : : "memory");
    return SWYP_OK;
}

static SwypStatus swyp_vtd_mmio_read64(void *context, uint32_t offset, uint64_t *value) {
    SwypX86VtdMmio *mmio = (SwypX86VtdMmio *)context;
    if (value == NULL || (offset & 7u) != 0u || !swyp_vtd_mmio_range(mmio, offset, 8u)) {
        return SWYP_ERR_INVALID;
    }
    *value = *(volatile uint64_t *)(void *)(mmio->base + offset);
    return SWYP_OK;
}

static SwypStatus swyp_vtd_mmio_write64(void *context, uint32_t offset, uint64_t value) {
    SwypX86VtdMmio *mmio = (SwypX86VtdMmio *)context;
    if ((offset & 7u) != 0u || !swyp_vtd_mmio_range(mmio, offset, 8u)) {
        return SWYP_ERR_INVALID;
    }
    *(volatile uint64_t *)(void *)(mmio->base + offset) = value;
    __asm__ volatile("" : : : "memory");
    return SWYP_OK;
}

static const SwypX86VtdRegisterOps swyp_vtd_mmio_ops_value = {
    .read32 = swyp_vtd_mmio_read32,
    .write32 = swyp_vtd_mmio_write32,
    .read64 = swyp_vtd_mmio_read64,
    .write64 = swyp_vtd_mmio_write64,
};

SwypStatus swyp_x86_vtd_mmio_init(SwypX86VtdMmio *mmio, volatile void *base, uint32_t length) {
    if (mmio == NULL || base == NULL || length < 0x1000u || ((uintptr_t)base & 7u) != 0u) {
        return SWYP_ERR_INVALID;
    }
    mmio->base = (volatile uint8_t *)base;
    mmio->length = length;
    mmio->reserved0 = 0u;
    return SWYP_OK;
}

const SwypX86VtdRegisterOps *swyp_x86_vtd_mmio_ops(void) {
    return &swyp_vtd_mmio_ops_value;
}
