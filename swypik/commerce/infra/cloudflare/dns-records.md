# Cloudflare DNS Records — swypik.com

> All records should have **Proxy status: Proxied** (orange cloud) to benefit from
> Cloudflare DDoS protection, caching, and SSL termination.

## Records

| Type  | Name                | Content / Target               | Proxy  | TTL  | Notes                               |
|-------|---------------------|--------------------------------|--------|------|-------------------------------------|
| A     | `swypik.com`        | `<HETZNER_VPS_IP>`             | Proxied| Auto | Main domain → Hetzner VPS           |
| CNAME | `www.swypik.com`    | `swypik.com`                   | Proxied| Auto | www redirect                        |
| CNAME | `media.swypik.com`  | `<R2_PUBLIC_BUCKET_URL>`       | Proxied| Auto | CDN for R2 media assets             |

### Placeholder Values

- `<HETZNER_VPS_IP>` — Replace with the Hetzner VPS public IPv4 address.
- `<R2_PUBLIC_BUCKET_URL>` — Replace with the R2 public access hostname  
  (e.g. `pub-xxxxxx.r2.dev` or `swypik-media.<account-id>.r2.cloudflarestorage.com`).

---

## Setting Up R2 Custom Domain (`media.swypik.com`)

Follow these steps in the **Cloudflare Dashboard**:

### 1. Enable Public Access on the R2 Bucket

1. Go to **R2 → Overview → swypik-media** (or your bucket name).
2. Click **Settings** tab.
3. Under **Public access**, click **Connect Domain**.
4. Enter `media.swypik.com` and click **Continue**.
5. Cloudflare will automatically create the required CNAME record  
   (if not already present from the table above, it will override it).

### 2. Verify DNS

1. Navigate to **DNS → Records** for `swypik.com`.
2. Confirm the CNAME for `media.swypik.com` exists and is **Proxied**.
3. Cloudflare automatically provisions an SSL certificate for custom hostnames.

### 3. Configure CORS on the Bucket

Apply the CORS config from `r2-cors.json`:

```bash
# Using wrangler CLI
npx wrangler r2 bucket cors put swypik-media --file infra/cloudflare/r2-cors.json
```

### 4. Configure Lifecycle Rules

Apply the lifecycle policy from `r2-lifecycle.json`:

```bash
npx wrangler r2 bucket lifecycle set swypik-media --file infra/cloudflare/r2-lifecycle.json
```

### 5. Configure Cache Rules (Optional but Recommended)

In **Cloudflare Dashboard → Rules → Cache Rules**, create a rule:

- **When**: Hostname equals `media.swypik.com`
- **Then**: Cache eligible (Edge TTL: 1 month, Browser TTL: 1 year)

This ensures all media assets served through R2 benefit from Cloudflare's edge cache.

### 6. Verify

```bash
curl -I https://media.swypik.com/test-asset.jpg
# Should return 200 with cf-cache-status header
```

---

## SSL / TLS

- **Mode**: Full (Strict) — set in **SSL/TLS → Overview**
- Cloudflare auto-provisions edge certificates for all subdomains.
- Caddy on Hetzner handles origin certificates (or use Cloudflare Origin CA).

## Security Headers

Managed by Caddy (see `infra/hetzner/Caddyfile`). Cloudflare adds additional
headers like `cf-ray`, `cf-cache-status` automatically.
