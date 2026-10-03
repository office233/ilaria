# Ilaria integration: foreground inference handoff

State: **FROZEN, awaiting independent review; not integrated into the original app or Nexus Main.**
Date: 2026-10-01. App worktree: `E:/Swypik/_work/codex-mobile-session-lifecycle-20261001`.
App HEAD: `ee64f47951010c614139b19065cebb72eb62b77f`. Nexus gateway worktree: `C:/Users/abel/.codex/worktrees/swypik-ilaria-gateway/nexus`.
Preparation baseline: `C:/Users/abel/AppData/Local/Temp/nexus-mobile-gateway-20261001/baseline.json`, SHA256 `cebb594c30db031d827ae70db548a7c8220cf62202bdc9187bac93b607b09498`.

## Working slice

The Ilaria tab routes to `IlariaScreen`; `useIlaria` owns a foreground-only `IlariaClient`.
The actual client sends canonical Myriad `CorticalRequest` to authenticated HTTPS
`/api/ilaria/infer`, and reads the text from canonical `CorticalResponse.hypothesis`.
The host gateway delegates authentication to an explicitly configured HTTPS backend
`/api/auth/me`, then starts the canonical Python `ImcTransformer` through an owned native process group.
There is no JS model, duplicate optimizer, parallel protocol, app-side JWT decoding, or model answer fixture.
The runnable CLI currently requires an explicit synthetic canary. An approved production artifact/tokenizer/provider is still a required follow-up.

The existing auth configuration remains disabled by default. `AuthController.authorizeInference`
returns an opaque lease for fixed paths on the approved session origin; it does not expose the token.
The lease captures session epoch, identity and expiry. Logout, replacement, expiry or revoke
invalidates inference; stale/cross-account replies cannot populate the screen.
The existing session storage mechanism remains the sole persistence path.
The app expects inference routes at the same approved HTTPS origin as auth; production proxy/backend wiring has not been deployed or enabled.

Foreground withdrawal, Android blur, logout, consent revocation, timeout, unmount and memory warning
cancel owned work. The client aborts its fetch and separately requests authenticated `/cancel`.
A stopped state requires a canonical server acknowledgement after the owned worker has exited;
network/auth/cleanup failures remain uncertain. Captured credentials can request cancellation
during local session invalidation, but backend revocation may prevent acknowledgement.
A cancelled-before-start task is tombstoned; duplicate/mutated requests are refused.
The gateway ledger is bounded and in memory: this inference slice does not claim durable training replay protection.

## Consent and product state

Remote inference has an explicit consent independent of contribution consent.
Data contribution and compute contribution are distinct, initially off and currently disabled.
The UI reports unavailable/awaiting release because there is no released network/phone executor.
No gallery, chats, personal history or prompt is exported for global training.
Neither a toggle nor a consent record grants signed-job/issuer/model-promotion authority.
Training, signed contribution receipts, phone execution and NETWORK20 integration remain follow-ups.
An end user does not need to install SwypikOS; the gateway is an operator service.

## Wire and bounds

The TS projection is checked against unchanged canonical `ilaria/specs/myriad.manifest.json`;
the gateway uses the unchanged generated Go DTOs. Roles are inference-only, text-only,
LOCAL_PRIVATE/PUBLIC, and require no-training/no-tools constraints.
Wire decoding rejects duplicates, aliases, unknown/missing/null fields, trailing JSON,
invalid UTF-8/surrogates, nonfinite numbers and integers above 2^53-1.
Requests/responses are capped at 64 KiB, nesting at 16, prompts at 4096 UTF-8 bytes,
generation at 16 tokens, and deadline at 30 seconds; the app requests 4 tokens within 25 seconds.
Responses carry model/config/tokenizer/source hashes, version, canary status and scoped metrics.
A supplied model hash is checked against the owned model weights in memory.
Native fetch without streaming is guarded by Content-Length and decoded-byte checks;
a hard cap on the native fetch implementation's internal buffering is not proved on devices.

## Evidence on this Windows host

The real integration loads these TypeScript client/auth sources in Node and exercises an HTTPS
test auth backend, gateway, native worker and actual canonical IMC forwards.
The fixture is an in-process seeded random-init IMC (32 tokens, d32, one layer); it is labelled
TEST and has no claimed conversation quality, trained capability or pilot promotion.

Latest full OS run: 4 actual forwards; model SHA256
`85f701dc96ba5259966e7bb7edc8ea97e92356e7508aa06f752da475e11fed42`.
Worker CPU 2,484,375,000 ns; worker peak RSS 205,602,816 bytes.
Gateway process CPU delta 15,625,000 ns; process-lifetime peak RSS 50,126,848 bytes.
These are separate process measurements, not total host caps or a power estimate; energy is unmeasured.
A second actual worker start is observed before foreground withdrawal:
`worker_started=true receipt=verified_stopped late_result=discarded`.
The worker uses Windows Job Objects. Linux requires a delegated cgroup-v2 root and refuses unsupported containment.

Passed: all 136 mobile tests (105 existing + 31 new), TypeScript typecheck, normal Expo 57 lint,
Ilaria worktree Go vet/tests (12 packages), OS worktree Go vet/tests (55 packages),
canonical Python tests (47) and final provider tests (32).
The Python coverage is composed: 74 passed before final provider hardening; final provider32 passed afterward.
Direct root-wide ESLint additionally reports an inherited `__dirname` issue in frozen
`scripts/apply-query-string-interop.cjs`; the supported Expo lint gate passes.
No native app build/device run, Linux gateway execution or Go race gate was performed in this milestone.

Logs: `C:/Users/abel/AppData/Local/Temp/nexus-mobile-gateway-20261001/`.
Reproduction uses the existing Node/Go/Python dependencies, `NEXUS_MYRIAD_MANIFEST` pointing at the
canonical worktree manifest, and `NEXUS_MOBILE_APP_ROOT` pointing at this app worktree.
Run mobile `node --experimental-strip-types --test tests/*.test.ts`,
`node node_modules/typescript/bin/tsc --noEmit` and `node node_modules/expo/bin/cli lint`.
For Go use GOWORK=off, GOPROXY=off, GOTOOLCHAIN=local, GOSUMDB=off and an owned Temp GOCACHE.
Python runs with -B and Temp caches; no dependency installation or pretrained artifact access is required.
Official APIs were checked against [Expo 57 Router](https://docs.expo.dev/versions/v57.0.0/sdk/router/)
and [React Native AppState](https://reactnative.dev/docs/appstate).

## Remaining work before a usable production assistant

Independent review must precede integration. Next wire an approved production IMC runtime/tokenizer/artifact
and a real authenticated same-origin backend, then prove release-build/device behavior.
The canary is a real execution test and is not a useful conversational model.
iOS/Android background execution, on-device training, signed network contributions and durable promotion/rollback
are not delivered here; no always-on, smartphone full-model training or energy-saving guarantee is made.
TLS test fixtures and synthetic tokens authenticate the test only, not an operator-approved production deployment.

## Exact app source freeze

Only route additions were made to `_layout.tsx`; reopened auth changes are confined to
`auth-core.ts` and `auth.test.ts`. The other four auth handoff files, three native readiness files,
configuration/package/source-generation files and the original repository remain frozen.
The app documentation is the fifteenth claim; the following fourteen source/test hashes exclude this document.

| File | SHA256 |
| --- | --- |
| `src/app/_layout.tsx` | `24be333da3f8ce5aec563d753f4cc676cb1bf8984b914b88bb444c5ee5852b0d` |
| `src/app/ilaria.tsx` | `42289b8a1567ed373f58ab0fd7b231d1a79ae7c9025b0074d0a5335bf2c17bd7` |
| `src/features/contribution/client.ts` | `5639ea19ecc33d072428e35e821d2251b096096815a6c7798214cd8b76365b49` |
| `src/features/contribution/consent.ts` | `18bd6147c803e4fd9dc6daf4c176202824b92ed842804d8cc40ec7d6cadfae60` |
| `src/features/contribution/ContributionPanel.tsx` | `9af2e2f945faddfd73ef08c4409f732888f7add181e907cb33eb693cf8feccf3` |
| `src/features/ilaria/IlariaScreen.tsx` | `3a529002f66b41ca5f623e44f88db7b634dddffacaa5c69c3cfd8267434ff898` |
| `src/features/ilaria/useIlaria.ts` | `7d62f594d366a0bb029b6a71a0df380a52525f26a991dfadcd3c15ef22d1001d` |
| `src/lib/auth-core.ts` | `a1d35df744a83bbe33f9c97439f7b241e313d7b3ee9ad96221eef447d2032e63` |
| `src/lib/ilaria-api.ts` | `3fa08b0807ed931e46417763a1262f03664f12248d61200096071a1264bb9385` |
| `src/lib/ilaria-wire.ts` | `daecf024cc0cf57bd879679949e13cfc02c3c5ef60b72ece662e6f74abab8f1c` |
| `tests/auth.test.ts` | `33698a7ae9bdd89ed6d0e1897bedc173da45f25f6d3018c1427caaf83feebc24` |
| `tests/contribution-consent.test.ts` | `818ecf901e11afeaf46465fc4c052bc61a7948a6e0179b4668325c343b50cfbc` |
| `tests/ilaria-api.test.ts` | `11e37ae499945d0f46389669703185655c87ad32eb87d3bd3b78e89cea6dbc7f` |
| `tests/ilaria-lifecycle.test.ts` | `ac069f0d8d1ff5a20c5ca02bc173557f3bb9e7e8fa27610b5cafc3a49c751b60` |
