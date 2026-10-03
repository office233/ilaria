# SWOS M1 — Swypik-owned Native Kernel Seed

WORKTREE EXCLUSIV: E:\CEO\wt\swos-native-kernel-seed-m1
BASE: f0b244a
Do not touch E:\nexus main or other worktrees.

Read:
- E:\CEO\specs\mission-swypikos-ilaria.md
- E:\CEO\projects\swos\analysis\07-owner-correction-os-compute.md
- E:\CEO\projects\swos\analysis\08-universal-native-ai-install.md
- E:\CEO\projects\swos\analysis\00-master-plan.md
- E:\CEO\wt\swos-native-kernel-seed-m1\AGENTS.md

OWNER GOAL:
Start a genuinely Swypik-owned OS substrate, portable by construction, not a Linux distribution. This is a kernel/platform SEED, not a claim of Windows/macOS parity.

Current workstation facts:
- Rust/Zig/Clang are not installed.
- GCC and NASM from WinLibs/MinGW are installed.
- QEMU executables are currently missing.
Do not install toolchains or modify global machine state in this task.

IMPLEMENT a concrete seed under a NEW top-level or swypik-os-owned kernel directory chosen carefully (e.g. swypik-kernel/ if repo rules allow), without altering the Linux reference prototype.

Required:
1. Architecture-neutral kernel/platform contracts for x86_64, arm64, riscv64:
   BootInfo, PhysicalMemoryMap, Cpu/ArchInfo, InterruptSource, TimerSource, PageAllocator interface, AddressSpace/MMU interface, ThreadContext abstraction, IPC endpoint, Capability handle/object, DeviceNode/DeviceGraph.
2. Small trusted core design:
   no model/Ilaria in privileged kernel;
   generated/adaptive drivers default to isolated user-mode domains;
   capability-based MMIO/IRQ/DMA/device-config grants.
3. x86_64 UEFI seed artifact using ONLY available local toolchain if feasible:
   - build to a PE32+ EFI application/loader or equivalent;
   - display a deterministic Swypik boot banner/status through UEFI;
   - capture firmware memory map into BootInfo;
   - no disk writes;
   - do not pretend it is a complete kernel.
   If MinGW/PE cannot produce a correct UEFI artifact safely, stop at a reproducible buildable freestanding library + exact toolchain blocker; do not fake success.
4. Portable arch directory layout and compile-time checks for arm64/riscv64 contracts even if those artifacts cannot be built on this host.
5. Machine-independent capability model and typed DeviceGraph wire format matching the universal-install spec.
6. Design doc: KERNEL_SEED.md + DRIVER_DOMAIN.md + ADR-OS-BASE-001 candidate notes.
7. Build scripts must be non-destructive and write only under out/.
8. Tests for architecture-neutral core on host. If EFI builds, inspect PE headers/subsystem with objdump and hash artifact.
9. Benchmark harness skeleton so Linux reference and Swypik seed can later compare boot/IPC/memory/fault metrics using the same schema.

Do NOT:
- copy Linux kernel/driver code;
- call this a production kernel;
- implement safety-critical automotive control;
- add Electron/browser dependencies;
- install global packages/toolchains;
- commit/push/deploy.

Gemini: if Antigravity/Gemini 3.8 Flash is exposed, use up to 5 read-only subagents for UEFI/ABI review, microkernel/capability-model critique, portability and licensing review. Only you edit source.

Final report:
- exact files;
- what actually builds;
- exact toolchain commands/results;
- what is architecture-neutral;
- blockers for QEMU/ARM64/RISC-V;
- next smallest kernel milestone.