# Multi-Region Deploy Plan

**Status:** NU implementat. Document strategic.

## Topologie target

| Region | Role | Components |
|--------|------|-----------|
| Hetzner FRA1 (current) | Primary / EU | postgres-master, redis-master, web-next, platform-api, workers |
| Hetzner AS1 sau US East | Secondary / US | postgres-replica, redis-replica, web-next (read-mostly), platform-api |

## DNS routing
**Cloudflare Geo Steering** (sau Route53 Latency-Based Routing):
- `swypik.com` → CNAME steered pe regiune client.
- EU clients → `fra1.swypik.com` → web-next FRA1.
- US clients → `us1.swypik.com` → web-next US.

Fallback / health check: dacă regiune nesănătoasă, route auto la cealaltă.

## Data sync — Postgres
**Logical replication EU → US** (publication / subscription):
```sql
-- master
CREATE PUBLICATION swypik_pub FOR ALL TABLES;
-- replica
CREATE SUBSCRIPTION swypik_sub
  CONNECTION 'host=fra1.swypik.com user=replicator password=...'
  PUBLICATION swypik_pub;
```

US region:
- **Reads** → replica locală (low latency).
- **Writes** → forward HTTP la EU primary (acceptă +100ms penalty pt POST).

### Cloudflare Workers caching
Pentru read-scale extrem:
- Cache `/api/explore/feed`, `/api/categories`, `/api/products` (anon) la edge.
- TTL 60-120s cu `stale-while-revalidate`.
- Cache key include `Cookie` doar dacă auth.

## Storage
**R2 (Cloudflare) — deja multi-region.** Nu necesită modificări. Bucket-ul `swypik-media` e servit din edge global.

## Session stickiness
**Cookie-based** (sticky pe regiune):
- Cookie `swypik-region=eu|us` setat la prima request (din `CF-IPCountry`).
- Edge worker citește cookie → route la origin region.
- Garantează că un user nu sare între regiuni mid-session (cache, login state).

## Limitări & risc
- **Write latency cross-region**: US user face POST → routed la EU → +80-120ms RTT. Accept pt minoritatea de writes.
- **Replication lag**: under load logical repl poate avea lag de secunde → US user vede update-uri cu delay.
- **Failover**: dacă EU primary cade, promote US replica → manual (sau pg_auto_failover / Patroni).

## Cost estimate
- 2nd VPS US: ~€20-40/lună.
- 2nd Postgres VPS US: ~€30/lună.
- Cloudflare Workers: free tier suficient inițial.

## ⚠️ Test pe staging
- Lansează 2 VPS test (FRA + US) cu logical repl.
- Măsoară lag sub load real.
- Verifică sticky cookies funcționează cross-CDN.
