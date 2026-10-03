# SWOS M1 — Independent QA Audit

ROL: Independent principal verifier. Nu ești autor și NU repari codul în această rulare.

READ-ONLY:
- E:\CEO\wt\swos-control-kernel-m1
- E:\CEO\wt\swos-security-p0
- E:\CEO\wt\swos-swyp-effects-m1
- E:\nexus (doar pentru comparație baseline/current main)
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\projects\swos\analysis\01-kernel-security.md
- E:\CEO\projects\swos\analysis\04-ilaria-swyp.md

SINGURA SCRIERE permisă:
E:\CEO\projects\swos\analysis\06-m1-implementation-qa.md

AUDITEAZĂ 3 candidate:
A) Control Kernel foundation — E:\CEO\wt\swos-control-kernel-m1\swypik-os\core\controlkernel + ADR.
B) P0 secret/process hardening — E:\CEO\wt\swos-security-p0\swypik-os changes.
C) Swyp Effect/Capability ABI — E:\CEO\wt\swos-swyp-effects-m1\swyp changes.

Verifică agresiv, nu valida doar fiindcă testele autorilor sunt verzi.

A — caută:
- journal CAS/locking/fsync/torn-tail/middle corruption;
- hash-chain și frame-integrity;
- state-machine invalid transitions;
- DAG cycle/dependency semantics;
- lease expiry/renew/fencing/stale commit;
- idempotency semantics;
- started side effect crash/reconcile;
- verifier independence/enforcement;
- race/concurrency hazards;
- API claims care depășesc implementarea.

B — caută:
- Windows Unicode env block correctness;
- PATH/SystemRoot/ComSpec viability;
- secret sentinel cannot enter child;
- no accidental propagation of token-like env vars;
- handle inheritance/cancel/descendant cleanup regressions;
- docs must say NOT a full sandbox;
- any newly introduced secret path or compatibility break.

C — caută:
- strict JSON and inability to represent raw capability tokens;
- canonical effect/capability validation;
- transitive propagation;
- backward compatibility pure IR/contracts;
- effectful Core executor must refuse host execution;
- verifier must not claim proof/effect execution;
- effect contract/profile mismatches;
- semantic/API design inconsistencies that would make future broker unsafe.

RUN independent tests:
- in A swypik-os: go test -count=1 -race ./core/controlkernel; go vet ./...; go test -count=1 -timeout 180s ./...
- in B swypik-os: focused secret tests; go vet ./...; go test -count=1 -timeout 180s ./...
- in C swyp: focused Effect|Capability tests; go vet ./...; go test -count=1 -timeout 180s ./...
- git diff --check in all 3.
Inspect source, not only outputs.

Report per candidate:
VERIFIED / REJECTED / BLOCKED.
For REJECTED give exact file:line, severity, reproduction and minimal repair instruction.
Also identify any finding that blocks integration to current main f0b244a.

Nu modifica source. Nu commit/push/deploy.
