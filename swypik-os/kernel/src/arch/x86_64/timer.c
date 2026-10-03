#include "swypik/arch/x86_64/timer.h"

#define SWYP_X86_LAPIC_EOI 0x0b0u
#define SWYP_X86_LAPIC_LVT_TIMER 0x320u
#define SWYP_X86_LAPIC_INITIAL_COUNT 0x380u
#define SWYP_X86_LAPIC_DIVIDE_CONFIG 0x3e0u
#define SWYP_X86_LAPIC_TIMER_MASK (UINT32_C(1) << 16)
#define SWYP_X86_LAPIC_TIMER_PERIODIC (UINT32_C(1) << 17)
#define SWYP_X86_LAPIC_TIMER_TSC_DEADLINE (UINT32_C(2) << 17)

static SwypX86LapicTimer *swyp_x86_active_lapic_timer;

SwypStatus swyp_x86_lapic_timer_init(SwypX86LapicTimer *timer, void *hardware_context,
                                     const SwypX86LapicTimerHardwareOps *hardware_ops, uint32_t initial_count,
                                     uint32_t divide_config, void *tick_context, SwypX86TimerTickHandler tick_handler) {
    if (timer == NULL || hardware_ops == NULL || hardware_ops->lapic_write == NULL || initial_count == 0u) {
        return SWYP_ERR_INVALID;
    }
    timer->hardware_context = hardware_context;
    timer->hardware_ops = hardware_ops;
    timer->tick_context = tick_context;
    timer->tick_handler = tick_handler;
    timer->mode = SWYP_X86_LAPIC_TIMER_COUNT_PERIODIC;
    timer->initial_count = initial_count;
    timer->divide_config = divide_config;
    timer->deadline_ticks = 0u;
    timer->initialized = 1u;
    timer->armed = 0u;
    return SWYP_OK;
}

SwypStatus swyp_x86_lapic_timer_init_tsc_deadline(SwypX86LapicTimer *timer, void *hardware_context,
                                                  const SwypX86LapicTimerHardwareOps *hardware_ops,
                                                  uint64_t deadline_ticks, void *tick_context,
                                                  SwypX86TimerTickHandler tick_handler) {
    if (timer == NULL || hardware_ops == NULL || hardware_ops->lapic_write == NULL ||
        hardware_ops->read_tsc == NULL || hardware_ops->write_tsc_deadline == NULL || deadline_ticks == 0u) {
        return SWYP_ERR_INVALID;
    }
    timer->hardware_context = hardware_context;
    timer->hardware_ops = hardware_ops;
    timer->tick_context = tick_context;
    timer->tick_handler = tick_handler;
    timer->mode = SWYP_X86_LAPIC_TIMER_TSC_DEADLINE;
    timer->initial_count = 0u;
    timer->divide_config = 0u;
    timer->deadline_ticks = deadline_ticks;
    timer->initialized = 1u;
    timer->armed = 0u;
    return SWYP_OK;
}

SwypStatus swyp_x86_lapic_timer_install_idt(SwypX86PrivilegeState *privilege) {
    if (privilege == NULL || privilege->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    return swyp_x86_privilege_set_idt_gate(privilege, SWYP_X86_TIMER_VECTOR,
                                            (uint64_t)(uintptr_t)&swyp_x86_lapic_timer_entry, 0u, 0u,
                                            SWYP_X86_IDT_GATE_INTERRUPT);
}

SwypStatus swyp_x86_lapic_timer_bind(SwypX86LapicTimer *timer) {
    if (timer == NULL || timer->initialized == 0u || timer->tick_handler == NULL) {
        return SWYP_ERR_INVALID;
    }
    swyp_x86_active_lapic_timer = timer;
    return SWYP_OK;
}

SwypStatus swyp_x86_lapic_timer_arm_periodic(SwypX86LapicTimer *timer) {
    SwypStatus status;
    if (timer == NULL || timer->initialized == 0u || timer->armed != 0u) {
        return SWYP_ERR_INVALID;
    }
    if (timer->mode == SWYP_X86_LAPIC_TIMER_COUNT_PERIODIC) {
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_DIVIDE_CONFIG,
                                                   timer->divide_config);
        if (status != SWYP_OK) {
            return status;
        }
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_LVT_TIMER,
                                                   SWYP_X86_TIMER_VECTOR | SWYP_X86_LAPIC_TIMER_PERIODIC |
                                                       SWYP_X86_LAPIC_TIMER_MASK);
        if (status != SWYP_OK) {
            return status;
        }
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_INITIAL_COUNT,
                                                   timer->initial_count);
        if (status != SWYP_OK) {
            return status;
        }
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_LVT_TIMER,
                                                   SWYP_X86_TIMER_VECTOR | SWYP_X86_LAPIC_TIMER_PERIODIC);
        if (status != SWYP_OK) {
            return status;
        }
    } else if (timer->mode == SWYP_X86_LAPIC_TIMER_TSC_DEADLINE) {
        uint64_t now;
        if (timer->hardware_ops->read_tsc == NULL || timer->hardware_ops->write_tsc_deadline == NULL ||
            timer->deadline_ticks == 0u) {
            return SWYP_ERR_INVALID;
        }
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_LVT_TIMER,
                                                   SWYP_X86_TIMER_VECTOR | SWYP_X86_LAPIC_TIMER_TSC_DEADLINE);
        if (status != SWYP_OK) {
            return status;
        }
        now = timer->hardware_ops->read_tsc(timer->hardware_context);
        if (UINT64_MAX - now < timer->deadline_ticks) {
            return SWYP_ERR_CORRUPT;
        }
        status = timer->hardware_ops->write_tsc_deadline(timer->hardware_context, now + timer->deadline_ticks);
        if (status != SWYP_OK) {
            return status;
        }
    } else {
        return SWYP_ERR_INVALID;
    }
    timer->armed = 1u;
    return SWYP_OK;
}

SwypStatus swyp_x86_lapic_timer_disarm(SwypX86LapicTimer *timer) {
    SwypStatus status;
    if (timer == NULL || timer->initialized == 0u) {
        return SWYP_ERR_INVALID;
    }
    if (timer->mode == SWYP_X86_LAPIC_TIMER_TSC_DEADLINE) {
        if (timer->hardware_ops->write_tsc_deadline == NULL) {
            return SWYP_ERR_INVALID;
        }
        status = timer->hardware_ops->write_tsc_deadline(timer->hardware_context, 0u);
        if (status != SWYP_OK) {
            return status;
        }
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_LVT_TIMER,
                                                   SWYP_X86_TIMER_VECTOR | SWYP_X86_LAPIC_TIMER_TSC_DEADLINE |
                                                       SWYP_X86_LAPIC_TIMER_MASK);
    } else {
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_INITIAL_COUNT, 0u);
        if (status != SWYP_OK) {
            return status;
        }
        status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_LVT_TIMER,
                                                   SWYP_X86_TIMER_VECTOR | SWYP_X86_LAPIC_TIMER_PERIODIC |
                                                       SWYP_X86_LAPIC_TIMER_MASK);
    }
    if (status == SWYP_OK) {
        timer->armed = 0u;
    }
    return status;
}

void SWYP_X86_NATIVE_ABI swyp_x86_lapic_timer_dispatch(SwypX86TrapFrame *frame) {
    SwypX86LapicTimer *timer = swyp_x86_active_lapic_timer;
    int resume_user = 1;
    SwypStatus status;
    if (timer == NULL || timer->initialized == 0u || timer->armed == 0u || frame == NULL ||
        frame->vector != SWYP_X86_TIMER_VECTOR || frame->error_code != 0u) {
        swyp_x86_emergency_halt_stub();
    }
    status = timer->hardware_ops->lapic_write(timer->hardware_context, SWYP_X86_LAPIC_EOI, 0u);
    if (status != SWYP_OK) {
        swyp_x86_emergency_halt_stub();
    }
    status = timer->tick_handler(timer->tick_context, frame, &resume_user);
    if (status != SWYP_OK) {
        swyp_x86_emergency_halt_stub();
    }
    if (!resume_user) {
        swyp_x86_emergency_halt_stub();
    }
    if (timer->mode == SWYP_X86_LAPIC_TIMER_TSC_DEADLINE) {
        uint64_t now = timer->hardware_ops->read_tsc(timer->hardware_context);
        if (UINT64_MAX - now < timer->deadline_ticks ||
            timer->hardware_ops->write_tsc_deadline(timer->hardware_context, now + timer->deadline_ticks) != SWYP_OK) {
            swyp_x86_emergency_halt_stub();
        }
    }
}
