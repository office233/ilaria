# SWOS M1 — Control Kernel Repair Re-QA

ROL: Independent principal verifier. READ-ONLY source. Do not repair.

READ:
- E:\CEO\projects\swos\analysis\06-m1-implementation-qa.md
- E:\CEO\projects\swos\dispatch\agent-A-control-kernel-repair.md
- E:\CEO\wt\swos-control-kernel-m1\swypik-os\core\controlkernel\**
- E:\CEO\wt\swos-control-kernel-m1\swypik-os\docs\ADR_CONTROL_KERNEL_EVENT_STORE.md

ONLY WRITE:
E:\CEO\projects\swos\analysis\09-control-kernel-reqa.md

Reproduce and verify every former blocker A-1..A-5 independently:
1. historical PASS cannot cross attempt/fence;
2. executor cannot self-authorize by arbitrary verifier string/credential confusion;
3. PREPARED/STARTED/RESULT/COMMITTING crash windows all have safe liveness;
4. no blind replay;
5. unresolved side effects cannot become unrecoverable terminal states;
6. DAG topology cannot change retroactively after scheduling begins;
7. attempt epochs are unique/kernel-owned and invalid statuses fail;
8. event-store integrity/CAS/race behavior remains intact.

Run:
- go test -count=1 -race ./core/controlkernel
- go vet ./...
- go test -count=1 -timeout 180s ./...
- git diff --check

Write VERIFIED / REJECTED / BLOCKED with exact file:line evidence and reproduction for any defect. No commit/push/deploy.