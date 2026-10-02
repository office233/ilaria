#ifndef SWYPIK_ARCH_X86_64_USER_MODE_H
#define SWYPIK_ARCH_X86_64_USER_MODE_H

#include "swypik/arch/x86_64/address_space.h"
#include "swypik/arch/x86_64/context.h"
#include "swypik/arch/x86_64/privilege.h"
#include "swypik/arch/x86_64/trap.h"

#define SWYP_X86_RFLAGS_FIXED UINT64_C(0x2)
#define SWYP_X86_RFLAGS_IF (UINT64_C(1) << 9)
#define SWYP_X86_RFLAGS_IOPL_MASK (UINT64_C(3) << 12)
#define SWYP_X86_RFLAGS_NT (UINT64_C(1) << 14)
#define SWYP_X86_RFLAGS_RF (UINT64_C(1) << 16)
#define SWYP_X86_RFLAGS_VM (UINT64_C(1) << 17)
#define SWYP_X86_RFLAGS_AC (UINT64_C(1) << 18)
#define SWYP_X86_RFLAGS_VIF (UINT64_C(1) << 19)
#define SWYP_X86_RFLAGS_VIP (UINT64_C(1) << 20)
#define SWYP_X86_CONTEXT_CAPTURED_USER (UINT64_C(1) << 0)

typedef struct SwypX86UserLaunch {
    SwypX86_64ThreadContext context;
    uint16_t code_selector;
    uint16_t data_selector;
    uint32_t reserved0;
} SwypX86UserLaunch;

SwypStatus swyp_x86_user_launch_prepare(const SwypThreadContext *thread_context, SwypX86UserLaunch *launch);
SwypStatus swyp_x86_user_launch_prepare_interruptible(const SwypThreadContext *thread_context,
                                                      int interrupts_enabled, SwypX86UserLaunch *launch);
SwypStatus swyp_x86_user_launch_validate(const SwypX86UserLaunch *launch);
SwypStatus swyp_x86_user_resume_prepare(const SwypThreadContext *thread_context, int interrupts_enabled,
                                        SwypX86UserLaunch *launch);
SwypStatus swyp_x86_user_context_capture_trap(SwypThreadContext *thread_context, const SwypX86TrapFrame *frame);
SwypStatus swyp_x86_user_context_capture_fault(SwypThreadContext *thread_context, const SwypX86TrapFrame *frame);

void SWYP_X86_NATIVE_ABI swyp_x86_enter_user(const SwypX86UserLaunch *launch) __attribute__((noreturn));

#endif
