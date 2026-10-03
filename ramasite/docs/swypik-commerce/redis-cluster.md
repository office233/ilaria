# Redis Cluster Prep (BullMQ scale-out)

**Status:** NU implementat. Document pentru viitor.

## De ce
- Redis single-node (current) → SPOF + capped throughput.
- BullMQ folosește Redis pentru queue persistence + Pub/Sub. La > ~10k jobs/min sau RAM > 4GB, ne trebuie cluster.

## Topologie target
**3 master + 3 replica** (6 noduri total, 1 replica per master). 16384 slots distribute uniform.

### Provisioning (Hetzner sau dedicat)
- 6 VPS mici (CX21) sau 3 VPS cu 2 instanțe fiecare (master + replica pe noduri diferite).
- Latency intra-cluster < 1ms.

### Setup
```bash
# Pe fiecare nod
redis-server --port 7000 --cluster-enabled yes --cluster-config-file nodes.conf   --cluster-node-timeout 5000 --appendonly yes --bind 0.0.0.0

# Pe orice nod (din 6)
redis-cli --cluster create   10.0.0.1:7000 10.0.0.2:7000 10.0.0.3:7000   10.0.0.4:7000 10.0.0.5:7000 10.0.0.6:7000   --cluster-replicas 1
```

## Update BullMQ connection
`lib/queue/redis.ts` (sau echivalent):

```ts
import IORedis from "ioredis";

const isCluster = process.env.REDIS_CLUSTER_NODES;

export const connection = isCluster
  ? new IORedis.Cluster(
      isCluster.split(",").map((n) => {
        const [host, port] = n.split(":");
        return { host, port: Number(port) };
      }),
      {
        redisOptions: { password: process.env.REDIS_PASSWORD },
        scaleReads: "slave",
      }
    )
  : new IORedis(process.env.REDIS_URL!);
```

`.env.production`:
```
REDIS_CLUSTER_NODES=10.0.0.1:7000,10.0.0.2:7000,10.0.0.3:7000
REDIS_PASSWORD=...
```

## Sticky session pt BullMQ streams
BullMQ folosește hash tags `{queue}` pentru a forța toate cheile aceleiași cozi pe același slot (BullMQ v3+ face asta automat dacă `prefix` conține `{}`).

Verifică: `new Queue("name", { prefix: "bull:{shard1}" })` → toate chei `bull:{shard1}:*` cad pe același slot.

## Migration plan
1. Pornește cluster paralel cu Redis single-node.
2. Drain cozile existente (pause producers, wait jobs finish).
3. Switch `REDIS_URL` → `REDIS_CLUSTER_NODES`.
4. Restart consumers.
5. Verify cu `redis-cli --cluster check 10.0.0.1:7000`.

## ⚠️ Test pe staging
- BullMQ flows / repeatable jobs au quirks pe cluster (anumite Lua scripts).
- Testează cu `@upstash/redis` ca alternativă managed (eligible serverless).
