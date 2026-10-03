# SWOS M1 — Independent QA: Universal Device Synthesis + Native Kernel Seed

ROLE: independent principal systems/kernel/security verifier. READ-ONLY source. Do not repair.

READ:
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- E:\CEO\projects\swos\analysis\07-owner-correction-os-compute.md
- E:\CEO\wt\swos-device-synthesis-m1\swypik-os\core\devicesynth\**
- E:\CEO\wt\swos-device-synthesis-m1\swypik-os\docs\DRIVER_SYNTHESIS_SECURITY.md
- E:\CEO\wt\swos-device-synthesis-m1\swypik-os\docs\UNIVERSAL_NATIVE.md
- E:\CEO\wt\swos-native-kernel-seed-m1\swypik-kernel\**

ONLY WRITE:
E:\CEO\projects\swos\analysis\11-device-kernel-qa.md

Candidate D — Device Synthesis:
- audit HardwareManifest/DeviceGraph validation, canonical binding hashes, duplicate/cycle/reference issues;
- audit Driver ABI capability semantics and any authority confusion;
- verify Synthesizer is only a proposal boundary;
- verify test/provenance/build/toolchain hashes are actually enforced;
- audit adaptation journal crash/corruption behavior, legal transitions, activation/rollback invariants;
- reproduce unknown-device E2E and add adversarial reasoning for tampered candidate, stale verification, binding mismatch, undeclared capability, corrupt journal.

Candidate E — Native Kernel Seed:
- inspect all C headers/source/build script;
- verify no Linux dependency/copied Linux source;
- verify capability generation/revocation/domain/fence semantics;
- inspect DeviceGraph decoder for overflow, aliasing, malformed lengths/refs, duplicate IDs;
- inspect bounded IPC for overflow/stale refs;
- inspect UEFI ABI/calling convention, PE32+ EFI structure, entrypoint and memory-map capture;
- verify build.ps1 performs no disk/boot mutation and artifact has no DLL imports;
- independently rebuild twice and compare SHA256;
- do NOT claim boot success because QEMU is absent;
- distinguish architecture contract compile checks from real ARM64/RISC-V binaries.

Run D:
go test -count=1 -race ./core/devicesynth
go vet ./...
go test -count=1 -timeout 180s ./...
git diff --check

Run E:
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 twice
objdump -x out\efi\BOOTX64.EFI
git diff --check
also run root/swypik-os Go vet/test if source unaffected where reasonable.

Verdict separately: VERIFIED / REJECTED / BLOCKED.
For defects: exact file:line, severity, reproduction, minimal repair.
No commit/push/deploy.