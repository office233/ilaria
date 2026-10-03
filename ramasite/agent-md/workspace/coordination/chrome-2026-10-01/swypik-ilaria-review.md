# Independent Swypik–Ilaria integration review

State: REVIEW COMPLETE / CHANGES REQUESTED / FROZEN / NOT INTEGRATED. 2026-10-01.
Scope: static review only; no tests, builds, installs, service/model calls or product changes.
Nexus root: `C:/Users/abel/.codex/worktrees/swypik-ilaria-gateway/nexus`.
App root: `E:/Swypik/_work/codex-mobile-session-lifecycle-20261001`.
Workspace, Ilaria, SwypikOS and App AGENTS were read; product boundaries are preserved.

## Baseline and checksum evidence

- Prepared baseline SHA256: `cebb594c30db031d827ae70db548a7c8220cf62202bdc9187bac93b607b09498`, MATCH.
- External final-hash registry SHA256: `4af41991710c21076694d5877744b2854c63cbb8635766569d77f03ce7368bb9`.
- All **21/21 final claims** MATCH: 15 App and six Nexus, including both owner documents.
- Owner Nexus handoff SHA256: `8d6844cbd6b2f92ca422a8f6978ca19340fc63d68c9c6c5534fb2b3737848334`.
- All **20/20 protected App** and **430/430 protected gateway** hashes MATCH the prepared baseline.
- All **39/39 public overlays in Main** and **39/39 in gateway** MATCH baseline Main references.
- All **4/4 other frozen auth references** and **3/3 frozen native references** MATCH owner freeze checks.
- Three original App claim backups MATCH their before hashes; exact before/final diffs were reviewed.
- All six Nexus Main claim destinations are still absent; no integration has occurred.
- Main/gateway HEAD: `06a5f39f805cf36897e05ffe306d05ed212a5a3a`, MATCH.
- App HEAD: `ee64f47951010c614139b19065cebb72eb62b77f`, MATCH.
- Main index SHA256: `af9b693679d12804808cadba01b937542758b9dafdb79af9c41502d06dd464cc`, MATCH.
- These are the recorded public closure checks, not a hash audit of private/ignored data or the original App's entire checkout.

## Every claim read

App: `src/app/_layout.tsx`; `src/app/ilaria.tsx`; `src/lib/auth-core.ts`;
`src/lib/ilaria-api.ts`; `src/lib/ilaria-wire.ts`; `src/features/ilaria/IlariaScreen.tsx`;
`src/features/ilaria/useIlaria.ts`; `src/features/contribution/client.ts`;
`src/features/contribution/consent.ts`; `src/features/contribution/ContributionPanel.tsx`;
`tests/auth.test.ts`; `tests/ilaria-api.test.ts`; `tests/ilaria-lifecycle.test.ts`;
`tests/contribution-consent.test.ts`; `docs/ILARIA-INTEGRATION.md`.
Nexus: `ilaria/runtime/mobileprovider/provider.py`; `ilaria/runtime/mobileprovider/test_provider.py`;
`swypik-os/internal/mobilegateway/gateway.go`; `swypik-os/internal/mobilegateway/gateway_test.go`;
`swypik-os/cmd/mobile-gateway/main.go`; `docs/coordination/chrome-2026-10-01/swypik-ilaria-integration-handoff.md`.
Relevant unchanged AuthProvider/lifecycle, Myriad DTOs and process-group/transport code were also traced.

## Actionable findings

**P2 — Quarantine uncertain cleanup before admitting another worker.**
`swypik-os/internal/mobilegateway/gateway.go:507–519` records `ErrCleanup` as `uncertain`,
closes `run.done` and releases the concurrency slot unconditionally. Admission at 405–483
only checks `g.closed`, record capacity and free slots; a different task can therefore start
while the earlier group's teardown is explicitly unverified. This undermines the configured
concurrency/resource bound in precisely the failure branch where remaining owned work is unknown.
Fail closed for further inference until cleanup is independently confirmed, or quarantine/close
the gateway on `ErrCleanup`; control/status should still report uncertainty. Add a cleanup-failure
then second-task discriminator proving no second provider invocation. The existing test at
`gateway_test.go:133` checks the acknowledgement and Close error, but not subsequent admission.

**P2 — Recheck the request deadline immediately before publishing success.**
`src/lib/ilaria-api.ts:75–85` checks session currency, foreground/consent and abort state,
but never compares the current time with `request.deadline_unix_ms`. An overdue timeout callback
can be pending behind a response continuation after host/event-loop suspension; the continuation
publishes success and its finally block clears that timer. A still-live session is insufficient:
the request expires earlier (25 seconds maximum). Reject an expired request before publication
and use the correlated cancellation path; test a delayed response continuation with the timeout
callback not yet serviced. Existing lifecycle tests cover late cancellation, not this deadline race.
Both findings are derived statically; no new reproduction test was run during this read-only review.

## Supported behavior and evidence limits

The auth lease captures account, session epoch, expiry and fixed HTTPS routes without returning
the opaque token. No new token persistence/logging, JWT authority, cross-product internal imports,
training loop, tool authority or chat/gallery donation path was found in these claims.
Go/TS/Python reject duplicate/unknown/missing/null/unsafe Myriad fields; generated DTOs remain unchanged.
Cancellation uses a separate correlated request; actual ProcessProvider waits for root process exit
and group cleanup before its return, and cleanup failure is reported uncertain rather than stopped.
Remote inference consent is separate from initially-off data and compute contributions; their UI is disabled.
Existing owner logs contain 136 mobile PASS and 32 final provider PASS, plus the actual TS→HTTPS→IMC
and worker-start/cancel markers. These are inspected owner evidence, not independently rerun gates.
The cancellation marker's word `receipt` is a correlated HTTPS status acknowledgement, not a signed network receipt.
Canary executes canonical random-init IMC forwards; it does not establish trained-model or answer quality.
Still missing: approved production artifact/tokenizer/backend/proxy, native APK/AAB/IPA and device gates,
phone inference/training executor, signed jobs/leases/evaluation/promotion/rollback receipts and accepted
NETWORK/Swarm handoff. No Linux gateway, race, background-device guarantee or energy measurement is proved.
Native fetch internal buffering and aggregate gateway/host CPU/RAM remain explicitly unverified/uncapped.
These missing goal criteria are follow-up milestones, not hidden implementation claims in the owner report.

Both worktree `git diff --check` checks passed; this report's added-file whitespace check passed.
Source/checksum checks were repeated before handoff; all reviewed/protected source hashes remain unchanged.
Review SHA256 is supplied in the parent handoff after freezing this file; no circular self-hash is embedded.
FREEZE/STOP: only this new review report was written; owner claims and Main/index/history were not modified.
