# Cloudflare Prep — Swypik

> Status: **NOT activated yet**. This document tracks steps required so an operator can flip Swypik onto Cloudflare without trial-and-error.

## 0. Files in this folder
- `dns-records.md` — DNS table (A/CNAME for swypik.com / www / media).
- `r2-cors.json`, `r2-lifecycle.json` — R2 bucket config (already applied via wrangler).

## 1. Onboard the domain
1. Sign in to Cloudflare → **Add a Site** → `swypik.com` (Free plan is enough for start).
2. Update nameservers at the registrar to the ones Cloudflare gives you.
3. Wait for DNS propagation (24h max).

## 2. SSL / TLS
- **Encryption mode: Full (strict)** — keep Caddy + Let's Encrypt on the VPS untouched. Cloudflare will validate the Caddy cert end-to-end.
- Enable **Always Use HTTPS** (Edge Certificates).
- **Minimum TLS Version: 1.2**.

## 3. Cache rules (Caching → Cache Rules)
| # | Match                                          | Action                                  |
|---|------------------------------------------------|-----------------------------------------|
| 1 | URI path starts with `/api/`                  | **Bypass cache** (Cache Eligibility: Bypass) |
| 2 | URI path starts with `/_next/static/`         | Cache eligibility: Eligible · **Edge TTL = 1 month** · Browser TTL = 1 month |
| 3 | URI path matches `.*\.(jpg|jpeg|png|webp|avif|gif|mp4|m3u8|ts|svg|woff2|woff|ico)$` | Eligible · **Edge TTL = 1 week** · Browser TTL = 1 day |
| 4 | URI path `/` or any HTML (default catch-all)  | Bypass — let Next.js / app router decide |

Old Page Rules equivalent (if the new Cache Rules UI is not available):
- `swypik.com/api/*` → Cache Level: Bypass
- `swypik.com/_next/static/*` → Cache Everything, Edge TTL 1 month
- `swypik.com/*.{jpg,png,webp,mp4,m3u8,ts,svg,woff2}` → Cache Everything, Edge TTL 1 week

## 4. Security (WAF → Rate limiting rules)
- `/api/auth/*` → **10 req / min / IP** → Block 1m
- `/api/explore/feed` → **60 req / min / IP** → Challenge
- `/api/checkout/*` → **20 req / min / IP** → Challenge

## 5. DDoS / Bot
- **DDoS Protection**: enabled by default on Free plan, leave on.
- **Bot Fight Mode**: enabled.
- **Browser Integrity Check**: enabled.

## 6. Real client IP on the VPS
Cloudflare proxies traffic, so the VPS sees `X-Forwarded-For: <CF-edge-ip>`. The real client IP is in the **`CF-Connecting-IP`** header.

### Caddy
Patch `infra/hetzner/Caddyfile` so Caddy trusts Cloudflare edges and rewrites the `X-Forwarded-For` accordingly. Caddy 2.7+ supports the `trusted_proxies cloudflare` module (https://github.com/WeidiDeng/caddy-cloudflare-ip):

```caddy
{
    servers {
        trusted_proxies cloudflare {
            interval 12h
            timeout 15s
        }
        client_ip_headers CF-Connecting-IP X-Forwarded-For
    }
}
```

If the `cloudflare-ip` module is not in the Caddy build, fall back to a static IP list (refresh quarterly from https://www.cloudflare.com/ips-v4 + ips-v6):

```caddy
@cloudflare {
    remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22               141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20               197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13               104.24.0.0/14 172.64.0.0/13 131.0.72.0/22               2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32               2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
}
```

### App
- `lib/rate-limit.ts:clientIp()` already reads `x-forwarded-for` — once Caddy rewrites it, no app change is needed.
- `app/api/geo/route.ts` already reads `cf-ipcountry` first. Will start returning the real country once Cloudflare is in front.

## 7. Origin protection
After Cloudflare is live and confirmed working:
1. Cloudflare → **Network → Authenticated Origin Pulls** — generate cert, add to Caddy.
2. UFW on Hetzner: restrict ports 80/443 to Cloudflare IP ranges (auto-updated via a cron pulling cloudflare.com/ips-v4).
3. Keep SSH on a non-default port + key-only.

## 8. Smoke test after activation
```bash
curl -I https://swypik.com/ | grep -i cf-ray            # should have cf-ray header
curl -I https://swypik.com/_next/static/<chunk>.js | grep -i cf-cache-status  # HIT
curl -I https://swypik.com/api/explore/feed | grep -i cf-cache-status         # BYPASS
curl -s https://swypik.com/api/geo                                            # {"country":"<real>",...}
```
