    .text
    .extern swyp_x86_lapic_timer_dispatch

    .globl swyp_x86_lapic_timer_entry
swyp_x86_lapic_timer_entry:
    pushq $0
    pushq $224
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
    call swyp_x86_lapic_timer_dispatch
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

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
