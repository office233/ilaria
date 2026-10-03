# Swypik / Ilaria mobile integration preflight
Read-only evidence at 2026-10-01T15:44:55Z; only this new report written; no code, builds, tests, service calls, auth/config, corpus, weights or active NETWORK20 source inspected.
App root: E:/Swypik/_work/codex-mobile-session-lifecycle-20261001; actual branch codex/swypik-mobile-session-lifecycle; HEAD ee64f47951010c614139b19065cebb72eb62b77f. Registry's differently spelled branch is not checkout evidence.
Nexus root: E:/nexus; branch codex/nexus-supervisor-v3; HEAD 06a5f39f805cf36897e05ffe306d05ed212a5a3a. Relevant workspace/product/app AGENTS read. Original mobile repository unchanged.

## Concrete seams and missing execution
- package.json uses expo-router/entry, Expo ~57.0.26 / React Native 0.86.3; App.tsx is a starter file, not the configured route entry.
- src/app/_layout.tsx::Layout wraps three Tabs (Discover/shop/account) in AuthProvider; src/app/index.tsx displays the public feed. No Ilaria route exists.
- src/lib/api.ts::resolveApiOrigin validates a public HTTPS origin; readApi permits two anonymous GET paths, credentials omitted. Its service-location comment is source context, not a verified deployed backend.
- src/app/preview+api.ts::GET is an anonymous public-feed/catalog proxy; it is not an authenticated inference/training gateway. No web-backend checkout or deployed inference route is supplied here.
- src/lib/useRemote.ts::useRemote has a 15-second AbortController timeout and unmount cancellation; this does not cancel server execution, fence a training lease, or schedule background work.
- src/features/studio/StudioPreview.tsx selects a local gallery clip and promises local-only preview. No silent upload, global memory donation or training consent follows from media permission.
- Frozen auth handoff reports foreground/background/logout barriers and controlled-backend verification still needed; default auth is disabled. No token/private configuration inspected; new clients must consume an approved auth interface without editing frozen auth6.
- Frozen native handoff/source-generation reports show Android CNG source only, no APK/AAB/IPA, physical-device gate or native IMC worker. Public package.json has no canonical mobile inference/training runtime.
- ilaria/specs/myriad.swyp is canonical; generated/myriad/types_gen.go matches the OS mirror. CorticalRequest/Response already carry version, task identity, privacy, deadline/budget, hypotheses/evidence and proposed Swyp plans; do not invent a second cognition schema.
- ilaria/runtime/protocol validates version/privacy/identifiers; router.Router.Route ranks experts, not inference. The bounded public cmd/runtime search found no Cortical HTTP inference handler; DTOs and router tests do not establish a serving model.
- ilaria/runtime/isxprobe::ValidateEnvelope binds accepted local-v1 metadata to externally issued Bindings and verifies Ed25519; its package explicitly authenticates envelopes, not compute/quality. Reuse the accepted verifier path; never treat the client signature as promotion or data authorization.
- NETWORK20's new transport/training contract is active and reserved. The accepted local synthetic probe and stable Myriad v1 do not prove mobile execution, an Internet gateway, encrypted transport or continuous network training.

## Smallest honest end-to-end milestone
1. Foreground app Ilaria screen -> authenticated HTTPS gateway -> one canonical IMC provider adapter -> strict CorticalResponse displayed with real model/version evidence. Start with a public synthetic small IMC fixture to prove wiring; production conversation quality needs a separately authorized, evaluated serving artifact, not the completed unpromoted pilot.
2. Separate data opt-in and compute opt-in. A user's explicit public synthetic feedback can enter a curated, purpose-bound queue; no gallery, chat, personal memory or device telemetry becomes global training data by default. Show queued/approved/used states only from actual receipts.
3. After NETWORK20 is accepted and its public interface released, gateway-issued signed jobs may run on a paired compatible user-owned peer. The app controls consent/revocation and displays issued/candidate/evaluated/promotion receipts. This is host contribution, and must be labelled as such; it is not phone computation.
4. Actual phone contribution is a subsequent blocked milestone: a portable, bounded adapter to the canonical IMC runtime, capability/size support proof and a native development build on a real device are missing. Do not enable device-training controls or write a duplicate JS model/optimizer/validator to mask that gap.
5. SwypikOS authority may run as an authorized host service behind the gateway; the app needs no SwypikOS installation. Ilaria remains a provider; app/client proposals cannot grant OS effects, select trusted issuer keys or promote weights.
6. Gateway job binding must include authorized issuer distinct from proposer/evaluator, account/peer role, dataset/curriculum scope and purpose, current parent, recipe/policy, consent epoch, fresh lease/fence/deadline and resource limits. Adopt accepted NETWORK wire unchanged; missing released schema is a prerequisite, not permission to duplicate it.
7. Promotion occurs only after independent held-out CE/anchors and canonical evaluation; preserve current-parent lineage, durable replay identity, at-most-once application and crash-safe active-pointer rollback. Client consent and signatures do not prove useful work or safe plaintext disclosure.

## Exact proposed claims and baseline
Proposal only, not ownership acquisition. All new paths below are absent at observation; the sole existing edit is _layout.tsx with SHA below. Recheck claims/hashes before allocation.
App NEW: src/app/ilaria.tsx; src/features/ilaria/IlariaScreen.tsx; src/features/ilaria/useIlaria.ts; src/lib/ilaria-wire.ts; src/lib/ilaria-api.ts.
App NEW: src/features/contribution/ContributionPanel.tsx; src/features/contribution/consent.ts; src/features/contribution/client.ts.
App NEW: tests/ilaria-api.test.ts; tests/ilaria-lifecycle.test.ts; tests/contribution-consent.test.ts; docs/ILARIA-INTEGRATION.md.
App EXISTING: src/app/_layout.tsx (route registration only). No other app source/config/package/native/auth edits are in this proposed 13-file slice.
Nexus NEW: swypik-os/internal/mobilegateway/gateway.go; swypik-os/internal/mobilegateway/gateway_test.go; swypik-os/cmd/mobile-gateway/main.go (HTTPS/auth/policy forwarding adapter, not a parallel P2P transport).
Nexus NEW: ilaria/runtime/mobileprovider/provider.py; ilaria/runtime/mobileprovider/test_provider.py (call existing canonical IMC APIs through a bounded provider boundary; no Forge/model implementation edits).
These 18 paths are disjoint from frozen auth6, native runner/config/sourcegen, Worker5 and NETWORK20. Host provider lifecycle, approved public auth interface and post-handoff network entry remain explicit design prerequisites; no production endpoint is assumed.
SHA256 baseline (relative app paths):
- AGENTS.md: 74906b75b99ef669200f05cc9131ae74b4a6e8c7a6827d65cb0389d6d2740202
- package.json: d973f6ec987e28f33a1702c7c7d0d8e6db542b57f9333d7e1e9b7cc1bffd7171
- src/app/_layout.tsx: d51ed0220a66b012407bced5d80f70207c3e542202642f18dc69181da9786058
- src/lib/api.ts: 469c3f7cc55e73ffea6343f4fb52857f8a6529fb30ff675ac51ac279c147dbc9
- src/lib/useRemote.ts: cf0de9351a33e59d37a1346f6aa37dc41edfa8c40e736ce619429473be820104
- src/app/preview+api.ts: 1e9b693acbd9005a2df39d2268b38e7da7dd9d850b8050741e74efe340e449ee
- src/features/studio/StudioPreview.tsx: c90b1478ce3d175fe7d20f29cdbaf0d1bcbd227bf92ac08aafc1c83953a8603d
- docs/AUTH-LIFECYCLE-2026-10-01.md: 9e90dcb65ede22d0bef2b615d027788113a847631214aa0a0fbb506f50cd0a87
- docs/NATIVE-BUILD-READINESS-2026-10-01.md: df40ef41c0f5f2ed85dd05c59c5f717513843a3b3092ae25122247cdb77155d5
- docs/ANDROID-SOURCE-GENERATION-2026-10-01.md: 3f8d68454c58e7fb7015669202c4c868fd9ff1f6cfc0e695ad6620cb83625fa8
SHA256 baseline (relative Nexus paths):
- ilaria/specs/myriad.swyp: bbed71836741ce742a3a53a858b9608dca88791eb927aaed2037ead609356421
- ilaria/generated/myriad/types_gen.go and swypik-os/generated/myriad/types_gen.go: 0ca37f338e517b2a7ade6357dd553dc5edfc85232beb037eac885ba2b9490a74
- ilaria/runtime/protocol/contract.go: 37beb66a35b59a4dafca23d14c2f6009be5534b31b542837782debe0cb8e83ff
- ilaria/runtime/router/router.go: 65ea3357a004741c095b7374c5b8b4c0b8b4b37069752820ee1d39ba2aca813f
- ilaria/runtime/isxprobe/contract.go: 8d401732299e9779985aaa3e78f41a4ca2a7c324ff97e2efce466accda3fa756

## Required acceptance evidence, not performed here
- Real app request and actual canonical model output, matched task/version/hash; strict duplicate/unknown/trailing/size/finite checks, lossless u64 handling (JS Number is insufficient above its safe-integer range), privacy and cross-account isolation; no invented endpoints/fixtures masquerading as production replies.
- Cancel/unmount/background/logout/offline/timeout stops local work and causes correlated bounded server cancellation; late results cannot cross session or consent epochs. Cancel status must distinguish requested from verified stopped; durable polling restores only non-sensitive permitted state.
- Opt-in off by default; separate data and compute scope/revoke; modified/self-issued/expired job, wrong parent/recipe/dataset/policy/issuer, stale fence and replay reject before allocation. No candidate directly modifies active model.
- Actual paired-peer candidate execution, independent evaluator, two accepted parent-linked rounds, rejected candidate, restart replay and crash rollback with unchanged production parent; report canonical eval receipts and wire/model hashes. Phone-compute acceptance requires a physical-device canonical executor, not this host proof.
- Bounded bytes/concurrency/steps/time; inference priority, battery/charging/unmetered/thermal policies only where actual signals exist, unsupported enforcement refused or reported unknown. Record device/app and host/provider CPU, peak RSS, wire bytes and wall time separately; joules/energy savings unmeasured without counters.
- Existing app typecheck/lint/tests plus new client/lifecycle/consent tests; affected Ilaria/OS gates and schema-generated equality. Hermes exports/sourcegen are not native/device proofs; Android/iOS device tests need separately authorized toolchains/build/signing setup.

## Mobile platform constraints
Initial slice is foreground-only and parks on background/revoke; no always-on/full-IMC-1B phone-training claim. Android native compilation is still blocked on this Windows host; iOS local compilation needs a suitable macOS/Xcode host, and physical-device behavior remains unverified.
[Android WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work) supports charging/network/battery constraints, deferred execution and expedited quotas; unmet constraints stop work. It does not certify a host-wide CPU/RAM limit.
[Apple BGProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgprocessingtask) may run for minutes but can be interrupted; expiration cleanup is required. It supplies no continuous training guarantee.
[Expo SDK57 BackgroundTask](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/) wraps WorkManager/BGTaskScheduler, is system-scheduled, and requires physical iOS devices for its background API; it is absent from this app manifest. Adding native worker/background modules would require a new separately allocated CNG/config/native milestone, not edits to frozen files here.
