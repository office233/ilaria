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
    sub rsp, 32
    mov rcx, r12
    call swyp_core_step_raw
    test rdx, rdx
    jne .Lswyp_iterate_overflow
    mov rdi, rax
    add rsp, 32
    mov r12, 0x0000000000000001
    add rsi, r12
    jo .Lswyp_iterate_overflow
    push rdi
    pop r12
    jmp .Lswyp_iterate_b1
.Lswyp_iterate_b3:
    mov rax, r12
    xor edx, edx
    jmp .Lswyp_iterate_epilogue
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

.intel_syntax noprefix
.text
.globl swyp_core_step
swyp_core_step:
    mov r10, rdx
    sub rsp, 40
    mov QWORD PTR [rsp+32], r10
    call swyp_core_step_raw
    mov r10, QWORD PTR [rsp+32]
    add rsp, 40
    mov QWORD PTR [r10], rdx
    ret
swyp_core_step_raw:
    push rbp
    push rbx
    push rsi
    mov rbp, rsp
    mov rbx, rcx
    jmp .Lswyp_step_b0
.Lswyp_step_b0:
    mov rsi, 0x0000000000000000
    cmp rbx, rsi
    mov rsi, 0
    setl sil
    cmp rsi, 0
    je .Lswyp_step_edge_b0_false
    jmp .Lswyp_step_b1
.Lswyp_step_edge_b0_false:
    jmp .Lswyp_step_b2
.Lswyp_step_b1:
    mov rsi, 0x0000000000000001
    add rbx, rsi
    jo .Lswyp_step_overflow
    mov rax, rbx
    xor edx, edx
    jmp .Lswyp_step_epilogue
.Lswyp_step_b2:
    jmp .Lswyp_step_b3
.Lswyp_step_b3:
    mov rsi, 0x0000000000000000
    cmp rbx, rsi
    mov rsi, 0
    sete sil
    cmp rsi, 0
    je .Lswyp_step_edge_b3_false
    jmp .Lswyp_step_b4
.Lswyp_step_edge_b3_false:
    jmp .Lswyp_step_b5
.Lswyp_step_b4:
    mov rbx, 0x0000000000000001
    mov rax, rbx
    xor edx, edx
    jmp .Lswyp_step_epilogue
.Lswyp_step_b5:
    jmp .Lswyp_step_b6
.Lswyp_step_b6:
    mov rsi, 0x0000000000000001
    add rbx, rsi
    jo .Lswyp_step_overflow
    mov rax, rbx
    xor edx, edx
    jmp .Lswyp_step_epilogue
.Lswyp_step_overflow:
    xor eax, eax
    mov edx, 1
.Lswyp_step_epilogue:
    mov rsp, rbp
    pop rsi
    pop rbx
    pop rbp
    ret

