    .text
    .extern swyp_x86_irq_dispatch

    .macro SWYP_IRQ_STUB num
    .globl swyp_x86_irq_\num
swyp_x86_irq_\num:
    pushq $0
    pushq $\num
    jmp swyp_x86_irq_common
    .endm

    .altmacro
    .set swyp_irq_vec, 64
    .rept 160
    .if swyp_irq_vec != 128
    SWYP_IRQ_STUB %swyp_irq_vec
    .endif
    .set swyp_irq_vec, swyp_irq_vec + 1
    .endr

swyp_x86_irq_common:
    cld
    pushq %r15
    pushq %r14
    pushq %r13
    pushq %r12
    pushq %r11
    pushq %r10
    pushq %r9
    pushq %r8
    pushq %rdi
    pushq %rsi
    pushq %rbp
    pushq %rbx
    pushq %rdx
    pushq %rcx
    pushq %rax
    movq %rsp, %r12
    movq %r12, %rcx
    andq $-16, %rsp
    subq $32, %rsp
    call swyp_x86_irq_dispatch
    movq %r12, %rsp
    popq %rax
    popq %rcx
    popq %rdx
    popq %rbx
    popq %rbp
    popq %rsi
    popq %rdi
    popq %r8
    popq %r9
    popq %r10
    popq %r11
    popq %r12
    popq %r13
    popq %r14
    popq %r15
    addq $16, %rsp
    iretq

#ifdef _WIN32
    .section .rdata,"dr"
#else
    .section .rodata,"a",@progbits
#endif
    .p2align 3
    .globl swyp_x86_irq_stub_table
swyp_x86_irq_stub_table:
    .macro SWYP_IRQ_PTR num
    .if \num == 128
    .quad 0
    .else
    .quad swyp_x86_irq_\num
    .endif
    .endm
    .set swyp_irq_ptr_vec, 64
    .rept 160
    SWYP_IRQ_PTR %swyp_irq_ptr_vec
    .set swyp_irq_ptr_vec, swyp_irq_ptr_vec + 1
    .endr

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
