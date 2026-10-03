#ifndef SWYPIK_ARCH_X86_64_PRIVILEGE_H
#define SWYPIK_ARCH_X86_64_PRIVILEGE_H

#include "swypik/kernel/abi.h"

#define SWYP_X86_GDT_ENTRY_COUNT 7u
#define SWYP_X86_IDT_ENTRY_COUNT 256u

#define SWYP_X86_SELECTOR_KERNEL_CODE UINT16_C(0x08)
#define SWYP_X86_SELECTOR_KERNEL_DATA UINT16_C(0x10)
#define SWYP_X86_SELECTOR_USER_DATA UINT16_C(0x1b)
#define SWYP_X86_SELECTOR_USER_CODE UINT16_C(0x23)
#define SWYP_X86_SELECTOR_TSS UINT16_C(0x28)

typedef enum SwypX86IdtGateType {
    SWYP_X86_IDT_GATE_INTERRUPT = 0x0e,
    SWYP_X86_IDT_GATE_TRAP = 0x0f
} SwypX86IdtGateType;

typedef struct __attribute__((packed)) SwypX86DescriptorPointer {
    uint16_t limit;
    uint64_t base;
} SwypX86DescriptorPointer;

typedef struct __attribute__((packed)) SwypX86TaskStateSegment {
    uint32_t reserved0;
    uint64_t rsp0;
    uint64_t rsp1;
    uint64_t rsp2;
    uint64_t reserved1;
    uint64_t ist1;
    uint64_t ist2;
    uint64_t ist3;
    uint64_t ist4;
    uint64_t ist5;
    uint64_t ist6;
    uint64_t ist7;
    uint64_t reserved2;
    uint16_t reserved3;
    uint16_t io_map_base;
} SwypX86TaskStateSegment;

typedef struct __attribute__((packed)) SwypX86IdtGate {
    uint16_t offset_low;
    uint16_t selector;
    uint8_t ist;
    uint8_t type_attributes;
    uint16_t offset_middle;
    uint32_t offset_high;
    uint32_t reserved0;
} SwypX86IdtGate;

typedef struct SwypX86PrivilegeState {
    uint64_t gdt[SWYP_X86_GDT_ENTRY_COUNT];
    SwypX86TaskStateSegment tss;
    SwypX86DescriptorPointer gdtr;
    SwypX86IdtGate idt[SWYP_X86_IDT_ENTRY_COUNT];
    SwypX86DescriptorPointer idtr;
    uint32_t initialized;
    uint32_t reserved0;
} SwypX86PrivilegeState;

_Static_assert(sizeof(SwypX86DescriptorPointer) == 10u, "x86 descriptor pointer must be 10 bytes");
_Static_assert(sizeof(SwypX86TaskStateSegment) == 104u, "x86_64 TSS must be 104 bytes");
_Static_assert(sizeof(SwypX86IdtGate) == 16u, "x86_64 IDT gate must be 16 bytes");

SwypStatus swyp_x86_privilege_init(SwypX86PrivilegeState *state, uint64_t rsp0);
SwypStatus swyp_x86_privilege_set_rsp0(SwypX86PrivilegeState *state, uint64_t rsp0);
SwypStatus swyp_x86_privilege_set_ist(SwypX86PrivilegeState *state, uint32_t ist_index, uint64_t stack_top);
SwypStatus swyp_x86_privilege_set_idt_gate(SwypX86PrivilegeState *state, uint32_t vector, uint64_t handler,
                                           uint32_t ist_index, uint32_t dpl, SwypX86IdtGateType type);
SwypStatus swyp_x86_privilege_clear_idt_gate(SwypX86PrivilegeState *state, uint32_t vector);
SwypStatus swyp_x86_privilege_validate(const SwypX86PrivilegeState *state);
uint64_t swyp_x86_privilege_idt_handler(const SwypX86PrivilegeState *state, uint32_t vector);
SwypStatus swyp_x86_privilege_install_emergency_idt(SwypX86PrivilegeState *state, uint64_t handler,
                                                    uint32_t ist_index);

#if defined(__GNUC__) && defined(__x86_64__)
#define SWYP_X86_NATIVE_ABI __attribute__((ms_abi))
#else
#define SWYP_X86_NATIVE_ABI
#endif

void SWYP_X86_NATIVE_ABI swyp_x86_privilege_load_gdt_tss(const SwypX86DescriptorPointer *gdtr,
                                                          uint16_t tss_selector);
void SWYP_X86_NATIVE_ABI swyp_x86_privilege_load_idt(const SwypX86DescriptorPointer *idtr);
void SWYP_X86_NATIVE_ABI swyp_x86_emergency_halt_stub(void) __attribute__((noreturn));

#endif
