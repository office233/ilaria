# Local IMC two-process probe — partial implementation

State: COMPLETE — local synthetic signed/adopt/rollback prototype only.

## Independent-review repair — final current checkpoint

Main integration remained HELD. Exactly eight supplemental allowed files changed;
schema/manifest/DTOs, benchmark/init and kernel artifacts frozen. No scope expansion.

**RED reproduced before fix:** same ephemeral Ed25519 key, real legitimate16step
delta and unchanged nonce/fence/consent were re-signed with learning_rate0.02,
max_delta_norm2000,min_improvement1e-12. Old verifier accepted; evaluate accepted
quality. Issued recipe SHA2fc131ddc637d24c5fa456394dc49598bfad66c8e97da2b2969d53986cd43f29
versus locally reproduced received SHA0ee4a276e71866f9ae11c9147e0a32049cc9a6a3aac6f62d8eb4ae28431b87d2.
The independent review reported a different changed-recipe hash; no equivalence
assumed for JSON numeric representations. Model/base/fixture mutations were not
claimed final evaluation bypasses (previous evaluator rejected those later).

**GREEN:** OS sends the issued recipe to evaluator preparation before receiving
any candidate. Canonical Ilaria initialization computes base/model/fixture/recipe
identities from that request, not the candidate. OS retains them as dispatch
authorization together with version/expert/peer/round/consent/fence/nonce/deadline/
signer identity. Evaluator retains its own issued identities and rejects changed
dispatch. Required expected binding keys/types/nonempty values are mandatory.
Valid re-signatures of changed learning-rate/norm/improvement/steps or identities
are denied before candidate allocation/apply/checkpoint/pointer effects. Authorized
variable1/9/64step recipes remain accepted. Go contract requires complete expected
version/expert/hash fields; Go dispatch checks the same issued wire identities.
No model logic imported into OS; canonical IMC/sleep reused. Schema/DTOs unchanged.

**Portability:** main no longer embeds a user/machine/Python-version path. Use
explicit `--python` or executable PATH lookup. Optional `--public-library-root`
is forwarded only when supplied as a single argument (spaces preserved); isolated
Python-I never adds ambient user-site. Missing dependency reports prepare/import
failure with instruction to supply public library root; no search/install fallback.
This host's operator supplied `--python C:\Python312\python.exe` and
`--public-library-root C:\Users\abel\AppData\Roaming\Python\Python312\site-packages`;
these are operator configuration examples, not production constants.

Repaired two-process demo exit0, proposer12460/evaluator25588; measured checkpoint
CE before3.224612713/candidate2.475658417/active2.475658417/rollback3.224612713;
active/base/rollback hashes unchanged from previous numeric fixture evidence.
Signed candidate130062B/evaluation108180B/raw39680B; evaluator5.296407s;
same-state replay expected exit1. No tensor contents/private keys logged.

Focused regressions: RED pytest exit1; GREEN peer17tests and Go dispatch/contract
exit0. Final gates:74pytest passed50.78s, py_compile canonical3+peer/test0,
Ilaria Go test/vet0, OS full vet/test-count1-timeout1800. No untouched Swyp/native
repetition. Final frozen SHA and diff evidence in worker report. Existing trusted
local/small-vocabulary/memory-peak/power-loss/concurrency limitations remain;
this repair does not imply production deployment, IMC1B, IlariaLex65k or swarm.

## Final continuation (supersedes historical partial sections below)

Exactly15 allowed paths, including corrected benchmark paths under
`bench/myriad/pce_transfer_v1`; no `cmd/ilaria/benchmark*` drafts created.
Frozen6 kernel claims and all450 baseline dependency entries outside allowed paths
hash-match. No Forge/canonical controller/trainer edits or native-kernel reruns.

### Signed two-process pipeline

Proposer creates Ed25519 private key in process memory; dedicated own pipe registers
only public key before dispatch. No private key argv/log/file or user key access.
The existing public cryptography50.0.1 package is in user-site; isolated Python
explicitly imports that public dependency root only, without enabling ambient
user-site. Canonical IMC and sleep imports remain unchanged.

Signed canonical sorted JSON covers version, peer/expert/round, model config, random
base hash, fixture/recipe, consent epoch/fence, nonce, deadline, raw bytes count,
tensor names/shapes/dtype/offsets, exact base64 payload and SHA256 of concatenated
raw float32 little-endian delta. Signature fields are blank in signed bytes.
Evaluator rejects duplicate/unknown keys, noncanonical metadata mismatch, invalid
signature and stale bindings before allocating a model or applying tensors.
Finite/shape/base64 length/norm checks precede candidate mutation. Go Ilaria typed
contract verifies same Ed25519/canonical metadata/raw SHA; OS imports wire DTO only.

OS uses existing ControlKernel executor authentication/live lease/fence at dispatch
and commit, live own-state `consent.json` opt-in/epoch read at both points, and
cancelled/operator-required node denial. Existing ControlKernel writer lock owns
the local session; OS releases it on crash. Durable O_EXCL nonce/round entries are
synced before dispatch and never re-executed after reject/restart/crash. Ledger
directory bound128 entries fails closed; demo state supports a single round.
One candidate pending, hard256KiB JSON frame (measured ~130KB), existing capacity1
JSONL queue; 25% host CPU/1GiB aggregate/two-process Windows Job, 120s deadline.

Candidate-copy evaluation reuses consolidate exactly once. Rejected candidate does
not publish an active candidate. Immutable SHA-addressed JSON tensor checkpoints
are stored only under explicitly supplied own temporary state. Synced temporary
files+os.Rename replace own active pointer; pending transaction records base/candidate.
Any ordinary error after prepare restores baseline; process-crash restart under
kernel writer lock recovers baseline. No pickle; no production model/pointer.
Demo always rolls back its local active pointer. Evaluator re-loads actual active
and rollback checkpoint bytes from relay and recomputes holdout CE/anchors.

### Actual final demo

Distinct proposer23400/evaluator20224 under Windows Job:
- before CE3.2246127128601074, anchors0.03125;
- candidate CE2.475658416748047, anchors0.21875;
- active reloaded CE2.475658416748047, anchors0.21875;
- rollback reloaded CE3.2246127128601074, anchors0.03125;
- train CE3.1535651683807373→0.05578907951712608;
- raw delta39680B, signed candidate frame130060B, evaluation frame108179B;
- signed raw delta SHA `9f5597130b80ab5bc3e40ee08ec53ff79958a57227a061134738291fd6e1be52`;
- base/rollback `dddbe3c373b7581aae57ba6674c65d41d0e177277f64b7c6d398840c5fcd8d71`;
- active `48169b987dce331ebe8073669626b9d06078dd0e41818b142be7ab0f40bef70f`;
- evaluator compute2.33297759999914s; end-to-end startup separately bounded120s;
- restarted same state/round command: expected exit1 replay/ledger failure.

### Final gates

- canonical3+new peer/test py_compile exit0;
- canonical IMC+sleep+peer pytest exit0: **66 passed**;
- Ilaria Go test/vet exit0 (public PCE12-task fixture always runs);
- external corpus audit requires explicit ILARIA_BENCH_TASK_CORPUS; unset skips
  ONLY external audit, explicit nonexistent path expected exit1 (no fallback);
- OS full vet/test-count1-timeout180 exit0; new command tests pass;
- Swyp check/compile/go generation exit0, fresh manifests/DTO mirrors verified;
  prior full Swyp vet/test exit0, compiler production unchanged;
- signature tamper/unknown/duplicate/stale, shape/dtype/NaN/Inf/norm/oversize,
  regression/rejection/candidate exception, nonce/round restart, live consent revoke,
  kernel cancelled/stale fence, strict-group timeout/backpressure, aggregate process
  cap and allocation128MiB rejected under64MiB Job cap all tested;
- actual separate test process exits23 immediately after candidate-pointer write;
  parent recovery restores content-addressed base, idempotently.

### Limits (not hidden by COMPLETE)

Local trusted prototype, not Internet swarm/IMC1B/pilot/superiority. Numeric16-token
fixture is not IlariaLex65k deployment. Signatures prove byte origin, not compute or
quality. Single-owner journal/consent file is not a remote authority protocol;
revocation checked at dispatch and commit boundaries, not an atomic distributed
transaction with arbitrary concurrent consent writers. No concurrent external
mutation of owned state is supported. No power-loss/directory-fsync guarantee,
Windows FAT/network-filesystem atomicity or hostile filesystem/sandbox proof.
Memory hard-cap exhaustion is tested; actual IMC peak RSS is uninstrumented and
not claimed. CPU hard cap is successfully configured, not benchmarked at saturation.
Crash regression uses abrupt subprocess exit, not physical machine failure.
The demo's rollback is mandatory cleanup, not unattended production promotion.

Logs, exact command exits and updated source hashes in worker report.

## Demonstrated, not adoption

Two existing Windows Python 3.12 processes imported canonical Forge
`ImcConfig`/`ImcTransformer`, initialized deterministically from random seed 1701,
trained on public synthetic tokens and evaluated an independent candidate copy.
No pretrained checkpoint, private data, production weights or model calls.

The proposer performs 16 AdamW updates on a small IMC (16-token vocabulary,
32-dimensional, one layer, four query/two KV heads, FFN64, EOS15, context8).
Recipe and bounds are explicit in `peer.py`; steps must be 1..64. Train/eval/anchor
sequences have disjoint starting-token sets and explicit EOS targets. This is a
synthetic numeric-token fixture, not a trained IlariaLex deployment/tokenizer claim.

Evaluator reconstructs the same random base and checks exact recipe/fixture/base/
delta hashes, name set, shapes, float32 little-endian dtype, exact base64/raw byte
budgets, finite values and delta L2 norm before applying once to a candidate copy.
It reuses canonical `collective_sleep.consolidate` with one apply step, locally
recomputed training CE, independent no-grad holdout CE and anchor accuracy; policy
max_steps=1/eval_every=1/min_improvement=0.0001/max_anchor_accuracy_drop=0.
Canonical instance restored in finally. The active/production instance is never
mutated. Rejection yields no checkpoint payload.

The OS command uses existing `planprocess.OpenGroup`/`Group.Start`, no cooperative
fallback: Windows Job Object aggregate hard cap 1GiB, 25% host CPU, two processes,
120s operation deadline. Child framing uses existing bounded JSONL channel
(capacity1) and 9MiB maximum payload frame. Configured 9MiB is an upper ceiling,
not justified as required: measured frame is only ~55KB; a tighter final protocol
limit should be selected before adoption is enabled. No claims about hostile-code
sandboxing or empirical cap-exhaustion enforcement.

Actual evaluation-only output:
- proposer PID16964, evaluator PID13492 (two distinct real processes);
- train CE 3.1535651683807373 → 0.05578907951712608;
- evaluator baseline holdout CE 3.2246127128601074 → candidate 2.475658416748047;
- anchor accuracy 0.03125 → 0.21875; candidate quality eligible=true;
- locally recomputed candidate train CE 0.05165453255176544;
- raw delta39680 bytes; proposer JSON frame54700 bytes; evaluator frame54328 bytes;
- proposer measured compute1.6726577999979781s, evaluator1.9536699000018416s;
- sampled process CPU4.453125/4.515625s (includes Python imports/startup);
- sampled RSS/peakRSS after exit0/0: **not valid memory-peak evidence**.
- active=null, rollback=null: no adoption or rollback was executed.

## Incomplete safety path — deliberately gated

Default `--local-probe` returns BLOCKED. `--containment-check` and
`--evaluation-check --peer <absolute allowed peer.py path>` are separate explicit
non-promoting checks. No production promotion pointer is created. The relay HMACs
exact candidate bytes with a newly random ephemeral key and verifies locally;
this is NOT peer-origin signature authentication, independent trust or compute
proof. `parameter_delta_hash` in Python names tensor delta; initial Go envelope
validator hashes its supplied signed payload instead. These must be unified before
an end-to-end protocol can be considered complete. Initial validator does not
cryptographically bind all envelope metadata, reject duplicate JSON keys, implement
durable nonce/round consumption, or validate model quality; not production-ready.

Missing implementation: live ControlKernel dispatch/commit authorization and
revocation, consent epochs checked at both points, restart-safe at-most-once nonce/
round ledger, full signed canonical metadata+payload envelope, immutable checkpoint
publication, atomic promotion pointer/rollback and crash recovery. Missing tests:
durable replay/restart/revoke, timeout/backpressure integration, malicious oversize
processes, commit race/crash rollback and cap-exhaustion/peak-memory evidence.
No fallback, forged promotion PASS, Internet swarm/IMC1B/pilot/superiority/TFLOPS claim.

## Canonical schema and gates

`myriad.swyp` retains all old declarations and adds `IMCLocalProbeEnvelope`, reusing
expert/genesis/parameter_delta/recipe/fixture lineage field names. Manifest and
Ilaria/OS DTOs generated by the same existing Swyp compiler from that source in
fresh temporary paths; compiler overwrite protection preserved. Both Go mirrors
are byte-identical; no Go internal cross-product import.

Results (2026-10-01):
- containment-check exit0; evaluation-only check exit0, NOT required full demo.
- Python py_compile canonical3+new peer/test: exit0, temp bytecode path.
- pytest canonical IMC+new peers: exit1, 12 failed/44 passed, inherited missing
  `forge/dataset_manifest.py` import (trainer source not changed).
- canonical collective_sleep pytest: exit0, 7 passed.
- Ilaria Go tests exit1: inherited `bench/myriad/pce_transfer_v1/benchmark_test.go:75`
  missing `tasks.jsonl`; new isxprobe contract tests pass. Ilaria vet exit0.
- OS full vet and test -count=1 -timeout180s: exit0, including new command tests.
- Swyp full vet/test-count1 exit0; component check/compile/go generation exit0;
  generated output comparison exit0. Swyp production sources unchanged.
- All six protected frozen kernel hashes match `.nexus-p2p-baseline.json`;
  kernel/native matrix not rerun. No forbidden sources or production weights read.

Temporary evidence paths and final source hashes are in `worker-oc-3-p2p.md`.
Hand off partial work as BLOCKED, not COMPLETE, until missing safety implementation,
required full demo and inherited gate fixtures are resolved within authorized scope.
