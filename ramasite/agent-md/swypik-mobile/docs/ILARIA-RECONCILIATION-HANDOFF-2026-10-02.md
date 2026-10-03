# Swypik app source-current reconciliation handoff

State: STOP / FROZEN / CANDIDATE_READY_FOR_INDEPENDENT_REVIEW / NOT_INTEGRATED.
Frozen at 2026-10-02T02:03:46.291502+00:00. Owner: review_inference_cache. This is a new reconciliation fork,
not a release or takeover of either historical worktree. The historical 21-file handoff is preserved.

The independently reconciled 21 current old-worktree hashes match the prior current-review receipt;
17 match its historical handoff and four implement its two requested corrections. Exactly 15 app
implementation/test/document files and five Nexus implementation/test files were copied into these
new forks. The four correctness claims were first reopened for discriminating proof. Root then
authorized removal of reported EOF blank lines only: exactly one LF byte was removed from 13 files
(11 app files and provider.py/test_provider.py), with every other byte identical. Go implementation/test
sources and all 47 read-only dependencies remain unchanged. Exact pre/post hashes are in
whitespace-changes.json; the first run's 20 sources, 47 dependencies and initial handoffs are preserved
in the parent evidence folder's initial-proof-source-snapshot. Initial owner-stop.json and actual receipt
are unchanged. This final release supersedes the initial fresh-fork handoffs only; historical owner releases
and original repositories remain untouched.

The gateway quarantine sets closed admission under its mutex on ErrCleanup before releasing capacity.
Existing status/cancel controls remain available and uncertainty is retained. Removing only that guard
in an external Go source overlay caused the real regression to fail with provider calls=2; the unchanged
candidate passed with calls=1. The client checks the authoritative deadline immediately before success
publication and invokes its correlated cancellation path. Removing only that check in an external public
scratch copy caused cancellation count=0; the unchanged candidate passed with count=1. Neither RED
fixture modified an old worktree, Main, the original app, or candidate source.

Current Main snapshots are read-only dependencies: exactly 43 Go source/test files in planprocess,
resource, devicesynth, generated/controlkernel and generated/myriad, plus OS go.mod/go.sum,
ilaria/forge/imc_model.py and ilaria/specs/myriad.manifest.json (47 files total). No former 39-file or
whole-repository overlay was used. Model source SHA256:
650f4cad06d80760a03fa4396bb2cce27364bd596b8002f39ec02d595205274c.
CorticalRequest/Response declarations are unchanged between the old and current manifests.
The actual proof executes this dependency closure; it does not establish whole-current-Main runtime parity.

New-fork gates: app 96 tests PASS with explicit current Myriad manifest and no skips; typecheck PASS;
offline Expo lint PASS. The 41 additional old-worktree tests are outside this selective fork: the three
unclaimed auth-lifecycle/native-build/native-config test files were not copied. Candidate OS full
go test -count=1 -timeout 180s ./... PASS (47 passing packages, eight without tests) and go vet ./... PASS;
five affected Go packages PASS separately; Ilaria go test ./... and go vet ./... PASS; provider 32 tests PASS;
two public provider files py_compile PASS; tracked and all-claim no-index git diff --check PASS. These
TS/typecheck/lint/provider/compile gates were repeated after the authorized EOF cleanup. Go sources
and their dependencies were not modified, so the earlier full Go gates remain source-bound and were
not needlessly repeated. Go gates
used GOWORK=off/GOMAXPROCS=2. These full Go gates cover fork HEAD plus the declared current closure,
not every uncommitted current-Main file. Model/trainer source was not an editing claim.

Exactly ONE separately authorized final TS -> HTTPS -> random canonical IMC canary passed in 3.375 seconds.
The initial 2.735-second source-pinned run remains intact; this repeat was justified by final source hash
changes from authorized EOF cleanup. Four real forwards
produced random-model hash 85f701dc96ba5259966e7bb7edc8ea97e92356e7508aa06f752da475e11fed42.
Worker CPU 2.59375 s, worker peak RSS 206323712 B;
gateway peak RSS 11964416 B, sampled CPU delta
0.03125 s.
These are process observations; startup/sampling scopes differ, and they are not whole-host CPU/memory
or energy claims. Actual cancellation occurred after the next native worker started; executor returned
verified_stopped and the late result was discarded. The actual test printed synthetic metrics, no auth keys.

The external launcher used a 90-second total UTC/monotonic budget with 10 seconds reserved for cleanup.
Build and prerequisite gates were outside that active window. It assigned the suspended test host to an
owned Windows Job Object before execution, using KILL_ON_JOB_CLOSE and completion-port notifications;
the provider additionally retained its existing OS resource jobs (50% CPU, 1 GiB, one process each).
Seven owned job PIDs were observed with identity handles held: 32568, 34548, 35508, 36336, 37180, 37528, 37584.
All exited; final active-job count=0; owned process/job/completion-port handles closed;
source drift=[]. The observer then exited. No second actual run is authorized by this handoff.

Final external evidence root: E:/nexus-training/evidence/mobile-reconciliation-20261002/whitespace-final
Baseline SHA256: 1d1ccb7ee96cf5e5a656d40f52cfe0fb8d830ea5916e6a726d255f7ac17b057b
Actual receipt SHA256: f109a11ac3c4883688e97039c35b5ad31d33fc6332e132bca52a5a0c7b9c80d1
All candidate/dependency/log/handoff hashes and final protection observations are in owner-stop.json.
Read-only source reconciliation receipt: source-reconciliation-20261002T0134.json in mobile-current-review-20261002,
SHA256 0adbf3654cc422906236f0e86c09ea6e069915b913bf7a7e83c80be02b4d964b.

Reproducible actual invocation (one proof already executed; do not run again without a fresh grant):
`C:/Python312/python.exe E:/nexus-training/evidence/mobile-reconciliation-20261002/whitespace-final/run_bounded_https.py`
The launcher pins both source roots, runs the prebuilt test with its fixed working directory and explicit
public interpreter/tool paths, preserves actual-https.log, and writes actual-https-receipt.json.

Main's 300 protected public runtime pins, original app's 20 fresh protected inputs, all 21 historical
worktree claims, and original/old-owner HEAD/branch/index bytes were verified unchanged. No staging,
commits, branch movement, SDK installation, native generation, cloud/EAS, GPU, corpus, trained checkpoint,
Bridge/pilot, real user/session storage, deployment or publishing occurred. The new Nexus fork's index
stat cache was refreshed by git diff --check; original and old-owner index bytes were preserved.

Proof limit: real local TLS and native CPU worker containment with synthetic auth/backend and random
IMC fixtures. It proves the foreground inference/cancellation flow, not conversation quality, approved
production serving/tokenizer/auth/proxy setup, APK/IPA, device execution, phone training/P2P contribution,
two-host execution, or energy/cost efficiency. Contribution controls remain unavailable/off. Those separate
milestones and pending SDK terms are not acceptance prerequisites for these TS/Go/canary gates.


| Public candidate path | SHA256 |
| --- | --- |
| `docs/ILARIA-INTEGRATION.md` | `fc0ce8ac98d61ec579f567f2ef74ae555e36098442ecbd60f7c737834a98e363` |
| `src/app/_layout.tsx` | `24be333da3f8ce5aec563d753f4cc676cb1bf8984b914b88bb444c5ee5852b0d` |
| `src/app/ilaria.tsx` | `42289b8a1567ed373f58ab0fd7b231d1a79ae7c9025b0074d0a5335bf2c17bd7` |
| `src/features/contribution/client.ts` | `f971a38ca3a916c93943fcfd057a0da8415a5579c0215e62b4d987ff0dc61f15` |
| `src/features/contribution/consent.ts` | `ab3768f0f730ae8eb80cd49afa24388af48d7f57db9bc243bb8687d807a59a4c` |
| `src/features/contribution/ContributionPanel.tsx` | `1b76c9cec0e183ef88f8063daeed14bed4b742f2c0f751f5374dccab13f6622e` |
| `src/features/ilaria/IlariaScreen.tsx` | `1ad007cc19f0ff4b873a0cd5db1713d27ec70b93db950130e3f0566b0718dd42` |
| `src/features/ilaria/useIlaria.ts` | `0d42f6297884d198bb4edab2db9215408af1a9cc95a00c3a78041887d3f4aeee` |
| `src/lib/auth-core.ts` | `a1d35df744a83bbe33f9c97439f7b241e313d7b3ee9ad96221eef447d2032e63` |
| `src/lib/ilaria-api.ts` | `72783bdbd71bc59f6a693a7dc995faff6e9679824329d7dbb644c57ad17635d0` |
| `src/lib/ilaria-wire.ts` | `78e26dfa17bbbc81f029a5287bdf0a25dd0a9e2fd9a2f8466cf59664325921f0` |
| `tests/auth.test.ts` | `33698a7ae9bdd89ed6d0e1897bedc173da45f25f6d3018c1427caaf83feebc24` |
| `tests/contribution-consent.test.ts` | `023ec6bb94390b19bf5588e9ac4635196283c791a2f427456b61056954300076` |
| `tests/ilaria-api.test.ts` | `aed1e4844ba03df1abd889b5dcfa37613eb1f73c3e1a7325afb5357ff170008d` |
| `tests/ilaria-lifecycle.test.ts` | `739a67d54e45f9e11e4e59b21cba2de9a5c98f40ec43387128f30e2edae2f89a` |
