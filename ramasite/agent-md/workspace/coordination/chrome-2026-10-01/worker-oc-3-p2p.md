# OC3 local IMC two-peer probe

State: COMPLETE

## Exact allowed claims
- `ilaria/specs/myriad.swyp`
- `ilaria/specs/myriad.manifest.json`
- `ilaria/generated/myriad/types_gen.go`
- `swypik-os/generated/myriad/types_gen.go`
- `ilaria/runtime/isxprobe/contract.go`
- `ilaria/runtime/isxprobe/contract_test.go`
- `ilaria/runtime/isxprobe/peer.py`
- `ilaria/runtime/isxprobe/test_peer.py`
- `ilaria/runtime/isxprobe/__init__.py`
- `swypik-os/cmd/imc-peer-probe/main.go`
- `swypik-os/cmd/imc-peer-probe/main_test.go`
- `ilaria/docs/audit/p2p-imc-two-peer-probe.md`
- `docs/coordination/chrome-2026-10-01/worker-oc-3-p2p.md`

## Checkpoint 1
Read root/Ilaria/OS/Swyp AGENTS and `.nexus-p2p-baseline.json`. Same dedicated
worktree/branch. No nested instructions found in runtime/specs/OS cmd. Frozen
kernel claims will be hash-checked, not edited or re-tested. No other sources,
model/provider settings, private data, production weights or external services.

Implementation must import canonical IMC and collective_sleep, use canonical
Myriad schema generation, and launch two local trusted peers through OS hard
group limits. Signing authenticates ephemeral fixture bytes, never proves compute
or model quality. Local synthetic experiment only; not Internet swarm/IMC-1B.

## Checkpoint 2 — real containment and local numeric evaluation
Existing Windows Job API succeeded: two Python processes assigned before resume,
1GiB aggregate hard memory, 25% CPU, max2 processes. No fallback/install/admin.
Two real IMC peers then exchanged bounded JSONL and independently measured candidate
CE/anchors through canonical collective_sleep. Evaluator accepted numeric quality:
train CE3.153565→0.055789, holdout3.224613→2.475658, anchors0.03125→0.21875.
Raw delta39680B, candidate frame54700B, evaluator frame54328B; measured compute
1.672658s/1.953670s. Post-exit RSS0 is not peak evidence. Active/rollback are null:
this is evaluation-only, NOT the required signed/adopt/rollback demo.

## Exact delta against `.nexus-p2p-baseline.json`
Four existing allowed files changed: canonical Myriad schema (one new record;
old records preserved), generated manifest, Ilaria generated DTO, OS generated DTO
(OS mirror new if absent). Nine allowed new files added: contract/test, Python peer/
test/init, OS command/test, this report and audit. No paths beyond the13 allowlist.
All6 protectedFrozenClaims SHA256 exactly match baseline. Forge, training/controller,
data, caches/energy/swarm/federated/worker5 and Swyp compiler production unchanged.
No native kernel tests rerun. No agents/modelcalls/install/global model edits.

## Gate evidence and logs
All commands bounded; logs retained only in owned approved temporary directories.
- `go run ./cmd/imc-peer-probe --local-probe --containment-check`: exit0;
  output dir `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-4bc4dd7be25f4603ac46c07847caf90a`.
- `go run ./cmd/imc-peer-probe --local-probe --evaluation-check --peer E:\nexus-worktrees\opencode-cleanup-matrix\ilaria\runtime\isxprobe\peer.py`:
  exit0; NOT required complete demo;
  log `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-eval-91da6370cb6d4b8e9333db0699416a94\demo.log`.
- `python -m py_compile forge/imc_model.py forge/train_ilaria.py forge/training_state.py runtime/isxprobe/peer.py runtime/isxprobe/test_peer.py`: exit0.
- `python -m pytest -q -p no:cacheprovider forge/test_imc_model.py runtime/isxprobe/test_peer.py`:
  exit1, 12 failed/44 passed; inherited trainer import `dataset_manifest` absent.
  Log `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-python-c28d6484dc184f209fdda96511ff43f7\pytest.log`.
- `python -B -m pytest -q -p no:cacheprovider forge/test_collective_sleep.py`: exit0, 7passed.
- Ilaria `go test ./...`: exit1, benchmark_test.go:75 missing tasks.jsonl;
  `go vet ./...`: exit0; new isxprobe tests pass.
  Logs `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-ilariago-d94849c4261c4139a49884bbef30468c\{test,vet}.log`.
- OS `go vet ./...` and `go test -count=1 -timeout 180s ./...`: exit0;
  logs `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-osgo-dff80ad676724612bdf86023daf821c2\{test,vet}.log`.
- Swyp `go vet ./...`/`go test -count=1 ./...`: exit0;
  logs `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-swypgo-9b0345b62f7946bf8000898e7dafe06e\{test,vet}.log`.
- Swyp component check/compile/go: exit0,25declarations; fresh generated artifacts
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-schema-e076d3b30c154325957ac698967417d6`;
  copied manifest+DTOs verified byte-identical (exit0), no hand-edit of generated.

## Blockers / frozen partial handoff
State: BLOCKED

Operational hard group API is available. Remaining core work is NOT implemented:
full metadata+payload signing from peer, ControlKernel live consent authorization
at dispatch/commit, revoke handling, durable nonce/round restart ledger, atomic
checkpoint promotion pointer and rollback/crash recovery. No required complete
demo and no active/rollback scalar evidence. Relay-generated HMAC is not peer
signature and currently contract hashes supplied payload rather than Python delta
alone; must reconcile before enabling promotion. Initial Go validator also lacks
duplicate-key/canonical metadata checks. Those are implementation gaps, not falsely
attributed to OS/API limitations. Default command rejects promotion until complete.

Inherited gates additionally lack Forge dataset_manifest import and benchmark
tasks.jsonl fixture; neither read private data nor add out-of-scope dependencies.
Missing meaningful tests include durable replay/restart/revoke/timeout/backpressure/
crash rollback and peak-memory/cap exhaustion. No production/Internet/IMC1B claims.
Detailed limitations/metrics in `ilaria/docs/audit/p2p-imc-two-peer-probe.md`.

Source hashes (SHA256):
- myriad.swyp: `51b494f1808397ba637e1eb5abe7a691fe042c5beacd2218fbdb04f0aa4c820f`
- manifest: `b1e2c2dcc26f13008245e13c4d8582c3c77a7613ffa49c960e81c1b967982bf5`
- bothDTOs: `ca76bc16d1c66cf70ccc3f12181dad67fe653e265afc399c846a9d1e3076ed89`
- contract.go: `fd416555c340ba25a6bacc6f9f44081d490980b8843fcdceb3a7c3d5c3d1ef41`
- contract_test.go: `23f9ae65b63a4aee84e2ddf89b1564b75903f9851feb440ff52d05e4d055d72d`
- peer.py: `9d1b701cf76c64119c791c9b8ee48bc05d21754bc6045ca4a1085fd78ea0a46e`
- test_peer.py: `2b0e367a491a96817ec818b45e699f5168f9533698097afed165c740899322d4`
- __init__.py: `24d6d9a8461710514640dd15207cbeb2d80a0c7fdea5a884c395bef42c72ad70`
- OSmain: `e2ee6cbdfd78bc584f89ee67ef390ca281c9c2373e555a895034e8ce68161228`
- OStest: `0f1a5e472a0c98c75bd1963bbf59d7f5bc96c271e0a580e2941ab2f010eda8b5`
- audit: `f4a3b5ae07e39c55978c3e329de34b1e95617e358dc6cce60e99a42435eea986`

Final `git diff --check`: exit0 (inherited CRLF warnings only). All13 allowed
files whitespace/newline checks and all6 frozen SHA checks: exit0. Report hash is
not embedded in itself; review can hash final report separately. No generated
binaries/model weights inspected; only ephemeral synthetic runtime tensor payloads.

Stop at this partial handoff. No stage/commit/push/deploy/publication or Main edits.

## Continuation — complete safety pipeline authorized
State: RUNNING

Root/product AGENTS and updated baseline reread (450 dependencies). All original
13 claims retained. Additional allowed benchmark paths are
`ilaria/cmd/ilaria/benchmark_test.go` and
`ilaria/cmd/ilaria/benchmark_public_fixture_test.go`; first path does not exist.
Prior failing benchmark lives at `ilaria/bench/myriad/pce_transfer_v1/benchmark_test.go`.
Request corrected exact allowance for that existing benchmark and same-directory
new public fixture before editing. Continue signed peer protocol/OS commit work;
missing implementation is work remaining, not an external blocker.

## Final continuation — completed local prototype, frozen handoff
State: COMPLETE

Scope corrected by root: final15allowedPaths includes existing
`ilaria/bench/myriad/pce_transfer_v1/benchmark_test.go` and new
`ilaria/bench/myriad/pce_transfer_v1/benchmark_public_fixture_test.go`.
No wrong-path drafts created. Exactly4 existing allowed artifacts modified
(schema/manifest/IlariaDTO/benchmark), remaining11 allowed paths new to baseline
(OS DTO included); no sources outside allowance modified.

Actual pipeline now implemented, superseding historical partial gaps:
- Peer-origin in-memory Ed25519 via existing cryptography50.0.1. Public key only
  registered on own pipe; signature covers canonical metadata+raw delta layout/
  exact bytes/SHA. No user keys, private key files/argv/log or relay-HMAC shortcut.
- Duplicate/unknown/canonical metadata/signature/hash/version/base/fixture/recipe/
  round/peer/consent/fence/nonce/deadline/size/shape/dtype/finite/norm validated.
- OS existing ControlKernel authenticator/live lease-fence checked dispatch+commit,
  live consent file epoch opt-in, cancelled-node denial, journal writer lock;
  durable synced bounded round/nonce consumption before dispatch (at most once,
  restart included), one pending candidate, existing bounded queue+hard group.
- Candidate eval reuses canonical consolidate; no accepted production mutation.
  Content-addressed immutable own-temp JSON checkpoints, synced atomic own pointer
  replacement, pending baseline transaction, ordinary-error restore and locked
  crash recovery; evaluator re-loads actual active+rollback bytes and computes CE.
- Public benchmark fixture always exercises12synthetic PCE/sign/replay tasks.
  Only external audit skips when env unset; explicit bad path FAIL verified.

### Required real demo, command/exit
`go run ./cmd/imc-peer-probe --local-probe --demo --peer E:\nexus-worktrees\opencode-cleanup-matrix\ilaria\runtime\isxprobe\peer.py --state <own-temp>/state`:
exit0; proposer23400/evaluator20224; before/candidate/active/rollback CE
**3.224612713 / 2.475658417 / 2.475658417 / 3.224612713**;
anchors0.03125/0.21875/0.21875/0.03125. Train3.153565168→0.055789080.
Raw39680B; signed candidate130060B; evaluation108179B; framecap262144B;
Windows Job aggregate1GiB/25%CPU/max2,deadline120s, evaluator2.332978s.
Memory peak uninstrumented (not fake0 evidence); memory hard cap separately tested.
Log `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-complete-demo-bf33e11959724bd6ae2a2e8ff4fb1d27\demo.log`.
Same-state restart expected exit1 replay/ledger; log same directory `restart.log`.

### Final gate evidence (supersedes previous failures)
- py_compile canonical3+peer/test exit0; pytest model+newpeer+sleep exit0,
  **66passed**,53.67s. Logs
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-final-python-67759a3d35894efbaf1241f2711f23ab\final-test.log`.
- Ilaria `go test ./...`/`go vet ./...` exit0; logdir
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-final-ilariago-e4c0a6a7639d4ef7bf474ff8b4d0a179`.
  Explicit-invalid external corpus audit expected exit1 (`explicit-invalid.log`).
- OS full vet/test-count1-timeout180 exit0 after final code/test edits; logs
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-final-osfixed-bda3ed34f15342849a8be37f51f3c79b\final-{vet,test}.log`.
  New tests include revoked consent/current node cancellation/stale fence,
  replay/restart, ordinary and actual subprocess crash rollback, strict group
  timeout/oversize/backpressure, aggregate process cap and memory-cap denial.
  Earlier test invalid state transitions failed, corrected to canonical supported
  cancellation; final full suite passes, no ControlKernel source edits.
- Swyp check/compile/go generation exit0; fresh temp artifacts
  `C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-p2p-final-schema-3cda921a4cef47edb0c30c8494ad300b`;
  prior full Swyp vet/test0, no compiler edits. Compare output/source again at final.
- 450baseline entries (excluding exact claimed generated/schema paths) +6frozen
  kernel SHA verification exit0, zero mismatches. Kernel suites not repeated.

### Reality limits / handoff
COMPLETE is scoped local trusted synthetic pipeline+gates, NOT production/swarm/
IMC1B/IlariaLex65k/pilot/Internet compute/superiority.16token IMC random initialization
only. No power-loss/network-FS atomicity/hostile-filesystem guarantees; no remote
consent transaction, arbitrary concurrent external state writer or CPU saturation
proof. Consent/fence checked at dispatch+commit, single-owner journal session.
Actual model peak RSS remains unmeasured; hard memory denial separately verified.
All private keys ephemeral process memory, public library root only admitted to -I
Python; no user secrets read. No duplicate model/trainer/controller, Forge edits,
subagents/modelcalls, install, stage/commit/push/deploy or Main integration.

Final reports supersede historical BLOCKED entries above. Freeze for root review.

Final verification: `git diff --check` exit0; baseline450/frozen6/generated3/
allowed15 whitespace checks exit0. Existing inherited CRLF warnings only.
Updated SHA256 (supersede historical hashes; report self-hash intentionally omitted):
- schema `bbed71836741ce742a3a53a858b9608dca88791eb927aaed2037ead609356421`
- manifest `f55be33b5dc8e3cb2bfaa00f7a743c4ab0dc0a5794fa8fb12703f0f52b0affbc`
- bothDTOs `0ca37f338e517b2a7ade6357dd553dc5edfc85232beb037eac885ba2b9490a74`
- contract `db7435319b83a7d13b82a5d4571db001372e8418b7d85474c3959c81030f5530`
- contracttest `52a844a6d6595342c59b9d85df748070e807d5767c80b5a8e389d15bc7a57428`
- peer `aa6d071103c048914e55cffa56b94d5e476c6e80f6266caf1bc7d2297ade2881`
- peertest `a088699d11f9966f1de93fc808f0e8fb9c3d59b255c98ba6ea8dc23eb7cfc58d`
- OSmain `83e9e52aeac262e819ed32c61091be900e483c7cb33e771d1cb2f925c0b766ec`
- OStest `5722bf1992a6f6a87d71aefea6126ec7e1cf84c88a68edfbaf7dd6ed8ba657b6`
- benchmark `90013b5af9d8ec7b6d0f860809cf4e8dbd5044a98b43b6d6b584c0d719bdbc9e`
- publicfixture `db6c772537c7e92ddebdc12185ffb08c89f06cae6b1d6d62988e68c87698381a`
- audit `694a385bda6b4f9eb63b35aa2af1b9526048f75051975b49a3a035b814611b35`

## Independent-review fixes — current phase
State: RUNNING

Read root/Ilaria/OS AGENTS and supplemental review baseline. Exactly eight edit
claims: OS main/test, Ilaria contract/test/peer/test, audit and this report.
Other seven P2P artifacts, all nonclaimed public dependencies and six kernel
claims remain frozen. No Main reads/integration, agents, installations or model calls.
Review counterexample concerns validly re-signed recipe policy; model/base/fixture
mutations were rejected later by evaluation, not demonstrated final quality bypasses.

## Independent-review final repaired handoff
State: COMPLETE — FREEZE, scoped local prototype only

Exact eight claims changed against `.nexus-p2p-review-fix-baseline.json`:
1. `swypik-os/cmd/imc-peer-probe/main.go`: evaluator predispatch preparation from
   OS-issued recipe; mandatory retained issued version/expert/model/base/fixture/
   recipe plus peer/round/epoch/fence/nonce/deadline/key binding; reject changed
   candidate identities before relay/evaluation. Optional public-library-root
   forwarded intact only when provided; Python explicit or PATH lookup, no fixed
   machine/user/version paths. Canonical model logic stays in Ilaria.
2. OS `main_test.go`: real valid re-sign/required-binding mutation tests with prior
   active hash unchanged; default-no-library and spaced explicit argument tests.
3. Ilaria `contract.go`: fail closed for incomplete expected contract, expected
   version/expert, mandatory nonempty identities/positive epochs/fence/deadline.
4. `contract_test.go`: valid Ed25519 re-sign of changed issued identities and
   missing expected contract rejects, alongside unchanged baseline auth checks.
5. `peer.py`: trusted identities prepared from issued recipe before candidate;
   required complete exact expected authorization; no peer-policy self-authorization.
6. `test_peer.py`: RED counterexample retained as GREEN regression; validly
   re-signed policy/identity changes, every missing required field, no allocation/
   active effects, explicit authorized variable1/9/64steps.
7–8. Audit and this report document exact review findings, repairs and evidence.

Seven other P2P artifacts frozen; no schema/DTO generation needed. All nonclaimed
baseline450 dependencies and prior kernel6 protected; no Main read/integration,
agents/modelcalls/installs/Forge/controller/trainer/private data or weights edits.

### RED/GREEN and actual final commands
Owned evidence directory:
`C:\Users\abel\AppData\Local\Temp\2\opencode\oc3-review-f0026de2fdb0425897a83ca883cf9b66`.
- Before fix `python -B -m pytest -q -s -p no:cacheprovider runtime/isxprobe/test_peer.py -k review_resigned`: expected exit1;
  `red.log`: old valid re-sign accepted, quality=true; issued2fc131dd... versus
  locally received0ee4a276... (reviewer's received hash differed, not inferred equal).
- Focused GREEN peer tests17pass exit0; OS `go test -count=1 -timeout30s ./cmd/imc-peer-probe -run TestReview` exit0;
  Ilaria `go test -count=1 ./runtime/isxprobe` exit0. Subsequently added explicit
  variable steps tests, included in final suite.
- Final `python -m py_compile forge/imc_model.py forge/train_ilaria.py forge/training_state.py runtime/isxprobe/peer.py runtime/isxprobe/test_peer.py`: exit0.
- Final `python -m pytest -q -p no:cacheprovider forge/test_imc_model.py runtime/isxprobe/test_peer.py forge/test_collective_sleep.py`: exit0,
  **74passed50.78s**, `pytest.log` (bytecode outside repo).
- Ilaria `go test ./...` and `go vet ./...`: exit0, `ilaria-{test,vet}.log`.
- OS `go vet ./...` and `go test -count=1 -timeout180s ./...`: exit0,
  `os-{vet,test}.log`, new command included. Process-local caches and GOPROXYoff.
- Real demo:
  `go run ./cmd/imc-peer-probe --local-probe --demo --python C:\Python312\python.exe --public-library-root C:\Users\abel\AppData\Roaming\Python\Python312\site-packages --peer E:\nexus-worktrees\opencode-cleanup-matrix\ilaria\runtime\isxprobe\peer.py --state <evidence-dir>/repaired-state`: exit0, `demo.log`.
  Paths above are explicit operator config for THIS host only, not source constants.
- Same-state/round command repeated once: expected exit1, `replay.log`; no second
  dispatch/adoption. Did not expose checkpoint tensor contents or private keys.

### Actual repaired demo scalars / limitations
Proposer12460/evaluator25588. before/candidate/active/rollback CE:
**3.2246127128601074 / 2.475658416748047 / 2.475658416748047 / 3.2246127128601074**.
Anchors0.03125/0.21875/0.21875/0.03125. Train3.153565168→0.055789080.
Base/rollback SHA `dddbe3c373b7581aae57ba6674c65d41d0e177277f64b7c6d398840c5fcd8d71`;
active SHA `48169b987dce331ebe8073669626b9d06078dd0e41818b142be7ab0f40bef70f`.
Rawdelta39680B; candidate130062B/evaluation108180B/framecap262144B;
Job1GiB/25%CPU/max2/deadline120s; evaluator5.296407s. Actual peak RSS remains
uninstrumented, not inferred from caps. Other previous local/FS/crash/concurrency
limits preserved. Signature proves origin, not authorization/compute quality;
issued exact recipe policy is now required separately. No production/swarm/
IMC1B/IlariaLex65k/superiority/pilot claim. Stop at frozen root-review handoff.

Final review verification: `git diff --check` exit0; supplemental frozen7,
protected dependencies/original450 nonclaimed entries/kernel6 hash checks and
eight-file whitespace checks exit0, zero mismatches. No schema regeneration,
untouched Swyp/native suite rerun or Main reads. Final repaired SHA256:
- OSmain `0408c13d2a6d68474367203e49c8a1c058870ff10a66c9bd462bc9266ec752f0`
- OStest `5588b60f544426970d1f2e0024767ef295269c714ad69d357c0f845f5d5179c6`
- contract `8d401732299e9779985aaa3e78f41a4ca2a7c324ff97e2efce466accda3fa756`
- contracttest `5546186c6b60386d384fc60722661e3d8892f4af7152bdb7abc5bb0bef3aaa9d`
- peer `e657632cbaa2b2e7738529c3ecb93ade41958de5fe50be5d345f1be6feafa06e`
- peertest `61da4eeaa6db5efa5ae648d77f81cd765716d3a23b0c491a8699c8778d11c880`
- audit `6e525c44c105f6bfec971a4845a6c7504246a6e3e6e4b68be2f478c340fb7bd7`
Report self-hash not embedded; root may hash final report externally. FREEZE.
