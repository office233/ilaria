    .text
    .globl swyp_uefi_takeover_switch
swyp_uefi_takeover_switch:
    /* Microsoft x64 ABI (UEFI):
       rcx=root, rdx=stack_top, r8=continuation, r9=context. */
    cli
    movq %rcx, %rax
    movq %r8, %r10
    movq %r9, %r11
    movq %rax, %cr3

    /* The firmware stack may be unmapped by the new root. Do not touch it
       after CR3 publication; move immediately to the reserved identity stack. */
    movq %rdx, %rsp
    andq $-16, %rsp
    xorq %rbp, %rbp

    /* 32-byte Microsoft x64 shadow store. RSP is 16-byte aligned before CALL. */
    subq $32, %rsp
    movq %r11, %rcx
    call *%r10

1:
    cli
    hlt
    jmp 1b

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
