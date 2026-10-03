# SWOS M1 — Universal Device Synthesis Engine

WORKTREE EXCLUSIV: E:\CEO\wt\swos-device-synthesis-m1
BASE: f0b244a
Do not touch E:\nexus main or other worktrees.

Read first:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\07-owner-correction-os-compute.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\wt\swos-device-synthesis-m1\AGENTS.md
- swypik-os/docs/NATIVE_OS.md and docs/ILARIA_COMPUTE.md

OWNER GOAL:
SwypikOS must adapt natively to many device classes. During installation, Ilaria may write device-support code for the exact machine. The revolutionary part is synthesize → verify → canary → rollback, not blindly executing model code.

IMPLEMENT M1 foundation in swypik-os:
Preferred new package: core/devicesynth (or a better precise name) plus a small cmd/swypik-adapt CLI if useful.

Required real code:
1. Canonical HardwareManifest + DeviceGraph:
   - arch: x86_64/arm64/riscv64 + extensible;
   - firmware: UEFI/ACPI/DeviceTree;
   - buses/devices: PCI/PCIe, USB, platform, storage, display, network, input, audio/camera, power;
   - privacy-safe identities; no raw serials by default.
2. Driver/Adapter ABI v1:
   - versioned manifest;
   - target device selector;
   - logical capabilities: mmio/ioport/irq/dma/config/power/clock;
   - architecture-independent service interface;
   - explicit generated-source/toolchain/provenance hashes.
3. Install adaptation state machine:
   PROBE → MATCH → SYNTHESIZE → BUILD → VERIFY → STAGE → CANARY → ACTIVE, with FAILED/ROLLBACK/SAFE_MODE.
4. Synthesizer interface for Ilaria:
   input = unsupported device slice + hardware manifest + ABI + approved evidence references;
   output = candidate bundle/source/IR + assumptions + requested capabilities + tests.
   Do NOT call a remote model inside the core package; define the boundary cleanly.
5. Deterministic verifier interface and default checks:
   schema/ABI;
   allowed capability set;
   source/build hashes;
   no undeclared capability;
   test evidence required before STAGE/CANARY;
   exact hardware/firmware binding.
6. Artifact manifest and local trust record suitable for signing later.
7. Rollback/canary state persisted in a small durable journal or deterministic state file with atomic writes.
8. End-to-end test with a simulated unknown device:
   probe → no known driver → synthesized candidate → rejected if unverified → verified → canary → activate → health failure → rollback.
9. Docs: UNIVERSAL_NATIVE implementation contract and DRIVER_SYNTHESIS_SECURITY.md.
10. Keep current Linux code only as one probe source/reference. The new schema must not be Linux-specific.

Important:
- generated drivers should be user-mode/capability-domain by default;
- no direct arbitrary kernel memory authority;
- no fake "AI works on every device" claim;
- phone/car constraints must be documented;
- automotive safety-critical actuators remain out of scope absent certified architecture/OEM authorization.

Gemini: if Antigravity/Gemini 3.8 Flash is exposed, use up to 5 read-only subagents for ABI critique, mobile/automotive hardware model review, adversarial synthesis security and test generation. Only you edit source.

Final:
gofmt; go vet ./...; go test -count=1 -timeout 180s ./...; git diff --check.
No commit/push/deploy.