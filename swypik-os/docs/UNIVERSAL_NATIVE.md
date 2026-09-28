# SWYPIKOS UNIVERSAL NATIVE — AI-ADAPTIVE INSTALLATION

**Owner direction:** 2026-09-28
**Status:** active architecture requirement

## North Star

SwypikOS is designed as a first-party operating system that can adapt natively to
multiple device classes: desktop/laptop, phone/tablet, embedded/edge, automotive
compute, robots/appliances and future hardware.

“Universal” means one architecture, contracts and toolchain across devices — not a
claim that every locked/proprietary device can be installed on without vendor
permission or technical access.

The target support classes are:
- x86-64;
- ARM64;
- RISC-V 64;
- extensible architecture ports.

A device is installable only when its boot chain permits third-party software and
the required hardware interfaces/firmware can be accessed lawfully and safely.

## Core idea: the installer contains Ilaria

Installation is not a static image copy.

The installer runs a constrained Ilaria adaptation loop:

```text
BOOTSTRAP
  ↓
PROBE HARDWARE
  ↓
BUILD Hardware Manifest / Device Graph
  ↓
MATCH signed known drivers/adapters
  ↓
unsupported device?
  ├─ no → stage known signed artifact
  └─ yes
       ↓
     Ilaria synthesizes candidate adapter/driver
       ↓
     Swyp semantics + capability contract
       ↓
     compile in isolated build domain
       ↓
     static verification + ABI checks
       ↓
     emulation/property tests
       ↓
     controlled hardware probe
       ↓
     canary driver domain
       ↓
     health/evidence gate
       ↓
     locally sign/bind artifact to exact hardware+firmware
       ↓
     activate / rollback
```

Ilaria may WRITE CODE. Ilaria does not get unrestricted kernel authority.

## Universal Hardware Description

Every install produces a canonical, signed Hardware Manifest.

Minimum identity:
- architecture / ABI / endianness;
- firmware/boot environment;
- ACPI tables and/or DeviceTree;
- PCI/PCIe IDs, class/subclass/progIF;
- USB VID/PID/interfaces;
- storage buses;
- display/GPU identities;
- network devices;
- input devices;
- audio/camera sensors;
- battery/power/thermal controllers;
- IOMMU/interrupt capabilities;
- CPU/NPU/GPU features;
- device firmware versions where exposed.

Raw serials/private identifiers are excluded unless strictly needed and user
consent/policy allows them.

## Driver model

SwypikOS should prefer isolated user-mode driver domains.

A generated driver receives narrow capabilities:
- MMIO region;
- port I/O where architecture allows;
- IRQ/vector;
- DMA buffer/IOMMU mapping;
- device configuration space;
- clock/reset/power control;
- bounded shared-memory IPC.

It does not receive ambient kernel memory or unrestricted filesystem/network.

Kernel-resident code is reserved for the smallest trusted mechanisms.

## Driver Synthesis Contract

Ilaria receives:
- Hardware Manifest subset;
- Driver ABI version;
- hardware protocol/spec evidence from approved sources;
- known-safe driver examples/templates;
- allowed effects/capabilities;
- test contract.

Ilaria returns:
- source/IR candidate;
- declared hardware assumptions;
- capability request;
- build manifest;
- tests;
- provenance/evidence references.

Never accept a driver because the model says it works.

## Verification ladder

Candidate must pass, in order:
1. schema/ABI validation;
2. forbidden-operation scan;
3. memory-safety/static checks where supported;
4. deterministic unit/property tests;
5. emulator/fake-device protocol tests;
6. capability/effect audit;
7. controlled device probe with write operations minimized;
8. canary activation in isolated driver domain;
9. health/timeout/fault-injection gate;
10. rollback proof.

Unknown or failed hardware falls back to:
- generic standards driver;
- degraded safe mode;
- unsupported device reporting;
never uncontrolled generated code.

## Device classes

### PC / laptop
Full OS target: storage, display, Wi-Fi, BT, audio, camera, input, suspend.

### Phone / tablet
ARM64-first. Must account for:
- locked boot chains;
- DeviceTree;
- proprietary GPU/modem/ISP firmware;
- touch/display/power domains;
- cellular/baseband separation.
Initial targets should be unlockable reference devices.

### Automotive
Initial target is infotainment/compute domain, not safety-critical vehicle control.
Generated code may not control brakes, steering, airbags, propulsion or other
safety-critical actuators without a separately certified safety architecture and
OEM authorization.

### Embedded / robot / appliance
Board support package + DeviceTree + capability-isolated drivers. Safety policy is
device-class specific.

## Kernel/platform design implications

The Swypik-owned kernel/platform must be portable by construction:
- architecture HAL is small and explicit;
- machine-independent scheduler, IPC, capability and memory abstractions;
- per-arch boot/interrupt/context-switch/MMU modules;
- driver ABI independent of architecture;
- device graph independent of firmware source;
- generated/adapted drivers mostly outside privileged kernel core.

No architecture-specific logic should leak into the control plane.

## Ilaria at install

Installer Ilaria must have:
- offline local inference mode;
- signed knowledge packs;
- optional network research only with explicit policy;
- no access to user data partitions by default;
- bounded code generation;
- deterministic build manifests;
- reproducible compiler/toolchain identity;
- evidence bundle for every generated artifact.

The installed system records exactly which code was generated, why, for what
hardware, from which sources, with which tests, hashes and verifier verdicts.

## Swyp Lang role

Swyp becomes the typed semantic layer for installation/device adaptation:
- HardwareIntent;
- DriverRequirement;
- CapabilityRequirement;
- EffectRequest;
- TestContract;
- InstallationPlan;
- rollback invariants.

Swyp does not mint device authority. SwypikOS does.

## Swyp Compute Fabric role

After install, an opted-in device can contribute idle compute. The same universal
Hardware Manifest feeds compute scheduling:
- GPU/NPU/CPU type;
- VRAM/RAM;
- measured throughput;
- thermal/power budget;
- network quality.

This makes every installed SwypikOS machine a potential verified compute node for
Ilaria without coupling hardware support to one vendor.

## M1 deliverables

1. portable Hardware Manifest + Device Graph schema;
2. Driver ABI v1;
3. install/adaptation state machine;
4. Ilaria Synthesizer interface;
5. deterministic verifier interface;
6. signed Artifact Manifest;
7. rollback/canary state;
8. x86-64 UEFI Swypik kernel/platform seed;
9. ARM64/RISC-V port contracts even if not booted yet;
10. simulated unknown-device synthesis test end-to-end.

## Hard non-claims

Do not claim:
- every existing phone can be unlocked;
- proprietary undocumented hardware can always be supported;
- AI can safely infer undocumented electrical/device behavior without evidence;
- generated automotive safety code is production-safe;
- a generated driver is accepted without independent verification.

The revolutionary part is not “AI writes random kernel code”. The revolutionary
part is a first-party OS whose installation pipeline can **synthesize, verify,
canary and remember hardware support** under explicit capability boundaries.

## M1 implementation status — 2026-09-28

The first verified implementation slices now exist:

- `core/devicesynth` — substrate-independent HardwareManifest/DeviceGraph,
  Driver ABI v1, Ilaria Synthesizer boundary, deterministic verifier, Ed25519
  verifier attestations, durable adaptation journal, canary/rollback and
  adversarial tests;
- `../swypik-kernel` — first-party kernel/platform seed with portable
  x86_64/ARM64/RISC-V contracts, capability table, bounded IPC, canonical
  DeviceGraph wire format and an x86_64 PE32+ UEFI seed artifact;
- `core/controlkernel` — independently verified durable authority-plane
  foundation for leases/fencing, attempts, event history, reconciliation and
  verification epochs.

Independent QA reports:

- `E:\CEO\projects\swos\analysis\12-control-kernel-r2-qa.md` — VERIFIED;
- `E:\CEO\projects\swos\analysis\13-device-kernel-repair-qa.md` — Device
  Synthesis VERIFIED, Native Kernel Seed VERIFIED; runtime UEFI boot remains
  BLOCKED only because QEMU is not installed on this workstation.

These are foundations, not universal-device support claims. The next milestone
is integration: installer → hardware probe → device synthesis → control kernel
task/evidence → driver-domain activation, plus a real two-node Compute Fabric
pilot.
