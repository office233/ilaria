#ifndef SWYPIK_KERNEL_SCHEDULER_H
#define SWYPIK_KERNEL_SCHEDULER_H

#include "swypik/kernel/contracts.h"

#define SWYP_SCHEDULER_THREAD_CAPACITY 64u
#define SWYP_SCHEDULER_NO_THREAD UINT32_MAX

typedef enum SwypSchedulerThreadKind {
    SWYP_SCHEDULER_THREAD_INVALID = 0,
    SWYP_SCHEDULER_THREAD_KERNEL = 1,
    SWYP_SCHEDULER_THREAD_DRIVER = 2
} SwypSchedulerThreadKind;

typedef enum SwypSchedulerThreadState {
    SWYP_SCHEDULER_STATE_FREE = 0,
    SWYP_SCHEDULER_STATE_READY = 1,
    SWYP_SCHEDULER_STATE_RUNNING = 2,
    SWYP_SCHEDULER_STATE_BLOCKED = 3,
    SWYP_SCHEDULER_STATE_STOPPED = 4
} SwypSchedulerThreadState;

typedef struct SwypSchedulerThread {
    uint64_t id;
    uint64_t domain_id;
    uint64_t lease_fence;
    SwypSchedulerThreadKind kind;
    SwypSchedulerThreadState state;
    uint32_t quantum_ticks;
    uint32_t remaining_ticks;
    SwypThreadContext context;
} SwypSchedulerThread;

typedef struct SwypSchedulerAddressOps {
    SwypStatus (*activate_kernel)(void *context);
    SwypStatus (*activate_driver)(void *context, uint64_t domain_id, uint64_t lease_fence);
} SwypSchedulerAddressOps;

typedef struct SwypScheduler {
    void *address_context;
    const SwypSchedulerAddressOps *address_ops;
    SwypSchedulerThread threads[SWYP_SCHEDULER_THREAD_CAPACITY];
    uint32_t current_index;
    uint32_t scan_cursor;
    uint32_t default_quantum_ticks;
    uint32_t reserved0;
    uint64_t tick_count;
} SwypScheduler;

void swyp_scheduler_init(SwypScheduler *scheduler, void *address_context, const SwypSchedulerAddressOps *address_ops);
SwypStatus swyp_scheduler_add_thread(SwypScheduler *scheduler, uint64_t thread_id, SwypSchedulerThreadKind kind,
                                     uint64_t domain_id, uint64_t lease_fence,
                                     const SwypThreadContext *initial_context);
SwypStatus swyp_scheduler_dispatch(SwypScheduler *scheduler, uint64_t *thread_id);
SwypStatus swyp_scheduler_block(SwypScheduler *scheduler, uint64_t thread_id);
SwypStatus swyp_scheduler_make_ready(SwypScheduler *scheduler, uint64_t thread_id);
SwypStatus swyp_scheduler_stop(SwypScheduler *scheduler, uint64_t thread_id);
SwypStatus swyp_scheduler_remove(SwypScheduler *scheduler, uint64_t thread_id);
SwypStatus swyp_scheduler_stop_driver_epoch(SwypScheduler *scheduler, uint64_t domain_id, uint64_t lease_fence,
                                             int *running_thread_stopped);
SwypStatus swyp_scheduler_repatriate_kernel(SwypScheduler *scheduler);
SwypStatus swyp_scheduler_yield_current(SwypScheduler *scheduler);
SwypStatus swyp_scheduler_remove_driver_epoch(SwypScheduler *scheduler, uint64_t domain_id, uint64_t lease_fence,
                                              uint32_t *removed_count);
const SwypSchedulerThread *swyp_scheduler_thread(const SwypScheduler *scheduler, uint64_t thread_id);
const SwypSchedulerThread *swyp_scheduler_current(const SwypScheduler *scheduler);
SwypStatus swyp_scheduler_update_current_context(SwypScheduler *scheduler, const SwypThreadContext *context);
SwypStatus swyp_scheduler_set_default_quantum(SwypScheduler *scheduler, uint32_t quantum_ticks);
SwypStatus swyp_scheduler_set_thread_quantum(SwypScheduler *scheduler, uint64_t thread_id, uint32_t quantum_ticks);
SwypStatus swyp_scheduler_tick(SwypScheduler *scheduler, int *preempt_requested);

#endif
