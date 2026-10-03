# SWOS M1 — Control Kernel repair after independent QA

WORKTREE EXCLUSIV: E:\CEO\wt\swos-control-kernel-m1
BASE: cc688dd
Do not touch E:\nexus main or any other worktree.

Read:
- E:\CEO\projects\swos\analysis\06-m1-implementation-qa.md
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- existing core/controlkernel source + ADR

The independent QA verdict is REJECTED. Repair ALL A-1..A-5 findings, not only tests.

Required fixes:
1. Verification must bind to current AttemptID + LeaseID + Fence + immutable EvidenceHash. Historical PASS from old execution epoch must never authorize a retry.
2. Verifier identity/authority must not be arbitrary payload-only text. Introduce an explicit verifier-authority parameter/interface or equivalent enforceable boundary that prevents the current executor from self-authorizing by choosing another string.
3. Crash recovery table must cover PREPARED, STARTED, RESULT and COMMITTING. No durable phase may strand the node forever. No blind external replay.
4. PREPARED under dead fence needs safe abandon/rebind/new-attempt semantics.
5. RESULT under dead fence needs reconciliation/finalization semantics that preserve exactly-once safety.
6. COMMITTING lease expiry/crash needs durable recovery.
7. STARTED/UNCERTAIN/RECONCILING intents must prevent terminal FAILED/CANCELLED/BLOCKED until external reality is reconciled or explicitly OPERATOR_REQUIRED.
8. Freeze DAG topology before scheduling starts OR introduce graph versioning bound to leases. Retroactive dependencies after READY/LEASED must be impossible.
9. Attempt epochs must be unique and validated; invalid AttemptStatus rejected.
10. Add negative/fault tests reproducing every QA finding, then proving repair.

Gemini: if Antigravity/Gemini 3.8 Flash is exposed, use up to 5 read-only subagents for state-machine critique, fault-matrix review and adversarial test ideas. They may not edit source.

Final gates from swypik-os:
- gofmt
- go test -count=1 -race ./core/controlkernel
- go vet ./...
- go test -count=1 -timeout 180s ./...
- git diff --check
No commit/push/deploy.

Report exact invariants and exact commands/results.