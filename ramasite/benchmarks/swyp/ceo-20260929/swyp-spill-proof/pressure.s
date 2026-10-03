.intel_syntax noprefix
.text
.globl swyp_core_pressure
swyp_core_pressure:
    mov r10, [rsp+40]
    sub rsp, 40
    call swyp_core_pressure_raw
    add rsp, 40
    mov QWORD PTR [r10], rdx
    ret
swyp_core_pressure_raw:
    push rbp
    push rbx
    push rsi
    push rdi
    push r12
    push r13
    push r14
    push r15
    mov rbp, rsp
    sub rsp, 48
    mov r15, rcx
    mov QWORD PTR [rbp-8], rdx
    mov r13, r8
    mov rbx, r9
    jmp .Lswyp_b0
.Lswyp_b0:
    mov rsi, 0x0000000000000001
    add rsi, r15
    jo .Lswyp_overflow
    mov rdi, 0x0000000000000002
    mov r10, QWORD PTR [rbp-8]
    add rdi, r10
    jo .Lswyp_overflow
    mov r12, 0x0000000000000003
    add r12, r13
    jo .Lswyp_overflow
    mov r14, 0x0000000000000004
    add r14, rbx
    jo .Lswyp_overflow
    mov rax, 0x0000000000000005
    mov QWORD PTR [rbp-24], rax
    mov r11, QWORD PTR [rbp-24]
    add r15, r11
    jo .Lswyp_overflow
    mov rax, 0x0000000000000006
    mov QWORD PTR [rbp-32], rax
    mov r10, QWORD PTR [rbp-8]
    mov r11, QWORD PTR [rbp-32]
    mov rax, r10
    add rax, r11
    jo .Lswyp_overflow
    mov QWORD PTR [rbp-16], rax
    mov rax, 0x0000000000000007
    mov QWORD PTR [rbp-40], rax
    mov r11, QWORD PTR [rbp-40]
    add r13, r11
    jo .Lswyp_overflow
    mov rax, 0x0000000000000008
    mov QWORD PTR [rbp-48], rax
    mov r11, QWORD PTR [rbp-48]
    add rbx, r11
    jo .Lswyp_overflow
    add rsi, rdi
    jo .Lswyp_overflow
    mov rdi, r12
    add rdi, r14
    jo .Lswyp_overflow
    mov r11, QWORD PTR [rbp-16]
    mov r12, r15
    add r12, r11
    jo .Lswyp_overflow
    add rbx, r13
    jo .Lswyp_overflow
    add rsi, rdi
    jo .Lswyp_overflow
    add rbx, r12
    jo .Lswyp_overflow
    add rbx, rsi
    jo .Lswyp_overflow
    mov rax, rbx
    xor edx, edx
    jmp .Lswyp_epilogue
.Lswyp_overflow:
    xor eax, eax
    mov edx, 1
.Lswyp_epilogue:
    mov rsp, rbp
    pop r15
    pop r14
    pop r13
    pop r12
    pop rdi
    pop rsi
    pop rbx
    pop rbp
    ret
