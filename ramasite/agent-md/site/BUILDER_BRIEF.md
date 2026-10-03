# Shared brief for site builders (swypik.com v2 "Alabaster")

Workspace: e:\nexus — product root `site/` (Astro 7 + Tailwind 4, static). Branch `feat/site-alabaster` is already checked out.

## Read first (required)
- e:\nexus\AGENTS.md and e:\nexus\ramasite\docs\site\CLAIMS.md (claim guardrails — MUST follow)
- e:\nexus\site\src\styles\global.css (design tokens + global classes)
- e:\nexus\site\src\layouts\BaseLayout.astro
- e:\nexus\site\src\components\{Icon,AppCard,StatusBadge,Brand,BackersStrip}.astro and components\os\*
- e:\nexus\site\src\data\{modules,icons,backers,commands}.ts
- View the OS screenshots for the visual language:
  e:\nexus\ramasite\docs\swypik-os\workspace-expanded-preview.png, chat-expanded-preview.png, connectors-preview.png

## Visual language (SwypikOS "Alabaster")
LIGHT glassmorphism: alabaster #f5f5fb background (wallpaper provided by layout), translucent white glass panels with 1px white borders,
soft violet-tinted shadows, radius 16–28px, violet #7c3aed gradients for brand/primary, Plus Jakarta Sans, 24px line icons (1.7px stroke),
headings end with a violet dot (`<span class="dot">.</span>`), small uppercase letter-spaced eyebrows (#82769e).
Dark surfaces are allowed ONLY for media/terminal panels inside glass. Must look premium, investor-grade, "Apple/Linear-level" polish.

## The layout already provides (do NOT re-create)
- Fixed wallpaper, the floating capsule header (fixed; occupies top ~90px → start page heroes with padding-top ≈ 8.5rem),
  footer, and the fixed Ilaria command bar at the bottom (body has padding-bottom).
- Pages are rendered inside `<main id="main-content">` — do NOT add another <main>; use <section>s.
- `.reveal` elements fade up automatically on scroll (add `reveal reveal-d1..d4` classes).
- Usage: `<BaseLayout title="…" description="…">…</BaseLayout>`

## Global classes you should use
.shell .section .section-head(.center) .eyebrow(.pill-eyebrow) .display .section-title .dot .violet-text .lead
.glass .glass-strong .card .btn .btn-primary .btn-ghost .tone .tone-{violet,cyan,rose,amber,ink} .chip .chip-row .kbd .live-dot
Tokens: var(--ink) var(--muted) var(--soft) var(--brand) var(--brand-deep) var(--brand-soft) var(--eyebrow) var(--hover) var(--line) var(--line-strong) var(--shadow) var(--shadow-lg) var(--radius) var(--status)

## Hard rules
1. Do NOT edit shared files: styles/global.css, layouts/*, components/os/*, components/{Icon,AppCard,StatusBadge,Brand,BackersStrip}.astro, data/*.
   If you need an extra icon, inline the SVG in your own component (24 viewBox, stroke 1.7, round caps). If you truly need a shared change, message the parent agent.
2. Only create/edit the files assigned to you. Scoped `<style>` per file; client JS in `<script>` (TypeScript ok, Astro bundles it).
3. No new npm dependencies, no CDNs, no external images/fonts. Pure HTML/CSS/SVG/canvas.
4. Respect `prefers-reduced-motion` (static fallback). Pause canvas/animations when offscreen (IntersectionObserver). Responsive down to 360px.
5. English copy. Ambitious but TRUE: present-tense only for verified things; "designed to / roadmap / in development" for the rest (CLAIMS.md).
   NEVER mention: SWYP coin, Swypik Chain, crypto/mining/staking, Squad Buy, developer App Store, App Store/Google Play availability,
   user/GMV/catalog numbers, Ilaria as a GPT/frontier replacement, SwypikOS as a shipping Windows/macOS replacement.
6. The dev server is ALREADY running at http://localhost:4321 with hot reload. Do NOT start another dev server and do NOT run
   `npm run build`, `astro build` or `astro check` (the parent runs them). Verify your pages with
   `Invoke-WebRequest http://localhost:4321/<path>/ -UseBasicParsing` (expect 200). On 500, read the error log tail at
   C:\Users\abel\.gemini\antigravity\brain\d1931367-6323-40d7-91da-64e573b71b5b\.system_generated\tasks\task-79.log
7. No git operations (no commit/stash/checkout). Do not read secrets, .env files, weights or binaries.
8. When done, reply with: files created, a short description of each section, and any shared change you need.
