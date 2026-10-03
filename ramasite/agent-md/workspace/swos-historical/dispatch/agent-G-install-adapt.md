# SWOS M1 — Adaptive Installer Integration

WORKTREE EXCLUSIV: E:\CEO\wt\swos-install-adapt-m1
BASE: a5a8175. Nu lucra în E:\nexus main.

Citește:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- E:\CEO\projects\swos\analysis\12-control-kernel-r2-qa.md
- E:\CEO\projects\swos\analysis\13-device-kernel-repair-qa.md
- E:\CEO\wt\swos-install-adapt-m1\AGENTS.md
- swypik-os/core/devicesynth/**
- swypik-os/core/controlkernel/**
- swypik-os/installer/universal/**
- swyp/docs/EFFECTS_CAPABILITIES.md

SARCINA: leagă fundațiile într-un installer/adaptation orchestrator M1 fără să faci disk install real.

Implementă preferabil în swypik-os/core/installadapt și un cmd/sim harness:
1. InstallationPlan + durable phase model:
   DISCOVER→PLAN→ADAPT→VERIFY→STAGE→CANARY→FINALIZE, cu SAFE_MODE/ROLLBACK/OPERATOR_REQUIRED.
2. Adapter interfaces:
   HardwareProber -> devicesynth.HardwareManifest;
   KnownDriverCatalog;
   Synthesizer;
   Builder;
   TrustedTestRunner;
   CapabilityScanner;
   DeviceActivator;
   HealthChecker.
3. Orchestratorul trebuie să folosească devicesynth verifier/journal, nu să bypass-eze atestările.
4. Fiecare mutating step trebuie reprezentabil ca task/evidence în Control Kernel; dacă integrarea directă cu API-ul actual ar introduce coupling periculos, construiește un typed adapter și testează mapping-ul.
5. Generated code never gets kernel/root authority by default.
6. Unknown device flow:
   probe -> miss catalog -> synthesize -> build artifact -> external trusted verification inputs -> signed attestation -> stage -> canary -> health -> activate.
7. Failure flow:
   build/test/attestation/health failure -> rollback/safe mode, no partial success.
8. Resume after crash/restart from durable phase without blindly re-running external activation.
9. Dry-run only: no partitioning, firmware flashing, bootloader changes, real hardware writes.
10. Tests end-to-end with fake adapters and crash injection at every phase.
11. Architecture must remain substrate-neutral (x86_64/arm64/riscv64; Linux not assumed).

Scope:
- swypik-os/core/installadapt/**
- optional swypik-os/cmd/swypik-install-sim/**
- docs/ADAPTIVE_INSTALLER_M1.md
Do not modify core/devicesynth/controlkernel unless an integration defect is proven; if found, report rather than silently widening scope.

Gemini MAX 5 read-only if available for installer state-machine/fault/security review.

Final: gofmt; go test -count=1 -race ./core/installadapt; go vet ./...; go test -count=1 -timeout 180s ./...; git diff --check.
No commit/push/deploy/disk writes.