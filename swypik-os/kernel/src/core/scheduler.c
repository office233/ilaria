#include "swypik/kernel/scheduler.h"

static void swyp_scheduler_thread_clear(SwypSchedulerThread *thread) {
    uint32_t i;
    if (thread == NULL) {
        return;
    }
    thread->id = 0u;
    thread->domain_id = 0u;
    thread->lease_fence = 0u;
    thread->kind = SWYP_SCHEDULER_THREAD_INVALID;
    thread->state = SWYP_SCHEDULER_STATE_FREE;
    thread->quantum_ticks = 0u;
    thread->remaining_ticks = 0u;
    thread->context.abi_version = 0u;
    thread->context.struct_size = 0u;
    thread->context.arch = SWYP_ARCH_UNKNOWN;
    thread->context.used_bytes = 0u;
    thread->context.flags = 0u;
    for (i = 0u; i < SWYP_THREAD_CONTEXT_STORAGE_BYTES; ++i) {
        thread->context.storage[i] = 0u;
    }
}

static int swyp_scheduler_context_valid(const SwypThreadContext *context) {
    return context != NULL && context->abi_version == SWYP_KERNEL_ABI_VERSION &&
           context->struct_size == sizeof(*context) && context->arch != SWYP_ARCH_UNKNOWN &&
           context->used_bytes <= SWYP_THREAD_CONTEXT_STORAGE_BYTES;
}

static SwypSchedulerThread *swyp_scheduler_find(SwypScheduler *scheduler, uint64_t thread_id, uint32_t *index) {
    uint32_t i;
    if (scheduler == NULL || thread_id == 0u) {
        return NULL;
    }
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        if (scheduler->threads[i].state != SWYP_SCHEDULER_STATE_FREE && scheduler->threads[i].id == thread_id) {
            if (index != NULL) {
                *index = i;
            }
            return &scheduler->threads[i];
        }
    }
    return NULL;
}

static const SwypSchedulerThread *swyp_scheduler_find_const(const SwypScheduler *scheduler, uint64_t thread_id) {
    uint32_t i;
    if (scheduler == NULL || thread_id == 0u) {
        return NULL;
    }
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        if (scheduler->threads[i].state != SWYP_SCHEDULER_STATE_FREE && scheduler->threads[i].id == thread_id) {
            return &scheduler->threads[i];
        }
    }
    return NULL;
}

static uint32_t swyp_scheduler_next_ready(const SwypScheduler *scheduler) {
    uint32_t offset;
    for (offset = 0u; offset < SWYP_SCHEDULER_THREAD_CAPACITY; ++offset) {
        uint32_t index = (scheduler->scan_cursor + offset) % SWYP_SCHEDULER_THREAD_CAPACITY;
        if (scheduler->threads[index].state == SWYP_SCHEDULER_STATE_READY) {
            return index;
        }
    }
    return SWYP_SCHEDULER_NO_THREAD;
}

static SwypStatus swyp_scheduler_activate(const SwypScheduler *scheduler, const SwypSchedulerThread *thread) {
    if (scheduler == NULL || scheduler->address_ops == NULL || thread == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (thread->kind == SWYP_SCHEDULER_THREAD_KERNEL) {
        if (scheduler->address_ops->activate_kernel == NULL) {
            return SWYP_ERR_UNSUPPORTED;
        }
        return scheduler->address_ops->activate_kernel(scheduler->address_context);
    }
    if (thread->kind == SWYP_SCHEDULER_THREAD_DRIVER) {
        if (scheduler->address_ops->activate_driver == NULL || thread->domain_id == 0u || thread->lease_fence == 0u) {
            return SWYP_ERR_INVALID;
        }
        return scheduler->address_ops->activate_driver(scheduler->address_context, thread->domain_id,
                                                       thread->lease_fence);
    }
    return SWYP_ERR_INVALID;
}

void swyp_scheduler_init(SwypScheduler *scheduler, void *address_context, const SwypSchedulerAddressOps *address_ops) {
    uint32_t i;
    if (scheduler == NULL) {
        return;
    }
    scheduler->address_context = address_context;
    scheduler->address_ops = address_ops;
    scheduler->current_index = SWYP_SCHEDULER_NO_THREAD;
    scheduler->scan_cursor = 0u;
    scheduler->default_quantum_ticks = 1u;
    scheduler->reserved0 = 0u;
    scheduler->tick_count = 0u;
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        swyp_scheduler_thread_clear(&scheduler->threads[i]);
    }
}

SwypStatus swyp_scheduler_add_thread(SwypScheduler *scheduler, uint64_t thread_id, SwypSchedulerThreadKind kind,
                                     uint64_t domain_id, uint64_t lease_fence,
                                     const SwypThreadContext *initial_context) {
    uint32_t i;
    if (scheduler == NULL || scheduler->address_ops == NULL || thread_id == 0u ||
        !swyp_scheduler_context_valid(initial_context) || swyp_scheduler_find(scheduler, thread_id, NULL) != NULL) {
        return SWYP_ERR_INVALID;
    }
    if ((kind == SWYP_SCHEDULER_THREAD_KERNEL && (domain_id != 0u || lease_fence != 0u)) ||
        (kind == SWYP_SCHEDULER_THREAD_DRIVER && (domain_id == 0u || lease_fence == 0u)) ||
        (kind != SWYP_SCHEDULER_THREAD_KERNEL && kind != SWYP_SCHEDULER_THREAD_DRIVER)) {
        return SWYP_ERR_INVALID;
    }
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        SwypSchedulerThread *thread = &scheduler->threads[i];
        if (thread->state == SWYP_SCHEDULER_STATE_FREE) {
            thread->id = thread_id;
            thread->domain_id = domain_id;
            thread->lease_fence = lease_fence;
            thread->kind = kind;
            thread->state = SWYP_SCHEDULER_STATE_READY;
            thread->quantum_ticks = scheduler->default_quantum_ticks;
            thread->remaining_ticks = scheduler->default_quantum_ticks;
            thread->context = *initial_context;
            return SWYP_OK;
        }
    }
    return SWYP_ERR_NO_SPACE;
}

SwypStatus swyp_scheduler_dispatch(SwypScheduler *scheduler, uint64_t *thread_id) {
    uint32_t next;
    uint32_t previous;
    SwypSchedulerThread *next_thread;
    SwypStatus status;
    if (scheduler == NULL || thread_id == NULL || scheduler->address_ops == NULL) {
        return SWYP_ERR_INVALID;
    }
    *thread_id = 0u;
    next = swyp_scheduler_next_ready(scheduler);
    if (next == SWYP_SCHEDULER_NO_THREAD) {
        if (scheduler->current_index != SWYP_SCHEDULER_NO_THREAD &&
            scheduler->threads[scheduler->current_index].state == SWYP_SCHEDULER_STATE_RUNNING) {
            *thread_id = scheduler->threads[scheduler->current_index].id;
            return SWYP_OK;
        }
        return SWYP_ERR_NOT_FOUND;
    }
    next_thread = &scheduler->threads[next];
    status = swyp_scheduler_activate(scheduler, next_thread);
    if (status != SWYP_OK) {
        return status;
    }
    previous = scheduler->current_index;
    if (previous != SWYP_SCHEDULER_NO_THREAD && scheduler->threads[previous].state == SWYP_SCHEDULER_STATE_RUNNING) {
        scheduler->threads[previous].state = SWYP_SCHEDULER_STATE_READY;
    }
    next_thread->state = SWYP_SCHEDULER_STATE_RUNNING;
    if (next_thread->remaining_ticks == 0u) {
        next_thread->remaining_ticks = next_thread->quantum_ticks;
    }
    scheduler->current_index = next;
    scheduler->scan_cursor = (next + 1u) % SWYP_SCHEDULER_THREAD_CAPACITY;
    *thread_id = next_thread->id;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_block(SwypScheduler *scheduler, uint64_t thread_id) {
    SwypSchedulerThread *thread = swyp_scheduler_find(scheduler, thread_id, NULL);
    if (thread == NULL || (thread->state != SWYP_SCHEDULER_STATE_READY &&
                           thread->state != SWYP_SCHEDULER_STATE_RUNNING)) {
        return SWYP_ERR_INVALID;
    }
    thread->state = SWYP_SCHEDULER_STATE_BLOCKED;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_make_ready(SwypScheduler *scheduler, uint64_t thread_id) {
    SwypSchedulerThread *thread = swyp_scheduler_find(scheduler, thread_id, NULL);
    if (thread == NULL || thread->state != SWYP_SCHEDULER_STATE_BLOCKED) {
        return SWYP_ERR_INVALID;
    }
    thread->state = SWYP_SCHEDULER_STATE_READY;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_stop(SwypScheduler *scheduler, uint64_t thread_id) {
    SwypSchedulerThread *thread = swyp_scheduler_find(scheduler, thread_id, NULL);
    if (thread == NULL || thread->state == SWYP_SCHEDULER_STATE_STOPPED) {
        return SWYP_ERR_INVALID;
    }
    thread->state = SWYP_SCHEDULER_STATE_STOPPED;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_remove(SwypScheduler *scheduler, uint64_t thread_id) {
    uint32_t index;
    SwypSchedulerThread *thread = swyp_scheduler_find(scheduler, thread_id, &index);
    if (thread == NULL || thread->state != SWYP_SCHEDULER_STATE_STOPPED || index == scheduler->current_index) {
        return SWYP_ERR_DENIED;
    }
    swyp_scheduler_thread_clear(thread);
    return SWYP_OK;
}

SwypStatus swyp_scheduler_stop_driver_epoch(SwypScheduler *scheduler, uint64_t domain_id, uint64_t lease_fence,
                                             int *running_thread_stopped) {
    uint32_t i;
    int found = 0;
    if (scheduler == NULL || domain_id == 0u || lease_fence == 0u || running_thread_stopped == NULL) {
        return SWYP_ERR_INVALID;
    }
    *running_thread_stopped = 0;
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        SwypSchedulerThread *thread = &scheduler->threads[i];
        if (thread->state == SWYP_SCHEDULER_STATE_FREE || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER ||
            thread->domain_id != domain_id || thread->lease_fence != lease_fence) {
            continue;
        }
        found = 1;
        if (i == scheduler->current_index && thread->state == SWYP_SCHEDULER_STATE_RUNNING) {
            *running_thread_stopped = 1;
        }
        thread->state = SWYP_SCHEDULER_STATE_STOPPED;
    }
    return found ? SWYP_OK : SWYP_ERR_NOT_FOUND;
}

SwypStatus swyp_scheduler_repatriate_kernel(SwypScheduler *scheduler) {
    SwypStatus status;
    if (scheduler == NULL || scheduler->address_ops == NULL || scheduler->address_ops->activate_kernel == NULL) {
        return SWYP_ERR_INVALID;
    }
    if (scheduler->current_index != SWYP_SCHEDULER_NO_THREAD) {
        if (scheduler->current_index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
            return SWYP_ERR_CORRUPT;
        }
        if (scheduler->threads[scheduler->current_index].state == SWYP_SCHEDULER_STATE_RUNNING) {
            return SWYP_ERR_DENIED;
        }
    }
    status = scheduler->address_ops->activate_kernel(scheduler->address_context);
    if (status != SWYP_OK) {
        return status;
    }
    scheduler->current_index = SWYP_SCHEDULER_NO_THREAD;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_yield_current(SwypScheduler *scheduler) {
    SwypSchedulerThread *thread;
    if (scheduler == NULL || scheduler->current_index == SWYP_SCHEDULER_NO_THREAD ||
        scheduler->current_index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
        return SWYP_ERR_INVALID;
    }
    thread = &scheduler->threads[scheduler->current_index];
    if (thread->state != SWYP_SCHEDULER_STATE_RUNNING) {
        return SWYP_ERR_DENIED;
    }
    thread->state = SWYP_SCHEDULER_STATE_READY;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_remove_driver_epoch(SwypScheduler *scheduler, uint64_t domain_id, uint64_t lease_fence,
                                              uint32_t *removed_count) {
    uint32_t removed = 0u;
    uint32_t i;
    if (scheduler == NULL || domain_id == 0u || lease_fence == 0u || removed_count == NULL) {
        return SWYP_ERR_INVALID;
    }
    *removed_count = 0u;
    for (i = 0u; i < SWYP_SCHEDULER_THREAD_CAPACITY; ++i) {
        SwypSchedulerThread *thread = &scheduler->threads[i];
        if (thread->state == SWYP_SCHEDULER_STATE_FREE || thread->kind != SWYP_SCHEDULER_THREAD_DRIVER ||
            thread->domain_id != domain_id || thread->lease_fence != lease_fence) {
            continue;
        }
        if (thread->state != SWYP_SCHEDULER_STATE_STOPPED || i == scheduler->current_index) {
            return SWYP_ERR_DENIED;
        }
        swyp_scheduler_thread_clear(thread);
        removed += 1u;
    }
    *removed_count = removed;
    return removed == 0u ? SWYP_ERR_NOT_FOUND : SWYP_OK;
}

const SwypSchedulerThread *swyp_scheduler_thread(const SwypScheduler *scheduler, uint64_t thread_id) {
    return swyp_scheduler_find_const(scheduler, thread_id);
}

const SwypSchedulerThread *swyp_scheduler_current(const SwypScheduler *scheduler) {
    if (scheduler == NULL || scheduler->current_index == SWYP_SCHEDULER_NO_THREAD ||
        scheduler->current_index >= SWYP_SCHEDULER_THREAD_CAPACITY ||
        scheduler->threads[scheduler->current_index].state != SWYP_SCHEDULER_STATE_RUNNING) {
        return NULL;
    }
    return &scheduler->threads[scheduler->current_index];
}

SwypStatus swyp_scheduler_update_current_context(SwypScheduler *scheduler, const SwypThreadContext *context) {
    SwypSchedulerThread *thread;
    if (scheduler == NULL || !swyp_scheduler_context_valid(context) || scheduler->current_index == SWYP_SCHEDULER_NO_THREAD ||
        scheduler->current_index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
        return SWYP_ERR_INVALID;
    }
    thread = &scheduler->threads[scheduler->current_index];
    if (thread->state != SWYP_SCHEDULER_STATE_RUNNING) {
        return SWYP_ERR_DENIED;
    }
    thread->context = *context;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_set_default_quantum(SwypScheduler *scheduler, uint32_t quantum_ticks) {
    if (scheduler == NULL || quantum_ticks == 0u) {
        return SWYP_ERR_INVALID;
    }
    scheduler->default_quantum_ticks = quantum_ticks;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_set_thread_quantum(SwypScheduler *scheduler, uint64_t thread_id, uint32_t quantum_ticks) {
    SwypSchedulerThread *thread = swyp_scheduler_find(scheduler, thread_id, NULL);
    if (thread == NULL || quantum_ticks == 0u) {
        return SWYP_ERR_INVALID;
    }
    thread->quantum_ticks = quantum_ticks;
    thread->remaining_ticks = quantum_ticks;
    return SWYP_OK;
}

SwypStatus swyp_scheduler_tick(SwypScheduler *scheduler, int *preempt_requested) {
    SwypSchedulerThread *thread;
    if (scheduler == NULL || preempt_requested == NULL) {
        return SWYP_ERR_INVALID;
    }
    *preempt_requested = 0;
    scheduler->tick_count += 1u;
    if (scheduler->current_index == SWYP_SCHEDULER_NO_THREAD) {
        return SWYP_ERR_NOT_FOUND;
    }
    if (scheduler->current_index >= SWYP_SCHEDULER_THREAD_CAPACITY) {
        return SWYP_ERR_CORRUPT;
    }
    thread = &scheduler->threads[scheduler->current_index];
    if (thread->state != SWYP_SCHEDULER_STATE_RUNNING || thread->quantum_ticks == 0u ||
        thread->remaining_ticks == 0u) {
        return SWYP_ERR_CORRUPT;
    }
    thread->remaining_ticks -= 1u;
    if (thread->remaining_ticks != 0u) {
        return SWYP_OK;
    }
    thread->remaining_ticks = thread->quantum_ticks;
    thread->state = SWYP_SCHEDULER_STATE_READY;
    *preempt_requested = 1;
    return SWYP_OK;
}
