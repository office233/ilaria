#include "swypik/arch/x86_64/privilege.h"

#include <stdint.h>

#define SWYP_X86_GDT_KERNEL_CODE UINT64_C(0x00af9a000000ffff)
#define SWYP_X86_GDT_KERNEL_DATA UINT64_C(0x00cf92000000ffff)
#define SWYP_X86_GDT_USER_DATA UINT64_C(0x00cff2000000ffff)
#define SWYP_X86_GDT_USER_CODE UINT64_C(0x00affa000000ffff)
/* The CPU sets a segment descriptor's accessed bit when it loads a selector
   that references it, so a live GDT may legitimately carry it. */
#define SWYP_X86_GDT_ACCESSED UINT64_C(0x0000010000000000)

static int swyp_x86_privilege_segment_matches(uint64_t actual, uint64_t expected) {
    return (actual | SWYP_X86_GDT_ACCESSED) == (expected | SWYP_X86_GDT_ACCESSED);
}

static int swyp_x86_privilege_canonical(uint64_t address) {
    return address <= UINT64_C(0x00007fffffffffff) || address >= UINT64_C(0xffff800000000000);
}

static int swyp_x86_privilege_stack_valid(uint64_t stack_top) {
    return stack_top != 0u && swyp_x86_privilege_canonical(stack_top) && (stack_top & UINT64_C(0xf)) == 0u;
}

static void swyp_x86_privilege_zero(void *pointer, uint64_t bytes) {
    uint8_t *out = (uint8_t *)pointer;
    uint64_t i;
    for (i = 0u; i < bytes; ++i) {
        out[i] = 0u;
    }
}

static void swyp_x86_privilege_encode_tss_descriptor(SwypX86PrivilegeState *state) {
    uint64_t base = (uint64_t)(uintptr_t)&state->tss;
    uint32_t limit = (uint32_t)sizeof(state->tss) - 1u;
    uint64_t low = 0u;
    uint64_t high = 0u;

    low |= (uint64_t)(limit & 0xffffu);
    low |= (base & UINT64_C(0x00ffffff)) << 16;
    low |= UINT64_C(0x89) << 40;
    low |= (uint64_t)((limit >> 16) & 0x0fu) << 48;
    low |= ((base >> 24) & UINT64_C(0xff)) << 56;
    high |= (base >> 32) & UINT64_C(0xffffffff);
    state->gdt[5] = low;
    state->gdt[6] = high;
}

static uint64_t swyp_x86_privilege_decode_tss_base(const SwypX86PrivilegeState *state) {
    uint64_t low = state->gdt[5];
    uint64_t high = state->gdt[6];
    uint64_t base = (low >> 16) & UINT64_C(0x00ffffff);
    base |= ((low >> 56) & UINT64_C(0xff)) << 24;
    base |= (high & UINT64_C(0xffffffff)) << 32;
    return base;
}

static uint32_t swyp_x86_privilege_decode_tss_limit(const SwypX86PrivilegeState *state) {
    uint64_t low = state->gdt[5];
    return (uint32_t)((low & UINT64_C(0xffff)) | (((low >> 48) & UINT64_C(0x0f)) << 16));
}

static void swyp_x86_privilege_refresh_tables(SwypX86PrivilegeState *state) {
    state->gdtr.limit = (uint16_t)(sizeof(state->gdt) - 1u);
    state->gdtr.base = (uint64_t)(uintptr_t)&state->gdt[0];
    state->idtr.limit = (uint16_t)(sizeof(state->idt) - 1u);
    state->idtr.base = (uint64_t)(uintptr_t)&state->idt[0];
    swyp_x86_privilege_encode_tss_descriptor(state);
}

SwypStatus swyp_x86_privilege_init(SwypX86PrivilegeState *state, uint64_t rsp0) {
    if (state == NULL || !swyp_x86_privilege_stack_valid(rsp0)) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_privilege_zero(state, sizeof(*state));
    state->gdt[0] = 0u;
    state->gdt[1] = SWYP_X86_GDT_KERNEL_CODE;
    state->gdt[2] = SWYP_X86_GDT_KERNEL_DATA;
    state->gdt[3] = SWYP_X86_GDT_USER_DATA;
    state->gdt[4] = SWYP_X86_GDT_USER_CODE;
    state->tss.rsp0 = rsp0;
    state->tss.io_map_base = (uint16_t)sizeof(state->tss);
    swyp_x86_privilege_refresh_tables(state);
    state->initialized = 1u;
    return swyp_x86_privilege_validate(state);
}

SwypStatus swyp_x86_privilege_set_rsp0(SwypX86PrivilegeState *state, uint64_t rsp0) {
    if (state == NULL || state->initialized == 0u || !swyp_x86_privilege_stack_valid(rsp0)) {
        return SWYP_ERR_INVALID;
    }
    state->tss.rsp0 = rsp0;
    return SWYP_OK;
}

SwypStatus swyp_x86_privilege_set_ist(SwypX86PrivilegeState *state, uint32_t ist_index, uint64_t stack_top) {
    if (state == NULL || state->initialized == 0u || ist_index == 0u || ist_index > 7u ||
        !swyp_x86_privilege_stack_valid(stack_top)) {
        return SWYP_ERR_INVALID;
    }
    switch (ist_index) {
    case 1u:
        state->tss.ist1 = stack_top;
        break;
    case 2u:
        state->tss.ist2 = stack_top;
        break;
    case 3u:
        state->tss.ist3 = stack_top;
        break;
    case 4u:
        state->tss.ist4 = stack_top;
        break;
    case 5u:
        state->tss.ist5 = stack_top;
        break;
    case 6u:
        state->tss.ist6 = stack_top;
        break;
    case 7u:
        state->tss.ist7 = stack_top;
        break;
    default:
        return SWYP_ERR_INVALID;
    }
    return SWYP_OK;
}

SwypStatus swyp_x86_privilege_set_idt_gate(SwypX86PrivilegeState *state, uint32_t vector, uint64_t handler,
                                           uint32_t ist_index, uint32_t dpl, SwypX86IdtGateType type) {
    SwypX86IdtGate *gate;
    if (state == NULL || state->initialized == 0u || vector >= SWYP_X86_IDT_ENTRY_COUNT || handler == 0u ||
        !swyp_x86_privilege_canonical(handler) || ist_index > 7u || dpl > 3u ||
        (type != SWYP_X86_IDT_GATE_INTERRUPT && type != SWYP_X86_IDT_GATE_TRAP)) {
        return SWYP_ERR_INVALID;
    }
    gate = &state->idt[vector];
    gate->offset_low = (uint16_t)(handler & UINT64_C(0xffff));
    gate->selector = SWYP_X86_SELECTOR_KERNEL_CODE;
    gate->ist = (uint8_t)(ist_index & 0x7u);
    gate->type_attributes = (uint8_t)(0x80u | ((dpl & 0x3u) << 5) | ((uint32_t)type & 0x0fu));
    gate->offset_middle = (uint16_t)((handler >> 16) & UINT64_C(0xffff));
    gate->offset_high = (uint32_t)(handler >> 32);
    gate->reserved0 = 0u;
    return SWYP_OK;
}

SwypStatus swyp_x86_privilege_clear_idt_gate(SwypX86PrivilegeState *state, uint32_t vector) {
    if (state == NULL || state->initialized == 0u || vector >= SWYP_X86_IDT_ENTRY_COUNT) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_privilege_zero(&state->idt[vector], sizeof(state->idt[vector]));
    return SWYP_OK;
}

SwypStatus swyp_x86_privilege_install_emergency_idt(SwypX86PrivilegeState *state, uint64_t handler,
                                                    uint32_t ist_index) {
    uint32_t vector;
    if (state == NULL || state->initialized == 0u || handler == 0u || !swyp_x86_privilege_canonical(handler) ||
        ist_index == 0u || ist_index > 7u) {
        return SWYP_ERR_INVALID;
    }
    for (vector = 0u; vector < SWYP_X86_IDT_ENTRY_COUNT; ++vector) {
        SwypStatus status = swyp_x86_privilege_set_idt_gate(state, vector, handler, ist_index, 0u,
                                                            SWYP_X86_IDT_GATE_INTERRUPT);
        if (status != SWYP_OK) {
            return status;
        }
    }
    return swyp_x86_privilege_validate(state);
}

uint64_t swyp_x86_privilege_idt_handler(const SwypX86PrivilegeState *state, uint32_t vector) {
    const SwypX86IdtGate *gate;
    uint64_t handler;
    if (state == NULL || state->initialized == 0u || vector >= SWYP_X86_IDT_ENTRY_COUNT) {
        return 0u;
    }
    gate = &state->idt[vector];
    if ((gate->type_attributes & 0x80u) == 0u) {
        return 0u;
    }
    handler = gate->offset_low;
    handler |= (uint64_t)gate->offset_middle << 16;
    handler |= (uint64_t)gate->offset_high << 32;
    return handler;
}

SwypStatus swyp_x86_privilege_validate(const SwypX86PrivilegeState *state) {
    uint32_t i;
    if (state == NULL || state->initialized == 0u || state->gdt[0] != 0u ||
        !swyp_x86_privilege_segment_matches(state->gdt[1], SWYP_X86_GDT_KERNEL_CODE) ||
        !swyp_x86_privilege_segment_matches(state->gdt[2], SWYP_X86_GDT_KERNEL_DATA) ||
        !swyp_x86_privilege_segment_matches(state->gdt[3], SWYP_X86_GDT_USER_DATA) ||
        !swyp_x86_privilege_segment_matches(state->gdt[4], SWYP_X86_GDT_USER_CODE) ||
        state->gdtr.limit != sizeof(state->gdt) - 1u || state->gdtr.base != (uint64_t)(uintptr_t)&state->gdt[0] ||
        state->idtr.limit != sizeof(state->idt) - 1u || state->idtr.base != (uint64_t)(uintptr_t)&state->idt[0] ||
        swyp_x86_privilege_decode_tss_base(state) != (uint64_t)(uintptr_t)&state->tss ||
        swyp_x86_privilege_decode_tss_limit(state) != sizeof(state->tss) - 1u ||
        /* LTR marks the loaded TSS busy (type 0x9 -> 0xB). Both encode a present
           64-bit TSS, so validation must accept either after the task register
           is loaded; any other type is still rejected. */
        ((state->gdt[5] >> 40) & UINT64_C(0xfd)) != UINT64_C(0x89) ||
        !swyp_x86_privilege_stack_valid(state->tss.rsp0) || state->tss.io_map_base != sizeof(state->tss)) {
        return SWYP_ERR_CORRUPT;
    }
    for (i = 0u; i < SWYP_X86_IDT_ENTRY_COUNT; ++i) {
        const SwypX86IdtGate *gate = &state->idt[i];
        if ((gate->type_attributes & 0x80u) == 0u) {
            continue;
        }
        if (gate->selector != SWYP_X86_SELECTOR_KERNEL_CODE || gate->reserved0 != 0u || (gate->ist & ~0x7u) != 0u ||
            swyp_x86_privilege_idt_handler(state, i) == 0u) {
            return SWYP_ERR_CORRUPT;
        }
    }
    return SWYP_OK;
}
