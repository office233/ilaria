    .text
    .globl swyp_x86_privilege_load_gdt_tss
swyp_x86_privilege_load_gdt_tss:
    /* Microsoft x64 ABI: rcx=GDTR pointer, rdx=TSS selector. */
    lgdt (%rcx)

    movw $0x10, %ax
    movw %ax, %ds
    movw %ax, %es
    movw %ax, %ss

    pushq $0x08
    leaq 1f(%rip), %rax
    pushq %rax
    lretq
1:
    xor %eax, %eax
    movw %ax, %fs
    movw %ax, %gs
    movw %dx, %ax
    ltr %ax
    ret

    .globl swyp_x86_privilege_load_idt
swyp_x86_privilege_load_idt:
    lidt (%rcx)
    ret

    .globl swyp_x86_emergency_halt_stub
swyp_x86_emergency_halt_stub:
    cli
2:
    hlt
    jmp 2b

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
