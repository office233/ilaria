    .text
    .extern swyp_x86_trap_dispatch

    .macro SWYP_TRAP_NOERR num
    .globl swyp_x86_exception_\num
swyp_x86_exception_\num:
    pushq $0
    pushq $\num
    jmp swyp_x86_trap_common
    .endm

    .macro SWYP_TRAP_ERR num
    .globl swyp_x86_exception_\num
swyp_x86_exception_\num:
    pushq $\num
    jmp swyp_x86_trap_common
    .endm

SWYP_TRAP_NOERR 0
SWYP_TRAP_NOERR 1
SWYP_TRAP_NOERR 2
SWYP_TRAP_NOERR 3
SWYP_TRAP_NOERR 4
SWYP_TRAP_NOERR 5
SWYP_TRAP_NOERR 6
SWYP_TRAP_NOERR 7
SWYP_TRAP_ERR   8
SWYP_TRAP_NOERR 9
SWYP_TRAP_ERR   10
SWYP_TRAP_ERR   11
SWYP_TRAP_ERR   12
SWYP_TRAP_ERR   13
SWYP_TRAP_ERR   14
SWYP_TRAP_NOERR 15
SWYP_TRAP_NOERR 16
SWYP_TRAP_ERR   17
SWYP_TRAP_NOERR 18
SWYP_TRAP_NOERR 19
SWYP_TRAP_NOERR 20
SWYP_TRAP_ERR   21
SWYP_TRAP_NOERR 22
SWYP_TRAP_NOERR 23
SWYP_TRAP_NOERR 24
SWYP_TRAP_NOERR 25
SWYP_TRAP_NOERR 26
SWYP_TRAP_NOERR 27
SWYP_TRAP_NOERR 28
SWYP_TRAP_ERR   29
SWYP_TRAP_ERR   30
SWYP_TRAP_NOERR 31

swyp_x86_trap_common:
    /* #BP/#OF use trap gates; do not allow timer re-entry during teardown. */
    cli
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

    /* RCX is the normalized frame pointer. R12 is already saved in-frame and
       is nonvolatile in Microsoft x64, so it safely anchors RSP across C. */
    movq %rsp, %r12
    movq %r12, %rcx
    andq $-16, %rsp
    subq $32, %rsp
    call swyp_x86_trap_dispatch
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
    .globl swyp_x86_exception_stub_table
swyp_x86_exception_stub_table:
    .quad swyp_x86_exception_0
    .quad swyp_x86_exception_1
    .quad swyp_x86_exception_2
    .quad swyp_x86_exception_3
    .quad swyp_x86_exception_4
    .quad swyp_x86_exception_5
    .quad swyp_x86_exception_6
    .quad swyp_x86_exception_7
    .quad swyp_x86_exception_8
    .quad swyp_x86_exception_9
    .quad swyp_x86_exception_10
    .quad swyp_x86_exception_11
    .quad swyp_x86_exception_12
    .quad swyp_x86_exception_13
    .quad swyp_x86_exception_14
    .quad swyp_x86_exception_15
    .quad swyp_x86_exception_16
    .quad swyp_x86_exception_17
    .quad swyp_x86_exception_18
    .quad swyp_x86_exception_19
    .quad swyp_x86_exception_20
    .quad swyp_x86_exception_21
    .quad swyp_x86_exception_22
    .quad swyp_x86_exception_23
    .quad swyp_x86_exception_24
    .quad swyp_x86_exception_25
    .quad swyp_x86_exception_26
    .quad swyp_x86_exception_27
    .quad swyp_x86_exception_28
    .quad swyp_x86_exception_29
    .quad swyp_x86_exception_30
    .quad swyp_x86_exception_31

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
