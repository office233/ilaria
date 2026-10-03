# SWOS M1 — Control Kernel Repair Round 2 QA

Independent read-only verification. Do not repair source.
READ:
- E:\CEO\projects\swos\analysis\09-control-kernel-reqa.md
- E:\CEO\wt\swos-control-kernel-m1\swypik-os\core\controlkernel\**

ONLY WRITE:
E:\CEO\projects\swos\analysis\12-control-kernel-r2-qa.md

Verify specifically that the last blocker is gone:
- ClaimLease must authenticate an executor principal; alias/Owner cannot define security identity.
- Lease must persist authenticated ExecutorID.
- verifier self-check must compare verifier principal to authenticated ExecutorID.
- forged executor credential must fail.
- same executor principal using a different alias must still fail self-verification.
- replay must fail closed if executor identity binding is absent/invalid.
Also spot-check A-2..A-5 were not regressed.

Run:
go test -count=1 -v ./core/controlkernel -run 'TestQAA1|TestVerifier'
go test -count=1 -race ./core/controlkernel
go vet ./...
go test -count=1 -timeout 180s ./...
git diff --check

Verdict VERIFIED / REJECTED / BLOCKED with exact file:line evidence. No source edits, commit, push, deploy.