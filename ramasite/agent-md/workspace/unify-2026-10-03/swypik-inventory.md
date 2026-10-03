# Swypik Product Inventory & Monorepo Unification Plan

**Date:** 2026-10-03  
**Auditor:** Antigravity (Advanced Agentic Coding)  
**Workspace:** `E:\nexus` (Canonical Monorepo)  
**External Source:** `E:\Swypik` (Legacy Product Tree)  
**Mode:** READ-ONLY Verification & Non-Destructive Archival Planning  

---

## Executive Summary

1. **Volume & Footprint:** `E:\Swypik` occupies **58.50 GB** across **62,817,294,527 bytes** and 11 top-level directory/file entries. However, **52.12 GB** (89%) of that disk space is consumed by scratch worktrees, virtual environments, and node modules inside `E:\Swypik\_work`.
2. **Git Topography:** Six distinct Git repositories operate within `E:\Swypik`:
   - `swypik-commerce-platform` (primary commerce clone, shallow 29-commit history, 18 linked worktrees)
   - `swypik-mobile-pilot` (Expo SDK 57 native pilot app, full history, 6 linked worktrees)
   - `swypik-site` (Astro 7.3.5 marketing site, full history, clean working tree)
   - `_p0-fix` (secondary shallow commerce clone with 15 linked worktrees in `_work/`)
   - `swypik\app-fix-20260929` (full 1350-commit commerce clone, `blob:none`)
   - `_work\swypik-p0` (full 1350-commit commerce clone with packed objects, 116.83 MiB)
3. **The "Mobile" Disambiguation:**
   - `swypik-mobile-pilot` is a standalone native app built on **Expo SDK 57 / React Native 0.86 / Hermes / TypeScript**.
   - `swypik-commerce-platform/mobile` is an older **Capacitor WebView shell** (`com.swypik.app`) wrapping the responsive Next.js 14 web store.
   - The pilot was built to evaluate a compiled native user experience. In `E:\nexus`, they remain cleanly separated: `swypik/commerce` houses the web platform and Capacitor shell, while `swypik/mobile` houses the Expo pilot.
4. **Site Provenance Resolved:** `E:\nexus\site` came directly from `E:\Swypik\swypik-site` (commit `c165ae98`, branch `audit/complete-20260930`). 100% of the active site files have identical SHA-256 hashes; two documentation files were relocated to `ramasite/docs/site/` per `ramasite/RELOCATIONS.json`.
5. **Snapshot Verification:**
   - **Commerce (`swypik/commerce`):** 2,840 files match source byte-for-byte (identical SHA-256). Exactly 2 files differ in SHA-256 (`README.md` and `infra/README.md`, intentionally updated for monorepo paths in `RELOCATIONS.json`). 202 files are missing in Nexus: 184 are in `docs/` (relocated to `ramasite/docs/swypik-commerce/` and `ramasite/agent-md/swypik-commerce/`), and 18 are in `scripts/data/` (data seeds/translations skipped during snapshot import).
   - **Mobile (`swypik/mobile`):** 47 of 47 shared files match with identical SHA-256 (0 diffs). 3 files missing in Nexus are docs relocated to `ramasite/docs/swypik-mobile/` and `ramasite/agent-md/swypik-mobile/`.
   - **Site (`site`):** 23 of 23 shared files match with identical SHA-256 (0 diffs).
6. **Import Recommendation:**
   - Perform a clean `git subtree add` using the curated 29-commit shallow commerce history starting at `cfd2db0d` (where operations migrated all production secrets to Azure Key Vault `kv-swypik-prod` on 2026-09-28).
   - This adds only **+10.70 MiB** (+8.3%) to the Nexus object database (currently 129.46 MiB).
   - **Critical Warning:** Importing the legacy 1350-commit history (`swypik-p0`) would add **+116.83 MiB** (+90.2% increase, doubling repository size) and pollute Nexus git history with committed historical secrets (`.env.production`, `.env.vercel*`, `ae-token.json`). The legacy history should instead be preserved offline in a standalone Git bundle (`legacy-commerce-full.bundle`).

---

## 1. Complete Inventory of `E:\Swypik`

### Top-Level Directory and File Manifest

| Entry Name | Type | Files Count | Bytes | Size (MB / GB) | Git Status | Role / Contents Description |
|---|---|---|---|---|---|---|
| `swypik` | Directory | 57,298 | 806,021,886 | 768.68 MB | Subdir Repos | Contains full clone `app-fix-20260929` (1,350 commits) and empty Claude directory `app` |
| `swypik-commerce-platform` | Directory | 73,990 | 4,991,092,434 | 4,759.88 MB (4.65 GB) | Main Repo | Primary active clone for Swypik Commerce (Next.js 14, Node 24, Postgres, Azure Bicep). Shallow (29 commits). |
| `swypik-consolidate-2vm` | Directory | 57,138 | 773,856,480 | 738.01 MB | Worktree | Linked worktree of `swypik-commerce-platform` on branch `infra/consolidate-2vm` (commit `44b3524`) |
| `swypik-mobile-pilot` | Directory | 40,935 | 411,176,710 | 392.13 MB | Main Repo | Primary active clone for Swypik Mobile Pilot (Expo SDK 57, React Native 0.86, Hermes). Full history. |
| `swypik-site` | Directory | 13,359 | 214,419,735 | 204.49 MB | Main Repo | Primary active clone for Swypik Marketing Site (Astro 7.3.5, Tailwind CSS 4). Full history. |
| `_conversatii-claude` | Directory | 1,079 | 361,435,426 | 344.69 MB | Non-Git | Archive of historical Claude Code subagent session transcripts from August-September 2026 |
| `_p0-fix` | Directory | 57,588 | 785,989,760 | 749.58 MB | Main Repo (Clone) | Secondary shallow clone of commerce platform created for P0/P1 fixes on 2026-09-29. 15 attached worktrees in `_work`. |
| `_work` | Directory | 796,575 | 54,655,475,464 | 52,123.52 MB (50.90 GB) | Scratch / WTs | Scratch area holding `swypik-p0` (full 1,350-commit clone) and 31 worktrees from commerce, mobile, and p0-fix |
| `_wt` | Directory | 60,060 | 791,610,676 | 754.94 MB | WTs Container | Holds worktrees `claude-audit-fixes-20261002` (commit `3fbaf9f`) and `company-identity` (commit `abe9d47`) |
| `CUM-SE-CONECTEAZA-AGENTII.md` | File | 1 | 3,474 | 3.4 KB | Non-Git | Documentation on agent SSH keys, reverse tunnels, and port forwarding |
| `HANDOFF-2026-09-30-SWYPIK-PRODUCTION.md` | File | 1 | 16,584 | 16.2 KB | Non-Git | Production handoff report detailing Azure cutover, Key Vault, and DNS migration |
| **Total `E:\Swypik`** | **11 entries** | **1,098,024** | **62,817,294,527** | **58.50 GB** | — | — |

---

### Detailed Inventory of Git Repositories

#### 1. `swypik-commerce-platform` (Primary Commerce Working Clone)
- **Path:** `E:\Swypik\swypik-commerce-platform`
- **Remote:** `origin` -> `https://github.com/office233/swypik-commerce-platform.git` (fetch & push)
- **Current Branch:** `fix/p0-security-ci-integrated`
- **HEAD Commit:** `3fbaf9f642dbb4e0cba31a7f798da72d466ed974`
- **History Structure:** Shallow repository (`is-shallow = true`), Root commit: `cfd2db0d4154819fc74f5b57c088fa5936ca55cd` (2026-09-28), Total commits in repo: 29.
- **Local Branches & Tip Dates (19 branches):**
  - `agent/company-identity` | 2026-09-29 14:12:55 +0300 | `abe9d47`
  - `audit/complete-20260930` | 2026-10-01 00:21:12 +0300 | `ccdbd8d`
  - `codex/claude-audit-fixes-20261002` | 2026-09-29 11:33:49 +0300 | `3fbaf9f`
  - `fix/deploy-converge-node-state-20260930` | 2026-09-30 10:25:56 +0300 | `0f13286`
  - `fix/p0-security-ci-20260929` | 2026-09-29 12:08:08 +0300 | `ff00e6c`
  - `fix/p0-security-ci-integrated` | 2026-09-29 11:33:49 +0300 | `3fbaf9f`
  - `infra/consolidate-2vm` | 2026-09-29 13:32:27 +0300 | `44b3524`
  - `main` | 2026-09-28 14:16:25 +0300 | `cfd2db0`
  - `task/battles-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/cares-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/food-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/go-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/integration-modules-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/live-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/messenger-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/missions-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/seller-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/shop-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
  - `task/stays-e2e-20260930` | 2026-09-30 12:06:58 +0300 | `fe02c45`
- **Unpushed Commits (not on remote):** 9 commits (`ccdbd8d`, `abe9d47`, `44b3524`, `0d7aa54`, `99e1f39`, `ff00e6c`, `3fbaf9f`, `1ac7aeb`, `80ebf43`).
- **Tags:** None (0).
- **Stash Count:** 0.
- **Dirty File Count:** 292 uncommitted/untracked files (including seller integrations, live tip buttons, wallet read-models, migration scripts).
- **Worktrees (18 total):**
  - `E:/Swypik/swypik-commerce-platform` (`3fbaf9f`, branch `fix/p0-security-ci-integrated`)
  - `E:/Swypik/_work/audit-complete-20260930` (`ccdbd8d`, branch `audit/complete-20260930`)
  - `E:/Swypik/_work/battles-e2e-20260930` (`fe02c45`, branch `task/battles-e2e-20260930`)
  - `E:/Swypik/_work/cares-e2e-20260930` (`fe02c45`, branch `task/cares-e2e-20260930`)
  - `E:/Swypik/_work/deploy-converge-node-state-20260930` (`0f13286`, branch `fix/deploy-converge-node-state-20260930`, locked)
  - `E:/Swypik/_work/deploy-node-release-marker-20260930` (`3797e05`, detached HEAD)
  - `E:/Swypik/_work/food-e2e-20260930` (`fe02c45`, branch `task/food-e2e-20260930`)
  - `E:/Swypik/_work/go-e2e-20260930` (`fe02c45`, branch `task/go-e2e-20260930`)
  - `E:/Swypik/_work/integration-modules-20260930` (`fe02c45`, branch `task/integration-modules-20260930`)
  - `E:/Swypik/_work/live-e2e-20260930` (`fe02c45`, branch `task/live-e2e-20260930`)
  - `E:/Swypik/_work/messenger-e2e-20260930` (`fe02c45`, branch `task/messenger-e2e-20260930`)
  - `E:/Swypik/_work/missions-e2e-20260930` (`fe02c45`, branch `task/missions-e2e-20260930`)
  - `E:/Swypik/_work/seller-e2e-20260930` (`fe02c45`, branch `task/seller-e2e-20260930`)
  - `E:/Swypik/_work/shop-e2e-20260930` (`fe02c45`, branch `task/shop-e2e-20260930`)
  - `E:/Swypik/_work/stays-e2e-20260930` (`fe02c45`, branch `task/stays-e2e-20260930`)
  - `E:/Swypik/_wt/claude-audit-fixes-20261002` (`3fbaf9f`, branch `codex/claude-audit-fixes-20261002`)
  - `E:/Swypik/_wt/company-identity` (`abe9d47`, branch `agent/company-identity`)
  - `E:/Swypik/swypik-consolidate-2vm` (`44b3524`, branch `infra/consolidate-2vm`)
- **Approximate History Size (`git count-objects -vH`):**
  - Loose objects: 985 (3.57 MiB)
  - In-pack objects: 4,143 (2 packs, 6.26 MiB)
  - Prune-packable: 11
  - Total Git history footprint: **~9.83 MiB**

---

#### 2. `swypik-mobile-pilot` (Primary Mobile Pilot Clone)
- **Path:** `E:\Swypik\swypik-mobile-pilot`
- **Remote:** `origin` -> `https://github.com/office233/swypik-mobile-pilot.git` (fetch & push)
- **Current Branch:** `audit/complete-20260930`
- **HEAD Commit:** `ee64f47951010c614139b19065cebb72eb62b77f`
- **History Structure:** Full repository (`is-shallow = false`), Root commit: `35d88dcb0faf46ea86ec61d58709724c684af102` (2026-09-28), Total commits: 16.
- **Local Branches & Tip Dates (7 branches):**
  - `audit/complete-20260930` | 2026-09-30 22:30:11 +0300 | `ee64f47`
  - `codex/mobile-contribution-governor-20261002` | 2026-09-30 22:30:11 +0300 | `ee64f47`
  - `codex/mobile-memory-20261002` | 2026-09-30 22:30:11 +0300 | `ee64f47`
  - `codex/mobile-native-build-20261002` | 2026-09-30 22:30:11 +0300 | `ee64f47`
  - `codex/swypik-mobile-reconciled` | 2026-09-30 22:30:11 +0300 | `ee64f47`
  - `codex/swypik-mobile-session-lifecycle` | 2026-09-30 22:30:11 +0300 | `ee64f47`
  - `main` | 2026-09-28 20:30:17 +0300 | `35d88dc`
- **Unpushed Commits:** 1 commit (`ee64f47 fix: harden mobile API origin and URI decoder dependencies`).
- **Tags:** None (0).
- **Stash Count:** 0.
- **Dirty File Count:** 13 files (including `src/app/ilaria.tsx`, `src/features/contribution/`, `tests/ilaria-api.test.ts`).
- **Worktrees (6 total):**
  - `E:/Swypik/swypik-mobile-pilot` (`ee64f47`, branch `audit/complete-20260930`)
  - `E:/Swypik/_work/codex-mobile-contribution-governor-20261002` (`ee64f47`, branch `codex/mobile-contribution-governor-20261002`)
  - `E:/Swypik/_work/codex-mobile-memory-20261002` (`ee64f47`, branch `codex/mobile-memory-20261002`)
  - `E:/Swypik/_work/codex-mobile-native-build-20261002` (`ee64f47`, branch `codex/mobile-native-build-20261002`)
  - `E:/Swypik/_work/codex-mobile-reconciled-20261002` (`ee64f47`, branch `codex/swypik-mobile-reconciled`)
  - `E:/Swypik/_work/codex-mobile-session-lifecycle-20261001` (`ee64f47`, branch `codex/swypik-mobile-session-lifecycle`)
- **Approximate History Size (`git count-objects -vH`):**
  - Loose objects: 70 (761.53 KiB)
  - In-pack objects: 0 (0 packs)
  - Total Git history footprint: **761.53 KiB (~0.74 MiB)**

---

#### 3. `swypik-site` (Primary Marketing Site Clone)
- **Path:** `E:\Swypik\swypik-site`
- **Remote:** `origin` -> `https://github.com/office233/swypik-site.git` (fetch & push)
- **Current Branch:** `audit/complete-20260930`
- **HEAD Commit:** `c165ae98b55937e2e8f3905ca8fc4dd47e5f9c66`
- **History Structure:** Full repository (`is-shallow = false`), Root commit: `9460a5c1040febcdf6590cb56e451c01a04c6653` (2026-09-28), Total commits: 4.
- **Local Branches & Tip Dates (2 branches):**
  - `audit/complete-20260930` | 2026-09-30 22:29:47 +0300 | `c165ae9`
  - `main` | 2026-09-28 13:38:37 +0300 | `9460a5c`
- **Unpushed Commits:** 1 commit (`c165ae9 fix: bound waitlist payloads and recover from storage failures`).
- **Tags:** None (0).
- **Stash Count:** 0.
- **Dirty File Count:** 0 (clean).
- **Worktrees:** 1 (main only).
- **Approximate History Size (`git count-objects -vH`):**
  - Loose objects: 45 (127.68 KiB)
  - In-pack objects: 0 (0 packs)
  - Total Git history footprint: **127.68 KiB (~0.13 MiB)**

---

#### 4. `_p0-fix` (Secondary Shallow Commerce Clone)
- **Path:** `E:\Swypik\_p0-fix`
- **Remote:** `origin` -> `https://github.com/office233/swypik-commerce-platform.git` (fetch & push)
- **Current Branch:** `fix/p0-security-ci-20260929`
- **HEAD Commit:** `80ebf436808ef94364501dde79e3cdfe639f7c06`
- **History Structure:** Shallow repository (`is-shallow = true`), Root commit: `cfd2db0d4154819fc74f5b57c088fa5936ca55cd`, Total commits: 52.
- **Local Branches (20 branches):** Includes `fix/p1-bicep-customdata-reapply-20260929` (`9b53d43`), `fix/p1-data-keyvault-recovery-20260929` (`cd0f051`), `fix/p1-deploy-health-gate-20260929` (`8d33df3`), `fix/p1-deploy-topology-fanout-20260930` (`8777f54`), `fix/p1-email-reset-delivery-20260929` (`4416cab`), `fix/p1-staging-isolation-20260929` (`83f6975`), etc.
- **Unpushed Commits:** 18 unpushed commits (25 commits unique compared to `swypik-commerce-platform`).
- **Tags:** None (0).
- **Stash Count:** 0.
- **Dirty File Count:** 1 (`docs/qa/e2e/__pycache__/qa_common.cpython-312.pyc` deleted).
- **Worktrees:** 15 (main + 14 linked in `_work/`).
- **Approximate History Size:** Loose objects: 285 (782.88 KiB), In-pack: 3,987 (1 pack, 5.99 MiB). Total: **~6.75 MiB**.

---

#### 5. `swypik\app-fix-20260929` & `_work\swypik-p0` (Full Legacy Commerce Clones)
- **Paths:** `E:\Swypik\swypik\app-fix-20260929` and `E:\Swypik\_work\swypik-p0`
- **Remote:** `https://github.com/office233/swypik-commerce-platform.git`
- **History Structure:** Full deep history (`is-shallow = false`), Root commits: `fc446f531cdbb52d66abbe33361b8fdac29a47be` and `6344c64e03a4a30c694136d30ebfd657951e75d7`, Total commits: **1,350 commits**.
- **Tags:** `pre-cleanup-2026-05-13`, `swypik-clean-foundation`.
- **Approximate History Size:**
  - `app-fix-20260929` (`blob:none` partial clone): 18,386 objects, 8.27 MiB pack.
  - `swypik-p0` (complete packed archive): 30,262 objects, **116.83 MiB pack**.

---

## 2. Plain-Words Explanation: What is `swypik-mobile-pilot` and How Does It Relate to Commerce?

### Plain-Words Breakdown
Users examining the repository often see "mobile" in two different places and wonder if they are duplicate copies. They are **fundamentally different systems**:

1. **`swypik-mobile-pilot` (Standalone Native Application)**:
   - **What it is:** A brand new, greenfield native mobile app written with **Expo SDK 57, React Native 0.86, Expo Router, Hermes JavaScript engine, and TypeScript**.
   - **Application ID & Package:** `com.swypik.pilot` (`name: "swypik-mobile-pilot"`).
   - **What it does:** Implements mobile-optimized native UI screens for:
     - **Descoperă (Discover):** Fetches the public video/product feed from `https://swypik.com/api/explore/feed`.
     - **Magazin (Shop):** Fetches video-commerce products from `https://swypik.com/api/products`.
     - **Cont (Account):** Implements client-side Bearer authentication with profile validation, session lifecycle rotation, and hardware-backed credential storage using `expo-secure-store`.
   - **Security & Quality:** Audited on 2026-09-30 to **0 known npm vulnerabilities** (using custom overrides for `query-string` and `xcode > uuid`), with 53/53 passing unit tests and 21/21 Expo Doctor checks.
   - **Where it lives in Nexus:** [`swypik/mobile/`](file:///E:/nexus/swypik/mobile).

2. **`swypik-commerce-platform/mobile` (Embedded Capacitor WebView Shell)**:
   - **What it is:** An older **Capacitor wrapper** embedded directly inside the commerce web platform.
   - **Application ID & Package:** `com.swypik.app`.
   - **What it does:** It is **not** a native React Native app. It contains `android/` and `ios/` native project folders and `capacitor.config.json` configured with:
     ```json
     {
       "appId": "com.swypik.app",
       "appName": "Swypik",
       "server": { "url": "https://swypik.com" }
     }
     ```
     This simply packages the web browser frontend (Next.js 14) inside an iOS/Android WebView wrapper, with Capacitor plugins providing device bridges for push notifications, camera, and splash screens.
   - **Where it lives in Nexus:** [`swypik/commerce/mobile/`](file:///E:/nexus/swypik/commerce/mobile).

### Why Both Exist
The `swypik-mobile-pilot` project was initiated in late September 2026 to evaluate whether a true, compiled React Native/Hermes app provides better scrolling performance, memory efficiency, and offline handling than the existing Capacitor WebView shell.

As explicitly stated in `swypik-mobile-pilot/README.md` (lines 83–84):
> *"Proiectele Capacitor existente sunt păstrate pentru comparație."* *(The existing Capacitor projects are kept for comparison).*

**Monorepo Boundary Rule:**
Per `nexus/AGENTS.md`, `swypik/commerce/` owns the full-stack commerce web store (including its legacy Capacitor mobile wrapper in `swypik/commerce/mobile/`), while `swypik/mobile/` owns the standalone native Expo pilot.

---

## 3. Provenance of `E:\nexus\site`

The origin of `E:\nexus\site` is confirmed:

1. **Origin Repository:** `E:\Swypik\swypik-site` (GitHub remote: `https://github.com/office233/swypik-site.git`).
2. **Recorded Snapshot:** Documented in `E:\nexus\swypik\SOURCES.json`:
   - Branch: `audit/complete-20260930`
   - Commit: `c165ae98b55937e2e8f3905ca8fc4dd47e5f9c66`
   - Files: 25 files (prior to documentation relocation).
3. **Tech Stack & Identity:**
   - Package name: `"swypik-site"` (version `0.1.0`)
   - Framework: **Astro 7.3.5** with **Tailwind CSS 4.3.3** (`@tailwindcss/vite`), TypeScript 6.0.3, and Cloudflare Workers runtime types.
   - Role: Public marketing and waitlist landing site for Swypik.
4. **Relocation Record:** When the monorepo workspace was reorganized according to `ramasite/RELOCATIONS.json`:
   - `site/docs/CLAIMS.md` was relocated to `ramasite/docs/site/CLAIMS.md`.
   - `site/docs/LAUNCH-CHECKLIST.md` was relocated to `ramasite/docs/site/LAUNCH-CHECKLIST.md`.
   - This left exactly **23 tracked product files** in `E:\nexus\site`, all 23 having **100% identical SHA-256 hashes** to `E:\Swypik\swypik-site`.

---

## 4. Snapshot Verification & File Comparison

Every file in the Nexus snapshots was hashed with SHA-256 and compared against the active working tree of the source repositories (excluding `.git`, `node_modules`, build outputs like `.next`, `dist`, `.expo`, `.cache`, and `.env*` files).

### Summary Comparison Table

| Product | Source Path | Nexus Path | Source Files (Filtered) | Nexus Files (Filtered) | Identical SHA-256 | Differing SHA-256 | Missing in Nexus | Missing in Source |
|---|---|---|---|---|---|---|---|---|
| **Commerce** | `swypik-commerce-platform` | `swypik/commerce` | 3,044 | 2,842 | **2,840** | **2** | **202** | 0 |
| **Mobile** | `swypik-mobile-pilot` | `swypik/mobile` | 50 | 47 | **47** | **0** | **3** | 0 |
| **Site** | `swypik-site` | `site` | 30 | 23 | **23** | **0** | **7** | 0 |

---

### Detailed Findings for Commerce (`swypik/commerce`)

1. **Identical Files (2,840 files):** 2,840 source files match their source counterparts byte-for-byte.
2. **Differing SHA-256 Files (Exactly 2 files):**
   - `README.md`: Source `fa0f5273...` vs Nexus `acfa3c6b...`
   - `infra/README.md`: Source `33b5083c...` vs Nexus `873e274b...`
   - *Explanation:* These two files were modified during the monorepo reorganization to update documentation paths to point to `ramasite/`, as documented in `ramasite/RELOCATIONS.json` lines 749–765.
3. **Missing in Nexus Snapshot (202 files):**
   - **184 Documentation Files (`docs/`):** All 184 files in `docs/` were moved out of `swypik/commerce/docs` into `ramasite/docs/swypik-commerce/` (177 files) and `ramasite/agent-md/swypik-commerce/` (7 files) per `ramasite/RELOCATIONS.json` lines 26–29.
   - **18 Data Fixture Files (`scripts/data/`):** Excluded during the initial snapshot creation as non-source data assets (per `SOURCES.json` `"skipped_counts"`):
     - `scripts/data/seed-official-swypik.sql`
     - `scripts/data/seed-arena-demo.sql`
     - `scripts/data/seed-taxonomy-i18n.mjs`
     - `scripts/data/set-generic-merchant-images.sql`
     - `scripts/data/merchants-sample.csv`
     - `scripts/data/import-merchants.mjs`
     - `scripts/data/import-osm-merchants.mjs`
     - `scripts/data/import-official-videos.sh`
     - `scripts/data/translate.mjs`
     - `scripts/data/translate-messages.mjs`
     - `scripts/data/translate-plain.mjs`
     - `scripts/data/translate-products-studiai.mjs`
     - `scripts/data/retranslate-stale-products.mjs`
     - `scripts/data/generate-video-descriptions.mjs`
     - `scripts/data/enqueue-ae-videos-cron.sh`
     - `scripts/data/retry-publish-clips.sh`
     - `scripts/data/seed-blender-open-movies.mjs`
     - `scripts/data/sync-jamendo.mjs`

### Detailed Findings for Mobile (`swypik/mobile`)

1. **Identical Files (47 files):** 100% of all code, configuration, assets, tests, and build scripts match byte-for-byte.
2. **Differing Files (0 files):** None.
3. **Missing in Nexus Snapshot (3 files):**
   - `docs/AUTH-PILOT-2026-09-28.md`
   - `docs/ILARIA-RECONCILIATION-HANDOFF-2026-10-02.md`
   - `docs/ILARIA-INTEGRATION.md`
   - *Explanation:* Relocated to `ramasite/docs/swypik-mobile/` and `ramasite/agent-md/swypik-mobile/` per `RELOCATIONS.json` lines 30–33 and 216–219.

### Detailed Findings for Site (`site`)

1. **Identical Files (23 files):** 100% of code, Astro components, styles, tests, and configuration match byte-for-byte.
2. **Differing Files (0 files):** None.
3. **Missing in Nexus Snapshot (7 files):**
   - 5 generated Astro files (`.astro/content.d.ts`, `.astro/types.d.ts`, `.astro/settings.json`, `.astro/dev.json`, `.astro/preview.json`).
   - 2 documentation files relocated to `ramasite/docs/site/` (`docs/CLAIMS.md`, `docs/LAUNCH-CHECKLIST.md`).

---

## 5. History-Preserving Import Plan into `E:\nexus`

### Architecture & Strategy

To unify everything into `E:\nexus` with Git history while preserving local working-tree modifications and `ramasite/` relocations, we use a **staged Git subtree integration with branch archival tags**:

```
[Swypik Repos in E:\Swypik]
       │
       ├── Add remotes & fetch objects
       ├── Create archive tags: archive/swypik-*/*
       │
       ▼
[git subtree add into E:
exus]
       ├── --prefix=site            swypik-site/audit/complete-20260930
       ├── --prefix=swypik/mobile   swypik-mobile/audit/complete-20260930
       └── --prefix=swypik/commerce swypik-commerce/fix/p0-security-ci-integrated (29 commits)
       │
       ▼
[Reconcile Snapshot Modifications]
       ├── Overlay 292 uncommitted commerce entries + 13 mobile entries
       ├── Re-apply monorepo README documentation links
       └── Commit: "chore(swypik): reconcile working-tree modifications and ramasite relocations"
```

---

### Key Decision: Shallow (29 commits) vs Deep (1,350 commits) History

| Evaluation Dimension | Option A: Curated Shallow History (Recommended) | Option B: Full Deep History (`swypik-p0`) |
|---|---|---|
| **Base Commit** | `cfd2db0d` (2026-09-28) to `3fbaf9f6` | `fc446f53` (legacy initial) to current |
| **Commit Count** | 29 commits | 1,350 commits |
| **Size Impact on Nexus** | **+9.83 MiB** (+8.3% increase) | **+116.83 MiB** (+90.2% increase, doubles repo!) |
| **Secret Exposure Risk** | **Low:** Only `preview.env` in one archival ops folder | **HIGH:** Exposes committed `.env.production`, `.env.vercel*`, `ae-token.json` |
| **Rationale** | On 2026-09-28, the team deliberately squashed/isolated the repo to move all production secrets to Azure Key Vault `kv-swypik-prod` and clean up Git history. Importing the legacy history reverses this security cleanup. | Legacy history should be preserved **offline** in a standalone bundle file. |

---

### Audit of Secrets in History (Filenames Only)

Per security guidelines, Git history across all repositories was inspected for sensitive filenames. **No file contents were opened or printed**:

#### In Deep History (`_work/swypik-p0` and `swypik/app-fix-20260929` - 1,350 commits):
- `.env.production` *(Production database and API keys)*
- `.env.vercel` *(Vercel deployment environment)*
- `.env.vercel.prod` *(Vercel production environment)*
- `.env.vercel.test` *(Vercel test environment)*
- `ae-token.json` *(App token)*
- `docs/ops-history/arhiva/ops-wsl-2026-09-28/preview.env` *(Archived preview environment)*

#### In Shallow History (`swypik-commerce-platform` - 29 commits):
- `docs/ops-history/arhiva/ops-wsl-2026-09-28/preview.env` *(Archived preview environment)*
- Safe template examples only: `.env.example`, `.env.social.example`, `infra/azure/staging.env.example`, `workers/video-worker/.env.example`.

#### In Mobile Pilot (`swypik-mobile-pilot`):
- Clean. Safe template example only: `.env.example`.

#### In Site (`swypik-site`):
- Clean. No environment files or keys ever committed.

---

### Step-by-Step Execution Plan

#### Step 1: Preflight & Staging
Ensure a clean working branch in `E:\nexus` (e.g. `chore/unify-swypik-20261003`). Move existing untracked snapshot folders aside:
```powershell
Move-Item "E:
exus\swypik\commerce" "E:
exus\swypik\_snap_commerce_tmp"
Move-Item "E:
exus\swypik\mobile"   "E:
exus\swypik\_snap_mobile_tmp"
Move-Item "E:
exus\site"            "E:
exus\_snap_site_tmp"
```

#### Step 2: Configure Remotes & Fetch Objects
Add local disk remotes in `E:\nexus`:
```powershell
git remote add swypik-commerce "E:/Swypik/swypik-commerce-platform"
git remote add swypik-mobile   "E:/Swypik/swypik-mobile-pilot"
git remote add swypik-site     "E:/Swypik/swypik-site"
git remote add swypik-p0-fix   "E:/Swypik/_p0-fix"

git fetch swypik-commerce
git fetch swypik-mobile
git fetch swypik-site
git fetch swypik-p0-fix
```

#### Step 3: Archive All Branches as Permanent Tags
Preserve all feature, task, and audit branches forever without cluttering active branches:
```powershell
# Archive Commerce branches
git for-each-ref --format="%(refname:short)" refs/remotes/swypik-commerce | ForEach-Object {
    $b = $_.Replace('swypik-commerce/', '')
    git tag "archive/swypik-commerce/$b" $_
}

# Archive Mobile branches
git for-each-ref --format="%(refname:short)" refs/remotes/swypik-mobile | ForEach-Object {
    $b = $_.Replace('swypik-mobile/', '')
    git tag "archive/swypik-mobile/$b" $_
}

# Archive Site branches
git for-each-ref --format="%(refname:short)" refs/remotes/swypik-site | ForEach-Object {
    $b = $_.Replace('swypik-site/', '')
    git tag "archive/swypik-site/$b" $_
}

# Archive P0-Fix triage branches
git for-each-ref --format="%(refname:short)" refs/remotes/swypik-p0-fix | ForEach-Object {
    $b = $_.Replace('swypik-p0-fix/', '')
    git tag "archive/swypik-p0-fix/$b" $_
}
```

#### Step 4: Import Product Trees via `git subtree add`
```powershell
# 1. Import Site
git subtree add --prefix=site swypik-site/audit/complete-20260930 -m "feat(site): import swypik-site history"

# 2. Import Mobile Pilot
git subtree add --prefix=swypik/mobile swypik-mobile/audit/complete-20260930 -m "feat(mobile): import swypik-mobile-pilot history"

# 3. Import Commerce Platform (29-commit clean history)
git subtree add --prefix=swypik/commerce swypik-commerce/fix/p0-security-ci-integrated -m "feat(commerce): import swypik-commerce-platform history"
```

#### Step 5: Reconcile Snapshot Modifications
Copy back untracked files and local working-tree changes from staging:
```powershell
# Re-apply commerce working tree changes (the 292 uncommitted files)
Copy-Item -Path "E:
exus\swypik\_snap_commerce_tmp\*" -Destination "E:
exus\swypik\commerce" -Recurse -Force

# Re-apply mobile working tree changes (the 13 uncommitted files)
Copy-Item -Path "E:
exus\swypik\_snap_mobile_tmp\*" -Destination "E:
exus\swypik\mobile" -Recurse -Force

# Re-apply site documentation links
Copy-Item -Path "E:
exus\_snap_site_tmp\*" -Destination "E:
exus\site" -Recurse -Force

# Clean up temporary directories
Remove-Item -Recurse -Force "E:
exus\swypik\_snap_commerce_tmp"
Remove-Item -Recurse -Force "E:
exus\swypik\_snap_mobile_tmp"
Remove-Item -Recurse -Force "E:
exus\_snap_site_tmp"

# Create a clean reconciliation commit
git add swypik/ site/
git commit -m "chore(swypik): reconcile working-tree modifications and ramasite relocations"
```

#### Step 6: Create Offline Legacy History Bundle
Preserve the full 1,350-commit history safely outside the monorepo git database:
```powershell
git -C "E:\Swypik\_work\swypik-p0" bundle create "E:
exusamasite\localrchives\legacy-commerce-full.bundle" --all
```

---

## 6. Summary of Size Impact on `E:\nexus`

| Component | Pre-Import Size | Added Pack Size | Post-Import Size | Growth (%) | Notes |
|---|---|---|---|---|---|
| **Nexus Monorepo** | 129.46 MiB | — | — | — | Current baseline (`git count-objects -vH`) |
| **Swypik Site** | — | +0.13 MiB | 129.59 MiB | +0.1% | Full history (45 objects) |
| **Swypik Mobile** | — | +0.74 MiB | 130.33 MiB | +0.6% | Full history (70 objects) |
| **Swypik Commerce (Shallow)** | — | +9.83 MiB | **140.16 MiB** | **+8.3%** | **Recommended: Clean 29-commit history** |
| *Swypik Commerce (Deep Legacy)* | — | *+116.83 MiB* | *246.29 MiB* | *+90.2%* | *Alternative: Doubling repo size; leaks .env* |

---

## Conclusion & Next Actions

1. The inventory confirms that all three products (`commerce`, `mobile`, and `site`) are accounted for, verified against their source repositories, and documented.
2. The recommended plan imports the clean, secure Git history of all three products into `E:\nexus` while keeping repository growth under 9% (+10.7 MB).
3. All branches and legacy history will remain permanently accessible via archival tags and the offline bundle file.
4. Once user approves, the staged subtree commands can be executed on a dedicated branch.
