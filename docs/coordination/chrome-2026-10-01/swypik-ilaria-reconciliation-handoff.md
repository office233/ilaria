# Nexus gateway/provider source-current reconciliation handoff

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
| `ilaria/runtime/mobileprovider/provider.py` | `16276259fdcefbc446ef1a880dfe0eb5fd0748e50646018cfdab411cab67164c` |
| `ilaria/runtime/mobileprovider/test_provider.py` | `a4fda557b0bae0cfc286004793bb79baa00e1d5c88f80a5810a9f98b584a5a0f` |
| `swypik-os/cmd/mobile-gateway/main.go` | `8dbcdc6a8039ab4f694822406b099bc01f7a6013702901525d85b52fecbe6cf9` |
| `swypik-os/internal/mobilegateway/gateway_test.go` | `956efa37bdbcd406942a58f05c5da4c99f77c2f17a4e68442ca38ce5074b7ea8` |
| `swypik-os/internal/mobilegateway/gateway.go` | `ae985846b9bb4cfe46909c775a88383546e7ce640cf6b18270849499b465ac5e` |
