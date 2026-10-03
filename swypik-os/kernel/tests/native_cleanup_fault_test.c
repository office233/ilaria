/* Host-only fault effects; all authority and cleanup comes from production C. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "swypik/kernel/device_platform.h"

enum Op { QUERY, RESERVE, MAP, UNMAP, RELEASE, ALLOC_IRQ, BIND, UNMASK,
          MASK, UNBIND, RELEASE_IRQ, EOI, DMA_MAP, DMA_UNMAP, OP_COUNT };
static const char *const names[] = {"query", "reserve", "map", "unmap", "release",
    "alloc_irq", "bind", "unmask", "mask", "unbind", "release_irq", "eoi", "dma_map", "dma_unmap"};
typedef struct Resource { int reserved, mapped, vector, bound, masked, dma; } Resource;
typedef struct Event { enum Op op; unsigned device; int failed; } Event;
typedef struct Fake {
    SwypAddressSpace spaces[2];
    SwypInterruptSource interrupts;
    Resource resources[2];
    Event events[128];
    unsigned event_count, calls[OP_COUNT], fail_nth[OP_COUNT];
    int unsafe_free;
} Fake;
typedef struct Fixture {
    Fake fake;
    SwypCapabilityTable table;
    SwypDriverDomainManager domains;
    SwypDeviceBroker broker;
    SwypDevicePlatform platform;
    SwypDeviceGraph graph;
    const SwypDriverDomain *domain[2];
    SwypCapabilityHandle caps[2][4];
    SwypDeviceBrokerHandle handles[2][3];
} Fixture;
static const char *case_name;
static unsigned checks, failures, cases;
static Fake *current;

static void check(int condition, const char *expr, int line) {
    unsigned i;
    ++checks;
    if (condition) return;
    ++failures;
    fprintf(stderr, "FAIL case=%s line=%d invariant=%s trace=", case_name, line, expr);
    if (current != NULL) {
        for (i = 0; i < current->event_count; ++i)
            fprintf(stderr, "%s%s:d%u%s", i ? "," : "", names[current->events[i].op],
                    current->events[i].device, current->events[i].failed ? "!" : "");
        for (i = 0; i < 2; ++i) {
            Resource *r = &current->resources[i];
            fprintf(stderr, " remaining:d%u[va=%d,map=%d,vec=%d,bound=%d,mask=%d,dma=%d]",
                    i, r->reserved, r->mapped, r->vector, r->bound, r->masked, r->dma);
        }
    }
    fputc('\n', stderr);
}
#define CHECK(x) check((x), #x, __LINE__)
#define INJECTED SWYP_ERR_CORRUPT

static unsigned device(uint64_t domain) { return (unsigned)(domain - 700u); }
static uint64_t va(unsigned d) { return UINT64_C(0x90000000) + d * UINT64_C(0x10000); }
static int effect(Fake *f, enum Op op, unsigned d) {
    int fail;
    CHECK(d < 2u);
    fail = ++f->calls[op] == f->fail_nth[op];
    CHECK(f->event_count < 128u);
    if (f->event_count < 128u) f->events[f->event_count++] = (Event){op, d, fail};
    return fail;
}
static SwypStatus query(void *ctx, uint64_t dom, uint64_t fence, SwypAddressSpace **out) {
    Fake *f = ctx; unsigned d = device(dom); (void)fence;
    if (effect(f, QUERY, d)) return INJECTED;
    *out = &f->spaces[d]; return SWYP_OK;
}
static SwypStatus reserve(void *ctx, uint64_t dom, uint64_t fence, uint64_t pages,
                          uint32_t shift, uint64_t *out) {
    Fake *f = ctx; unsigned d = device(dom); (void)fence;
    CHECK(pages == 2u && shift == 12u);
    if (effect(f, RESERVE, d)) return INJECTED;
    CHECK(!f->resources[d].reserved); f->resources[d].reserved = 1; *out = va(d); return SWYP_OK;
}
static SwypStatus release(void *ctx, uint64_t dom, uint64_t fence, uint64_t base, uint64_t pages) {
    Fake *f = ctx; unsigned d = device(dom); (void)fence;
    CHECK(base == va(d) && pages == 2u);
    if (effect(f, RELEASE, d)) return INJECTED;
    if (f->resources[d].mapped) f->unsafe_free = 1;
    CHECK(!f->resources[d].mapped && f->resources[d].reserved);
    f->resources[d].reserved = 0; return SWYP_OK;
}
static SwypStatus map(void *ctx, uint64_t base, uint64_t physical, uint64_t pages, uint64_t flags) {
    Fake *f = ctx; unsigned d = (unsigned)((base - va(0)) / UINT64_C(0x10000));
    CHECK(physical == UINT64_C(0xfebf0000) + d * UINT64_C(0x10000));
    CHECK(pages == 2u && flags == (SWYP_MMU_READ | SWYP_MMU_USER | SWYP_MMU_DEVICE));
    if (effect(f, MAP, d)) return INJECTED;
    CHECK(f->resources[d].reserved && !f->resources[d].mapped);
    f->resources[d].mapped = 1; return SWYP_OK;
}
static SwypStatus unmap(void *ctx, uint64_t base, uint64_t pages) {
    Fake *f = ctx; unsigned d = (unsigned)((base - va(0)) / UINT64_C(0x10000));
    CHECK(pages == 2u);
    if (effect(f, UNMAP, d)) return INJECTED;
    CHECK(f->resources[d].mapped); f->resources[d].mapped = 0; return SWYP_OK;
}
static SwypStatus alloc_irq(void *ctx, uint64_t dom, uint64_t fence, uint32_t source, uint32_t *out) {
    Fake *f = ctx; unsigned d = device(dom); (void)fence;
    CHECK(source == 17u + d);
    if (effect(f, ALLOC_IRQ, d)) return INJECTED;
    CHECK(!f->resources[d].vector); f->resources[d].vector = 1; *out = 80u + d; return SWYP_OK;
}
static SwypStatus release_irq(void *ctx, uint64_t dom, uint64_t fence, uint32_t source, uint32_t vector) {
    Fake *f = ctx; unsigned d = device(dom); (void)fence;
    CHECK(source == 17u + d && vector == 80u + d);
    if (effect(f, RELEASE_IRQ, d)) return INJECTED;
    if (f->resources[d].bound) f->unsafe_free = 1;
    CHECK(f->resources[d].vector && !f->resources[d].bound);
    f->resources[d].vector = 0; return SWYP_OK;
}
static SwypStatus bind(void *ctx, uint32_t source, uint32_t vector) {
    Fake *f = ctx; unsigned d = source - 17u;
    CHECK(vector == 80u + d);
    if (effect(f, BIND, d)) return INJECTED;
    CHECK(f->resources[d].vector && !f->resources[d].bound);
    f->resources[d].bound = 1; return SWYP_OK;
}
static SwypStatus unbind(void *ctx, uint32_t source) {
    Fake *f = ctx; unsigned d = source - 17u;
    if (effect(f, UNBIND, d)) return INJECTED;
    CHECK(f->resources[d].bound && f->resources[d].masked);
    f->resources[d].bound = 0; return SWYP_OK;
}
static SwypStatus mask(void *ctx, uint32_t source) {
    Fake *f = ctx; unsigned d = source - 17u;
    if (effect(f, MASK, d)) return INJECTED;
    f->resources[d].masked = 1; return SWYP_OK;
}
static SwypStatus unmask(void *ctx, uint32_t source) {
    Fake *f = ctx; unsigned d = source - 17u;
    if (effect(f, UNMASK, d)) return INJECTED;
    CHECK(f->resources[d].bound); f->resources[d].masked = 0; return SWYP_OK;
}
static SwypStatus eoi(void *ctx, uint32_t source) {
    Fake *f = ctx; return effect(f, EOI, source - 17u) ? INJECTED : SWYP_OK;
}
static SwypStatus dma_map(void *ctx, const SwypCapabilityObject *dma, const SwypCapabilityObject *mem,
                          uint64_t physical, uint64_t dom, uint64_t fence, uint64_t length,
                          uint64_t rights, uint64_t *token, uint64_t *iova) {
    Fake *f = ctx; unsigned d = device(dom); (void)fence;
    CHECK(dma->type == SWYP_CAP_OBJECT_DMA && mem->type == SWYP_CAP_OBJECT_SHARED_MEMORY);
    CHECK(physical == mem->base + 0x1000u && length == 0x2000u && rights == SWYP_CAP_RIGHT_READ);
    if (effect(f, DMA_MAP, d)) return INJECTED;
    CHECK(!f->resources[d].dma); f->resources[d].dma = 1;
    *token = 100u + d; *iova = dma->base; return SWYP_OK;
}
static SwypStatus dma_unmap(void *ctx, uint64_t token) {
    Fake *f = ctx; unsigned d = (unsigned)(token - 100u);
    if (effect(f, DMA_UNMAP, d)) return INJECTED;
    CHECK(f->resources[d].dma); f->resources[d].dma = 0; return SWYP_OK;
}
static const SwypAddressSpaceOps as_ops = {.map = map, .unmap = unmap};
static const SwypInterruptSourceOps irq_ops = {
    .bind = bind, .unbind = unbind, .mask = mask, .unmask = unmask, .end_of_interrupt = eoi};
static const SwypDevicePlatformRuntimeOps runtime_ops = {
    .address_space_for_domain = query, .reserve_device_virtual = reserve, .release_device_virtual = release,
    .allocate_irq_vector = alloc_irq, .release_irq_vector = release_irq, .map_dma = dma_map, .unmap_dma = dma_unmap};

static void init(Fixture *f) {
    unsigned d, k;
    memset(f, 0, sizeof(*f)); current = &f->fake;
    swyp_capability_table_init(&f->table);
    swyp_driver_domain_manager_init(&f->domains, &f->table);
    swyp_device_graph_init(&f->graph);
    for (d = 0; d < 2; ++d) {
        SwypDeviceNode node = {.id = 2u + d, .device_class = SWYP_DEVICE_CLASS_NETWORK, .bus = SWYP_DEVICE_BUS_PCI};
        SwypDeviceResource resources[4] = {
            {.node_id = 2u + d, .kind = SWYP_DEVICE_RESOURCE_MMIO, .start = UINT64_C(0xfebf0123) + d * 0x10000u, .length = 0x3000u},
            {.node_id = 2u + d, .kind = SWYP_DEVICE_RESOURCE_IRQ, .start = 17u + d, .length = 1u},
            {.node_id = 2u + d, .kind = SWYP_DEVICE_RESOURCE_DMA, .start = UINT64_C(0x20000000) + d * 0x10000u, .length = 0x4000u},
            {.node_id = 2u + d, .kind = SWYP_DEVICE_RESOURCE_SHARED_MEMORY, .start = UINT64_C(0x30000000) + d * 0x10000u, .length = 0x4000u}};
        SwypDriverDomainPolicy policy;
        CHECK(swyp_device_graph_add_node(&f->graph, &node) == SWYP_OK);
        swyp_driver_domain_policy_init(&policy);
        for (k = 0; k < 4; ++k) {
            uint64_t rights = k == 1u ? SWYP_CAP_RIGHT_BIND | SWYP_CAP_RIGHT_ACK : SWYP_CAP_RIGHT_READ | SWYP_CAP_RIGHT_MAP;
            CHECK(swyp_device_graph_add_resource(&f->graph, &resources[k]) == SWYP_OK);
            CHECK(swyp_driver_domain_policy_allow_resource(&policy, (uint16_t)(d * 4u + k), rights) == SWYP_OK);
        }
        CHECK(swyp_driver_domain_open(&f->domains, &f->graph, 2u + d, 700u + d, 11u, &policy, &f->domain[d]) == SWYP_OK);
        if (f->domain[d] == NULL) exit(2);
        for (k = 0; k < 4; ++k) f->caps[d][k] = f->domain[d]->grants[k];
        f->fake.spaces[d] = (SwypAddressSpace){.context = &f->fake, .ops = &as_ops};
        f->fake.resources[d].masked = 1;
    }
    f->fake.interrupts = (SwypInterruptSource){.context = &f->fake, .ops = &irq_ops};
    swyp_device_platform_init(&f->platform, &f->fake, &runtime_ops, &f->fake.interrupts, 12u);
    swyp_device_broker_init(&f->broker, &f->domains, &f->platform, swyp_device_platform_broker_ops());
}
static SwypStatus acquire(Fixture *f, unsigned d, unsigned kind) {
    SwypDeviceMapping m = {0}; SwypDeviceIrqBinding b = {0}; SwypStatus s;
    if (kind == 0u) s = swyp_device_broker_map_mmio(&f->broker, 700u + d, 11u, f->caps[d][0],
                                                   0x20u, 0x1800u, SWYP_CAP_RIGHT_READ, &m);
    else if (kind == 1u) s = swyp_device_broker_bind_irq(&f->broker, 700u + d, 11u, f->caps[d][1], &b);
    else s = swyp_device_broker_map_dma(&f->broker, 700u + d, 11u, f->caps[d][2], f->caps[d][3],
                                       0x1000u, 0x2000u, SWYP_CAP_RIGHT_READ, &m);
    if (s == SWYP_OK) {
        f->handles[d][kind] = kind == 1u ? b.handle : m.handle;
        CHECK(f->handles[d][kind] != 0u);
        if (kind == 0u) CHECK(m.address == va(d) + 0x143u && m.length == 0x1800u);
        if (kind == 1u) CHECK(b.vector == 80u + d);
    } else CHECK(m.handle == 0u && m.address == 0u && b.handle == 0u);
    return s;
}
static SwypStatus dispose(Fixture *f, unsigned d, unsigned kind, uint64_t fence) {
    if (kind == 0u) return swyp_device_broker_unmap_mmio(&f->broker, 700u + d, fence, f->handles[d][kind]);
    if (kind == 1u) return swyp_device_broker_unbind_irq(&f->broker, 700u + d, fence, f->handles[d][kind]);
    return swyp_device_broker_unmap_dma(&f->broker, 700u + d, fence, f->handles[d][kind]);
}
static unsigned records(Fixture *f, unsigned d) {
    unsigned i, count = 0;
    for (i = 0; i < SWYP_DEVICE_BROKER_RECORD_CAPACITY; ++i)
        if (f->broker.records[i].active == SWYP_DEVICE_BROKER_SLOT_ACTIVE && f->broker.records[i].domain_id == 700u + d) ++count;
    return count;
}
static void empty(Fixture *f, unsigned d) {
    Resource *r = &f->fake.resources[d]; unsigned i;
    CHECK(!r->reserved && !r->mapped && !r->vector && !r->bound && !r->dma);
    CHECK(!f->fake.unsafe_free && records(f, d) == 0u);
    for (i = 0; i < SWYP_DEVICE_PLATFORM_RECORD_CAPACITY; ++i)
        CHECK(!f->platform.records[i].active || f->platform.records[i].domain_id != 700u + d);
}
static void trace(Fake *f, const enum Op *ops, unsigned n) {
    unsigned i; CHECK(f->event_count == n);
    for (i = 0; i < n && i < f->event_count; ++i) CHECK(f->events[i].op == ops[i] && f->events[i].device == 0u);
}
static void reset_trace(Fake *f) {
    f->event_count = 0u; memset(f->calls, 0, sizeof(f->calls)); memset(f->fail_nth, 0, sizeof(f->fail_nth));
}
static void denied(Fixture *f) {
    unsigned k, before = f->fake.event_count;
    const SwypCapabilityGrant *grant = NULL;
    CHECK(f->domain[0]->active == SWYP_DRIVER_DOMAIN_QUIESCED);
    for (k = 0; k < 3; ++k) CHECK(acquire(f, 0u, k) == SWYP_ERR_DENIED);
    for (k = 0; k < 4; ++k)
        CHECK(swyp_driver_domain_resolve(&f->domains, 700u, 11u, f->caps[0][k],
              k == 1u ? SWYP_CAP_RIGHT_BIND : SWYP_CAP_RIGHT_MAP, SWYP_CAP_OBJECT_INVALID, &grant) == SWYP_ERR_DENIED);
    CHECK(f->fake.event_count == before);
}
static int selected_case(const char *filter, const char *name) {
    if (filter != NULL && strcmp(filter, name) != 0) return 0;
    case_name = name; ++cases; return 1;
}

int main(int argc, char **argv) {
    const char *filter = argc == 2 ? argv[1] : NULL;
    static const enum Op acquisitions[3][3] = {{QUERY, RESERVE, MAP}, {ALLOC_IRQ, BIND, UNMASK}, {DMA_MAP}};
    static const unsigned acq_count[] = {3u, 3u, 1u};
    static const enum Op cleanups[3][3] = {{UNMAP, RELEASE}, {MASK, UNBIND, RELEASE_IRQ}, {DMA_UNMAP}};
    static const unsigned clean_count[] = {2u, 3u, 1u};
    unsigned kind, nth, mode, rollback;
    char name[96];
    Fixture f;
    if (argc > 2) { fprintf(stderr, "usage: native_cleanup_fault_test [exact-case]\n"); return 2; }
    for (kind = 0; kind < 3; ++kind) {
        for (nth = 0; nth <= acq_count[kind]; ++nth) {
            enum Op expected[8]; unsigned n = 0u, i;
            snprintf(name, sizeof(name), "acquire-k%u-n%u", kind, nth);
            if (!selected_case(filter, name)) continue;
            init(&f);
            if (nth) f.fake.fail_nth[acquisitions[kind][nth - 1u]] = 1u;
            CHECK(acquire(&f, 0u, kind) == (nth ? INJECTED : SWYP_OK));
            for (i = 0; i < (nth ? nth : acq_count[kind]); ++i) expected[n++] = acquisitions[kind][i];
            if (kind == 0u && nth == 3u) expected[n++] = RELEASE;
            if (kind == 1u && nth == 2u) expected[n++] = RELEASE_IRQ;
            if (kind == 1u && nth == 3u) {
                expected[n++] = MASK; expected[n++] = UNBIND; expected[n++] = RELEASE_IRQ;
            }
            trace(&f.fake, expected, n);
            CHECK(records(&f, 0u) == (nth ? 0u : 1u));
            if (nth) { empty(&f, 0u); reset_trace(&f.fake); CHECK(acquire(&f, 0u, kind) == SWYP_OK); }
            CHECK(dispose(&f, 0u, kind, 11u) == SWYP_OK); empty(&f, 0u);
            CHECK(dispose(&f, 0u, kind, 11u) == SWYP_ERR_STALE);
        }
        for (mode = 0; mode < 2; ++mode) for (nth = 0; nth <= clean_count[kind]; ++nth) {
            unsigned i, n = nth ? nth : clean_count[kind];
            Resource other;
            snprintf(name, sizeof(name), "%s-k%u-n%u", mode ? "revoke" : "dispose", kind, nth);
            if (!selected_case(filter, name)) continue;
            init(&f);
            for (i = 0; i < 3; ++i) CHECK(acquire(&f, 1u, i) == SWYP_OK);
            other = f.fake.resources[1]; CHECK(acquire(&f, 0u, kind) == SWYP_OK);
            reset_trace(&f.fake);
            CHECK(dispose(&f, 0u, kind, 12u) == SWYP_ERR_DENIED);
            CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 12u) == SWYP_ERR_DENIED);
            CHECK(f.fake.event_count == 0u);
            if (nth) f.fake.fail_nth[cleanups[kind][nth - 1u]] = 1u;
            CHECK((mode ? swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) : dispose(&f, 0u, kind, 11u)) ==
                  (nth ? INJECTED : SWYP_OK));
            trace(&f.fake, cleanups[kind], n);
            CHECK(records(&f, 0u) == (nth ? 1u : 0u));
            CHECK(!f.fake.unsafe_free);
            if (nth) {
                if (kind == 0u) CHECK(f.fake.resources[0].reserved && f.fake.resources[0].mapped == (nth == 1u));
                if (kind == 1u) CHECK(f.fake.resources[0].vector && f.fake.resources[0].bound == (nth < 3u));
                if (kind == 2u) CHECK(f.fake.resources[0].dma);
                if (mode) denied(&f);
                reset_trace(&f.fake);
                CHECK((mode ? swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) : dispose(&f, 0u, kind, 11u)) == SWYP_OK);
                if (kind == 0u && nth == 2u) trace(&f.fake, &cleanups[kind][1], 1u);
                else if (kind == 1u && nth == 3u) trace(&f.fake, &cleanups[kind][2], 1u);
                else trace(&f.fake, cleanups[kind], clean_count[kind]);
            }
            empty(&f, 0u); CHECK(dispose(&f, 0u, kind, 11u) == SWYP_ERR_STALE);
            CHECK(memcmp(&other, &f.fake.resources[1], sizeof(other)) == 0 && records(&f, 1u) == 3u);
            CHECK(swyp_device_broker_ack_irq(&f.broker, 701u, 11u, f.handles[1][1]) == SWYP_OK);
            if (mode) {
                const SwypCapabilityGrant *g = NULL;
                for (i = 0; i < 4; ++i)
                    CHECK(swyp_capability_lookup(&f.table, f.caps[0][i], 700u, 11u,
                          i == 1u ? SWYP_CAP_RIGHT_BIND : SWYP_CAP_RIGHT_MAP, &g) == SWYP_ERR_STALE);
                CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == SWYP_ERR_NOT_FOUND);
            }
            CHECK(swyp_device_broker_revoke_domain(&f.broker, 701u, 11u) == SWYP_OK); empty(&f, 1u);
        }
    }
    /* Rollback must retain ownership when a second callback fails. Never fake recovery. */
    for (rollback = 0; rollback < 5u; ++rollback) {
        static const enum Op primary[] = {MAP, BIND, UNMASK, UNMASK, UNMASK};
        static const enum Op secondary[] = {RELEASE, RELEASE_IRQ, MASK, UNBIND, RELEASE_IRQ};
        unsigned k = rollback == 0u ? 0u : 1u;
        snprintf(name, sizeof(name), "rollback-p%u", rollback);
        if (!selected_case(filter, name)) continue;
        init(&f); f.fake.fail_nth[primary[rollback]] = 1u; f.fake.fail_nth[secondary[rollback]] = 1u;
        CHECK(acquire(&f, 0u, k) == INJECTED);
        if (rollback == 0u) {
            const enum Op expected[] = {QUERY, RESERVE, MAP, RELEASE};
            trace(&f.fake, expected, 4u);
        } else if (rollback == 1u) {
            const enum Op expected[] = {ALLOC_IRQ, BIND, RELEASE_IRQ};
            trace(&f.fake, expected, 3u);
        } else {
            const enum Op expected[] = {ALLOC_IRQ, BIND, UNMASK, MASK, UNBIND, RELEASE_IRQ};
            /* Failed unbind must stop rollback before vector release. */
            trace(&f.fake, expected, rollback == 3u ? 5u : 6u);
            if (rollback == 3u) {
                CHECK(f.fake.resources[0].bound && f.fake.resources[0].vector);
                CHECK(records(&f, 0u) == 1u && f.fake.calls[RELEASE_IRQ] == 0u);
            }
        }
        CHECK(!f.fake.unsafe_free);
        /* No handle was returned: domain revoke is the only public cleanup retry. */
        memset(f.fake.fail_nth, 0, sizeof(f.fake.fail_nth));
        CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == SWYP_OK);
        empty(&f, 0u);
    }
    /* Persistent rollback errors survive repeated public revoke without an
       acquisition handle, automatic retries or authority on the other device. */
    for (rollback = 0; rollback < 4u; ++rollback) {
        static const enum Op primary[] = {MAP, BIND, UNMASK, UNMASK};
        static const enum Op pending[] = {RELEASE, RELEASE_IRQ, UNBIND, RELEASE_IRQ};
        unsigned k = rollback == 0u ? 0u : 1u, i, attempt, slot = 0u;
        Resource other;
        SwypDeviceBrokerHandle hidden, found = 0u;
        uint64_t token = 0u;
        snprintf(name, sizeof(name), "persistent-rollback-%u", rollback);
        if (!selected_case(filter, name)) continue;
        init(&f);
        for (i = 0; i < 3u; ++i) CHECK(acquire(&f, 1u, i) == SWYP_OK);
        other = f.fake.resources[1]; reset_trace(&f.fake);
        f.fake.fail_nth[primary[rollback]] = 1u;
        f.fake.fail_nth[pending[rollback]] = 1u;
        CHECK(acquire(&f, 0u, k) == INJECTED);
        CHECK(f.handles[0][k] == 0u && records(&f, 0u) == 1u && !f.fake.unsafe_free);
        for (i = 0; i < SWYP_DEVICE_BROKER_RECORD_CAPACITY; ++i)
            if (f.broker.records[i].active == SWYP_DEVICE_BROKER_SLOT_ACTIVE && f.broker.records[i].domain_id == 700u) slot = i;
        hidden = ((uint64_t)f.broker.records[slot].generation << 32) | (slot + 1u);
        CHECK(f.broker.records[slot].reserved0 != 0u && f.broker.records[slot].backend_token != 0u);
        f.handles[0][k] = hidden;
        {
            unsigned before = f.fake.event_count;
            CHECK(dispose(&f, 0u, k, 11u) == SWYP_ERR_DENIED);
            if (k == 1u) {
                CHECK(swyp_device_broker_ack_irq(&f.broker, 700u, 11u, hidden) == SWYP_ERR_DENIED);
                CHECK(swyp_device_broker_irq_backend_token(&f.broker, 700u, 11u, hidden, &token) == SWYP_ERR_DENIED);
                CHECK(token == 0u);
                CHECK(swyp_device_broker_irq_handle_for_backend(&f.broker, 700u, 11u,
                      f.broker.records[slot].backend_token, &found) == SWYP_ERR_NOT_FOUND);
                CHECK(found == 0u);
            }
            CHECK(f.fake.event_count == before);
        }
        for (attempt = 0; attempt < 2u; ++attempt) {
            reset_trace(&f.fake); f.fake.fail_nth[pending[rollback]] = 1u;
            CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 12u) == SWYP_ERR_DENIED);
            CHECK(f.fake.event_count == 0u);
            CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == INJECTED);
            CHECK(f.fake.calls[pending[rollback]] == 1u); /* No automatic retry. */
            if (rollback == 2u) {
                const enum Op expected[] = {MASK, UNBIND};
                trace(&f.fake, expected, 2u);
                CHECK(f.fake.resources[0].bound && f.fake.resources[0].vector);
                CHECK(f.fake.calls[RELEASE_IRQ] == 0u);
            } else {
                trace(&f.fake, &pending[rollback], 1u);
                if (k == 0u) CHECK(f.fake.resources[0].reserved && !f.fake.resources[0].mapped);
                else CHECK(f.fake.resources[0].vector && !f.fake.resources[0].bound);
            }
            CHECK(records(&f, 0u) == 1u && !f.fake.unsafe_free); denied(&f);
            CHECK(records(&f, 1u) == 3u && memcmp(&other, &f.fake.resources[1], sizeof(other)) == 0);
        }
        reset_trace(&f.fake);
        CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == SWYP_OK);
        if (rollback == 2u) {
            const enum Op expected[] = {MASK, UNBIND, RELEASE_IRQ};
            trace(&f.fake, expected, 3u);
        } else trace(&f.fake, &pending[rollback], 1u);
        empty(&f, 0u); CHECK(dispose(&f, 0u, k, 11u) == SWYP_ERR_STALE);
        CHECK(swyp_device_broker_ack_irq(&f.broker, 701u, 11u, f.handles[1][1]) == SWYP_OK);
        CHECK(swyp_device_broker_revoke_domain(&f.broker, 701u, 11u) == SWYP_OK); empty(&f, 1u);
    }
    /* Mixed revoke continues in broker slot order after an error; only survivors retry. */
    for (nth = 0; nth <= 6u; ++nth) {
        const enum Op all[] = {UNMAP, RELEASE, MASK, UNBIND, RELEASE_IRQ, DMA_UNMAP};
        enum Op expected[6]; unsigned i, n = 0u, failed_kind = nth <= 2u ? 0u : (nth <= 5u ? 1u : 2u);
        snprintf(name, sizeof(name), "mixed-revoke-n%u", nth);
        if (!selected_case(filter, name)) continue;
        init(&f); for (i = 0; i < 3; ++i) { CHECK(acquire(&f, 0u, i) == SWYP_OK); CHECK(acquire(&f, 1u, i) == SWYP_OK); }
        reset_trace(&f.fake); if (nth) f.fake.fail_nth[all[nth - 1u]] = 1u;
        CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == (nth ? INJECTED : SWYP_OK));
        for (i = 0; i < 6; ++i) {
            if (nth == 1u && i == 1u) continue;
            if (nth == 3u && (i == 3u || i == 4u)) continue;
            if (nth == 4u && i == 4u) continue;
            expected[n++] = all[i];
        }
        trace(&f.fake, expected, n); CHECK(records(&f, 1u) == 3u);
        if (nth) {
            CHECK(records(&f, 0u) == 1u); denied(&f); reset_trace(&f.fake);
            CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == SWYP_OK);
            if (nth == 2u) trace(&f.fake, &all[1], 1u);
            else if (nth == 5u) trace(&f.fake, &all[4], 1u);
            else trace(&f.fake, cleanups[failed_kind], clean_count[failed_kind]);
        }
        empty(&f, 0u);
        for (i = 0; i < 3; ++i) CHECK(dispose(&f, 0u, i, 11u) == SWYP_ERR_STALE);
        CHECK(swyp_device_broker_revoke_domain(&f.broker, 701u, 11u) == SWYP_OK); empty(&f, 1u);
    }
    /* Every acquisition/cleanup callback also fails on its second occurrence. */
    for (kind = 0; kind < 3; ++kind) for (mode = 0; mode < 2; ++mode) {
        unsigned count = mode ? clean_count[kind] : acq_count[kind];
        for (nth = 0; nth < count; ++nth) {
            enum Op target = mode ? cleanups[kind][nth] : acquisitions[kind][nth];
            snprintf(name, sizeof(name), "nth2-%s-k%u-step%u", mode ? "cleanup" : "acquire", kind, nth);
            if (!selected_case(filter, name)) continue;
            init(&f);
            if (mode) {
                CHECK(acquire(&f, 0u, kind) == SWYP_OK); CHECK(acquire(&f, 1u, kind) == SWYP_OK);
                reset_trace(&f.fake); f.fake.fail_nth[target] = 2u;
                CHECK(dispose(&f, 0u, kind, 11u) == SWYP_OK);
                CHECK(dispose(&f, 1u, kind, 11u) == INJECTED);
                CHECK(records(&f, 0u) == 0u && records(&f, 1u) == 1u);
                CHECK(f.fake.calls[target] == 2u);
                memset(f.fake.fail_nth, 0, sizeof(f.fake.fail_nth));
                CHECK(dispose(&f, 1u, kind, 11u) == SWYP_OK);
            } else {
                f.fake.fail_nth[target] = 2u;
                CHECK(acquire(&f, 0u, kind) == SWYP_OK); CHECK(acquire(&f, 1u, kind) == INJECTED);
                CHECK(f.fake.calls[target] == 2u); empty(&f, 1u);
                CHECK(records(&f, 0u) == 1u);
                memset(f.fake.fail_nth, 0, sizeof(f.fake.fail_nth));
                CHECK(acquire(&f, 1u, kind) == SWYP_OK);
                CHECK(dispose(&f, 0u, kind, 11u) == SWYP_OK); CHECK(dispose(&f, 1u, kind, 11u) == SWYP_OK);
            }
            empty(&f, 0u); empty(&f, 1u);
        }
    }
    if (selected_case(filter, "generation-and-fence-reuse")) {
        unsigned k;
        SwypDeviceBrokerHandle old[3];
        init(&f);
        for (k = 0; k < 3; ++k) {
            CHECK(acquire(&f, 0u, k) == SWYP_OK); old[k] = f.handles[0][k];
            CHECK(dispose(&f, 0u, k, 11u) == SWYP_OK);
            CHECK(acquire(&f, 0u, k) == SWYP_OK); CHECK(f.handles[0][k] != old[k]);
            {
                SwypDeviceBrokerHandle live = f.handles[0][k];
                unsigned before = f.fake.event_count;
                f.handles[0][k] = old[k]; CHECK(dispose(&f, 0u, k, 11u) == SWYP_ERR_STALE);
                f.handles[0][k] = live; CHECK(dispose(&f, 0u, k, 12u) == SWYP_ERR_DENIED);
                CHECK(f.fake.event_count == before);
            }
            CHECK(dispose(&f, 0u, k, 11u) == SWYP_OK);
        }
        empty(&f, 0u);
    }
    if (selected_case(filter, "irq-ack-faults")) {
        unsigned i;
        init(&f); CHECK(acquire(&f, 0u, 1u) == SWYP_OK);
        for (i = 0; i < 2; ++i) {
            const enum Op ack[] = {EOI, UNMASK};
            reset_trace(&f.fake); f.fake.fail_nth[ack[i]] = 1u;
            CHECK(swyp_device_broker_ack_irq(&f.broker, 700u, 11u, f.handles[0][1]) == INJECTED);
            trace(&f.fake, ack, i + 1u); CHECK(records(&f, 0u) == 1u && f.fake.resources[0].bound);
            reset_trace(&f.fake);
            CHECK(swyp_device_broker_ack_irq(&f.broker, 700u, 11u, f.handles[0][1]) == SWYP_OK);
            trace(&f.fake, ack, 2u);
        }
        CHECK(swyp_device_broker_revoke_domain(&f.broker, 700u, 11u) == SWYP_OK); empty(&f, 0u);
    }
    printf("native cleanup matrix: cases=%u checks=%u failures=%u\n", cases, checks, failures);
    if (!cases) { fprintf(stderr, "unknown case: %s\n", filter ? filter : ""); return 2; }
    return failures ? 1 : 0;
}
