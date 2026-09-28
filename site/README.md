# Swypik Marketing Site

Static marketing site for the Swypik ecosystem: Swypik, Ilaria and SwypikOS.

## Stack

- Astro, static output
- Tailwind CSS v4 through Vite
- Vanilla client-side motion only where needed
- Cloudflare Pages Functions + D1 for the waitlist

## Local development

Use Node 24 (the repository includes `.node-version`).

```powershell
npm ci
npm run dev
```

Production build:

```powershell
npm run build
```

## Cloudflare waitlist

1. Create a D1 database (for example `swypik-waitlist`).
2. Apply `db/migrations/0001_waitlist.sql`.
3. Bind the D1 database to the Pages project as `DB`.
4. Deploy the static `dist/` output and the `functions/` directory through Cloudflare Pages.

The homepage form posts to `/api/waitlist`.

The site also ships:

- `robots.txt` + generated `sitemap.xml`
- `llms.txt` with explicit capability boundaries
- Cloudflare Pages security/cache headers in `public/_headers`
- a dedicated 1200×630 Open Graph image

See `docs/CLAIMS.md` before changing product claims and
`docs/LAUNCH-CHECKLIST.md` before the public DNS cutover.

## Launch gates

Before public cutover:

- Replace the provisional legal copy with reviewed operator/legal-entity details.
- Connect verified support/privacy/press contact addresses.
- Verify the future `app.swypik.com` destination before linking it.
- Capture real product screenshots for the final device mockups if desired.
- Run Lighthouse, accessibility and mobile-browser checks on the deployed Pages preview.
