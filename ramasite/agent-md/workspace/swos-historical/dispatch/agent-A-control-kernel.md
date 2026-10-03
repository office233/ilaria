# SWOS M1 — Agent A: Control Kernel foundation

WORKTREE EXCLUSIV: E:\CEO\wt\swos-control-kernel-m1
BASE: cc688dd
Nu lucra în E:\nexus main și nu atinge alte worktree-uri.

Citește:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\projects\swos\analysis\01-kernel-security.md
- E:\CEO\projects\swos\m0\Q-bench-fault-suite.md
- E:\CEO\wt\swos-control-kernel-m1\AGENTS.md

Auditul vechi era pe 96290fa; baza ta este cc688dd. Inspectează live.

## Implementare
Lucrează în swypik-os\core\controlkernel\**; docs ADR relevant permis în swypik-os\docs.

1. Typed model: Task/Node/Edge/Attempt/Event/Lease/Intent/Verification/Budget.
2. State machine validată: PENDING→READY→LEASED→PREPARING→EXECUTING→VERIFYING→COMMITTING→SUCCEEDED; RETRY_WAIT; UNCERTAIN→RECONCILING; FAILED/CANCELLED/BLOCKED/OPERATOR_REQUIRED.
3. Durable EventStore: expected-seq CAS, integrity/hash-chain, fsync, torn-tail recovery, middle corruption fail-closed.
4. Lease manager: id, TTL, renewal, monotonic fencing, stale fence reject.
5. Side-effect journal: PREPARED/STARTED/RESULT/UNCERTAIN/RECONCILING/COMMITTED + idempotency key; no blind replay.
6. Projection/query API pentru scheduler ulterior.
7. Tests: duplicate idempotency, stale lease, torn append, middle corruption, invalid transition, concurrent CAS.
8. Nu rewira desktopul încă decât dacă compatibilitatea este demonstrată.

## Gemini accelerator
La început rulează provider_status. Dacă Antigravity/Gemini 3.8 Flash este AVAILABLE, poți porni MAXIM 5 antigravity_submit read-only pentru design critique/test-generation. Tu ești singurul autor. Dacă unavailable, continui imediat.

## Reguli
- nu citi data/, cuda/, .env*, secrets, binaries;
- nu commit/push/deploy;
- diagnostics după editări;
- gofmt;
- final din swypik-os: go vet ./... și go test -count=1 -timeout 180s ./...
- inspectează git diff.

Raport final: files changed, invariants, tests exacte, rest de integrare.
