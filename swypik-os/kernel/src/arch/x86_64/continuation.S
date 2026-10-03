    .text
    .globl swyp_x86_kernel_continuation_capture
#ifdef _WIN32
    .def swyp_x86_kernel_continuation_capture; .scl 2; .type 32; .endef
#endif
swyp_x86_kernel_continuation_capture:
    testq %rcx, %rcx
    jz .Lcapture_invalid
    movq %rbx, 0(%rcx)
    movq %rbp, 8(%rcx)
    movq %rdi, 16(%rcx)
    movq %rsi, 24(%rcx)
    movq %r12, 32(%rcx)
    movq %r13, 40(%rcx)
    movq %r14, 48(%rcx)
    movq %r15, 56(%rcx)
    leaq 8(%rsp), %rax
    movq %rax, 64(%rcx)
    movq (%rsp), %rax
    movq %rax, 72(%rcx)
    xorl %eax, %eax
    ret
.Lcapture_invalid:
    movq $-1, %rax
    ret

    .globl swyp_x86_kernel_continuation_resume
#ifdef _WIN32
    .def swyp_x86_kernel_continuation_resume; .scl 2; .type 32; .endef
#endif
swyp_x86_kernel_continuation_resume:
    testq %rcx, %rcx
    jz .Lresume_halt
    movq %rcx, %r10
    movq %rdx, %r11
    movq 0(%r10), %rbx
    movq 8(%r10), %rbp
    movq 16(%r10), %rdi
    movq 24(%r10), %rsi
    movq 32(%r10), %r12
    movq 40(%r10), %r13
    movq 48(%r10), %r14
    movq 56(%r10), %r15
    movq 64(%r10), %rsp
    movq %r11, %rax
    jmp *72(%r10)
.Lresume_halt:
    cli
.Lresume_loop:
    hlt
    jmp .Lresume_loop

#ifndef _WIN32
    .section .note.GNU-stack,"",@progbits
#endif
