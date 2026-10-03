.intel_syntax noprefix
.text
.globl swyp_core_iterate
swyp_core_iterate:
    mov r10, rdx
    sub rsp, 40
    mov QWORD PTR [rsp+32], r10
    call swyp_core_iterate_raw
    mov r10, QWORD PTR [rsp+32]
    add rsp, 40
    mov QWORD PTR [r10], rdx
    ret
swyp_core_iterate_raw:
    push rbp
    push rbx
    push rsi
    push rdi
    push r12
    mov rbp, rsp
    mov rbx, rcx
    jmp .Lswyp_iterate_b0
.Lswyp_iterate_b0:
    mov rsi, 0x0000000000000000
    mov rdi, 0x0000000000000000
    push rdi
    pop r12
    jmp .Lswyp_iterate_b1
.Lswyp_iterate_b1:
    cmp rsi, rbx
    mov rdi, 0
    setl dil
    cmp rdi, 0
    je .Lswyp_iterate_edge_b1_false
    jmp .Lswyp_iterate_b2
.Lswyp_iterate_edge_b1_false:
    jmp .Lswyp_iterate_b3
.Lswyp_iterate_b2:
    mov rdi, r12
    jmp .Lswyp_iterate_b4
.Lswyp_iterate_b3:
    mov rax, r12
    xor edx, edx
    jmp .Lswyp_iterate_epilogue
.Lswyp_iterate_b4:
    mov r12, 0x0000000000000000
    cmp rdi, r12
    mov r12, 0
    setl r12b
    cmp r12, 0
    je .Lswyp_iterate_edge_b4_false
    jmp .Lswyp_iterate_b5
.Lswyp_iterate_edge_b4_false:
    jmp .Lswyp_iterate_b6
.Lswyp_iterate_b5:
    mov r12, 0x0000000000000001
    add rdi, r12
    jo .Lswyp_iterate_overflow
    jmp .Lswyp_iterate_b8
.Lswyp_iterate_b6:
    jmp .Lswyp_iterate_b7
.Lswyp_iterate_b7:
    mov r12, 0x0000000000000001
    add rdi, r12
    jo .Lswyp_iterate_overflow
    jmp .Lswyp_iterate_b8
.Lswyp_iterate_b8:
    mov r12, 0x0000000000000001
    add rsi, r12
    jo .Lswyp_iterate_overflow
    push rdi
    pop r12
    jmp .Lswyp_iterate_b1
.Lswyp_iterate_overflow:
    xor eax, eax
    mov edx, 1
.Lswyp_iterate_epilogue:
    mov rsp, rbp
    pop r12
    pop rdi
    pop rsi
    pop rbx
    pop rbp
    ret

