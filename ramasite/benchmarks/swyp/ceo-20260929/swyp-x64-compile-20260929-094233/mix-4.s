.intel_syntax noprefix
.text
.globl swyp_core_mix
swyp_core_mix:
    mov r10, r8
    sub rsp, 40
    call swyp_core_mix_raw
    add rsp, 40
    mov QWORD PTR [r10], rdx
    ret
swyp_core_mix_raw:
    push rbx
    push rsi
    mov rbx, rcx
    mov rsi, rdx
    jmp .Lswyp_b0
.Lswyp_b0:
    add rbx, rsi
    jo .Lswyp_overflow
    mov rsi, 0x0000000000000003
    imul rbx, rsi
    jo .Lswyp_overflow
    mov rsi, 0x0000000000000007
    sub rbx, rsi
    jo .Lswyp_overflow
    mov rax, rbx
    xor edx, edx
    jmp .Lswyp_epilogue
.Lswyp_overflow:
    xor eax, eax
    mov edx, 1
.Lswyp_epilogue:
    pop rsi
    pop rbx
    ret
