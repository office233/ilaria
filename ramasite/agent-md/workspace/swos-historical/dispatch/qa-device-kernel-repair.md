# SWOS M1 — Fresh QA after Device Synthesis + Native Kernel repairs

ROLE: independent principal kernel/security verifier. READ-ONLY source. Do not repair.

READ FULL:
- E:\CEO\projects\swos\analysis\11-device-kernel-qa.md
- E:\CEO\projects\swos\dispatch\agent-D-device-synthesis-repair.md
- E:\CEO\projects\swos\dispatch\agent-E-native-kernel-repair.md
- E:\CEO\wt\swos-device-synthesis-m1\swypik-os\core\devicesynth\**
- E:\CEO\wt\swos-device-synthesis-m1\swypik-os\docs\DRIVER_SYNTHESIS_SECURITY.md
- E:\CEO\wt\swos-native-kernel-seed-m1\swypik-kernel\**

ONLY WRITE:
E:\CEO\projects\swos\analysis\13-device-kernel-repair-qa.md

Candidate D — re-verify every former D-1..D-5:
D-1 non-forgeable verification attestation: protected STAGE/CANARY/ACTIVE transitions must require a trusted verifier-issued attestation bound to candidate+hardware+artifact+verifier version+target state+evidence, and reload must revalidate it.
D-2 candidate provenance cannot self-approve; external registry exact membership required.
D-3 actual artifact bytes are hashed; test evidence is external/trusted and bound to candidate/artifact/toolchain/contract.
D-4 closed ABI v1 capability vocabulary + external trusted capability observation; candidate omission cannot hide scanned capabilities.
D-5 bus parents/self/cycles + duplicate/self/cyclic topology invalid.
Try adversarial fabricated/stale/tampered attestation, fake provenance, fake test pass, artifact mismatch, arbitrary capability string and malformed graph cases.

Run D:
go test -count=1 -race ./core/devicesynth
go vet ./...
go test -count=1 -timeout 180s ./...
git diff --check

Candidate E — re-verify every former E-1..E-6:
E-1 fixed-width strings canonical/safe.
E-2 zero/wrapping/invalid resource ranges cannot mint capabilities.
E-3 nonzero reserved/padding bytes rejected.
E-4 generation exhaustion retires slot or otherwise cannot revive stale handle.
E-5 IPC validates sender/receiver capability + domain + fence + endpoint rights.
E-6 parent/topology self/duplicate/cycles rejected according to documented semantics.
Also inspect for integer overflow/length arithmetic bugs introduced by repair.

Run E:
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 twice and compare SHA256
objdump -x out\efi\BOOTX64.EFI
git diff --check
No QEMU boot claim. QEMU absence is BLOCKED for runtime boot evidence, but not automatically a source rejection if the seed contract is structural only.

For each candidate return VERIFIED / REJECTED / BLOCKED. Any defect: exact file:line, severity, reproduction, minimal repair. No commit/push/deploy/source write.