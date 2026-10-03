#ifndef SWYPIK_ARCH_X86_64_TIMER_H
#define SWYPIK_ARCH_X86_64_TIMER_H

#include "swypik/arch/x86_64/privilege.h"
#include "swypik/arch/x86_64/trap.h"

#define SWYP_X86_TIMER_VECTOR 224u

typedef struct SwypX86LapicTimerHardwareOps {
    SwypStatus (*lapic_write)(void *context, uint32_t offset, uint32_t value);
    uint64_t (*read_tsc)(void *context);
    SwypStatus (*write_tsc_deadline)(void *context, uint64_t deadline);
} SwypX86LapicTimerHardwareOps;

typedef enum SwypX86LapicTimerMode {
    SWYP_X86_LAPIC_TIMER_COUNT_PERIODIC = 1,
    SWYP_X86_LAPIC_TIMER_TSC_DEADLINE = 2
} SwypX86LapicTimerMode;

typedef SwypStatus (*SwypX86TimerTickHandler)(void *context, SwypX86TrapFrame *frame, int *resume_user);

typedef struct SwypX86LapicTimer {
    void *hardware_context;
    const SwypX86LapicTimerHardwareOps *hardware_ops;
    void *tick_context;
    SwypX86TimerTickHandler tick_handler;
    SwypX86LapicTimerMode mode;
    uint32_t initial_count;
    uint32_t divide_config;
    uint64_t deadline_ticks;
    uint32_t initialized;
    uint32_t armed;
} SwypX86LapicTimer;

SwypStatus swyp_x86_lapic_timer_init(SwypX86LapicTimer *timer, void *hardware_context,
                                     const SwypX86LapicTimerHardwareOps *hardware_ops, uint32_t initial_count,
                                     uint32_t divide_config, void *tick_context, SwypX86TimerTickHandler tick_handler);
SwypStatus swyp_x86_lapic_timer_init_tsc_deadline(SwypX86LapicTimer *timer, void *hardware_context,
                                                  const SwypX86LapicTimerHardwareOps *hardware_ops,
                                                  uint64_t deadline_ticks, void *tick_context,
                                                  SwypX86TimerTickHandler tick_handler);
SwypStatus swyp_x86_lapic_timer_install_idt(SwypX86PrivilegeState *privilege);
SwypStatus swyp_x86_lapic_timer_bind(SwypX86LapicTimer *timer);
SwypStatus swyp_x86_lapic_timer_arm_periodic(SwypX86LapicTimer *timer);
SwypStatus swyp_x86_lapic_timer_disarm(SwypX86LapicTimer *timer);
void SWYP_X86_NATIVE_ABI swyp_x86_lapic_timer_dispatch(SwypX86TrapFrame *frame);
void swyp_x86_lapic_timer_entry(void);

#endif
