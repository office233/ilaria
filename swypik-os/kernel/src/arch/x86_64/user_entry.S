    .text
    .globl swyp_x86_enter_user
#ifdef _WIN32
    .def swyp_x86_enter_user; .scl 2; .type 32; .endef
#endif
swyp_x86_enter_user:
    /* ms_abi: RCX = const SwypX86UserLaunch *.  Offsets follow
       SwypX86_64ThreadContext (20 qwords), then selectors. */
    movq %rcx, %r10

    /* Build the privilege-return frame while still on the kernel stack. */
    movzwq 162(%r10), %rax       /* data_selector */
    pushq %rax                   /* SS */
    pushq 56(%r10)               /* RSP */
    pushq 136(%r10)              /* RFLAGS */
    movzwq 160(%r10), %rax       /* code_selector */
    pushq %rax                   /* CS */
    pushq 128(%r10)              /* RIP */

    /* Restore GPRs last. R10 is restored after all context reads. */
    movq 0(%r10), %rax
    movq 8(%r10), %rbx
    movq 16(%r10), %rcx
    movq 24(%r10), %rdx
    movq 32(%r10), %rsi
    movq 40(%r10), %rdi
    movq 48(%r10), %rbp
    movq 64(%r10), %r8
    movq 72(%r10), %r9
    movq 88(%r10), %r11
    movq 96(%r10), %r12
    movq 104(%r10), %r13
    movq 112(%r10), %r14
    movq 120(%r10), %r15
    movq 80(%r10), %r10
    iretq

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
