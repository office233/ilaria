# Swypik site launch checklist

## Cloudflare Pages

- Build command: `npm run build`
- Static output directory: `dist`
- Node runtime: 24
- Deploy the repository `functions/` directory together with the Pages project.
- Confirm `public/_headers` is applied on the preview deployment.

## D1 waitlist

- Create the production D1 database.
- Apply `db/migrations/0001_waitlist.sql`.
- Bind the database to Pages Functions as `DB`.
- Verify first signup returns `201`.
- Verify the same normalized email returns `200` with `existing: true`.
- Verify invalid email, missing consent, non-JSON input and honeypot behavior.
- Add Turnstile or an edge rate-limit rule if production spam volume warrants it.

## Product routing

- Keep the existing Swypik application untouched until the marketing preview is approved.
- Prepare and verify the application on `app.swypik.com`.
- Update site links only after that destination is live.
- Perform the `swypik.com` DNS/cutover as a separate operation with a rollback path.

## Legal and communications

- Replace provisional Privacy/Terms language with the final operating legal entity and jurisdiction.
- Add verified privacy, support and press contact addresses.
- Connect the actual outbound-email provider and unsubscribe workflow before sending waitlist campaigns.

## Final QA

- Test desktop and mobile on the deployed Pages preview.
- Run Lighthouse on the deployed preview, not only localhost.
- Check keyboard navigation and the skip link.
- Submit the waitlist end-to-end against production D1.
- Verify `robots.txt`, `sitemap.xml`, `llms.txt`, canonical URLs and Open Graph preview.
- Validate social sharing with the final `og-preview.jpg`.
- Only then change production DNS.
