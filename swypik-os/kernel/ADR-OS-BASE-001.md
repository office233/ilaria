# ADR-OS-BASE-001 — OS substrate candidate notes

- **Status:** candidate evidence, decision not yet approved
- **Date:** 2026-09-28
- **Scope:** Swypik-owned substrate vs hybrid compatibility architecture vs Linux reference candidate

## Context

SwypikOS is intended to be a first-party OS/platform, not a Linux distribution by default. The repository already contains a useful Linux boot/reference path; it remains a comparison candidate rather than a product-base decision.
This M1 work adds the smallest independent Swypik-owned substrate that can establish ABI/device/capability ownership and produce a real UEFI artifact with the toolchain currently available.

## Candidates to benchmark

1. **Swypik-owned kernel/platform:** first-party scheduler/VM/IPC/capabilities/VFS/device model, beginning with this seed and QEMU/VirtIO bring-up.
2. **Hybrid compatibility:** Swypik-owned authority/kernel path with a Linux/other compatibility or driver domain where evidence shows the engineering/coverage tradeoff is favorable.
3. **Linux reference/product candidate:** the isolated existing Linux prototype, accepted as product base only if the owner-approved benchmark shows it does not block ownership, capability security, performance and differentiation goals.

No candidate is selected by this document.

## Same-workload benchmark contract

The initial shared schema is `bench/benchmark-schema-v1.json`. Both Swypik seed and Linux reference must eventually report measurements from the same QEMU machine model and equivalent workload definitions for:

- cold boot latency;
- IPC round-trip latency;
- memory overhead/idle footprint;
- fault-recovery latency.

The broader decision gate must also cover scheduler throughput, fault isolation, power/thermal behavior, driver coverage, GPU/NPU scheduling, capability enforceability, update/rollback complexity, developer complexity, licensing/distribution obligations and the fraction of the stack that is Swypik-owned.

## Current evidence

The current workstation provides MinGW-w64 GCC, NASM and GNU objdump. It does not provide QEMU, Rust, Zig or Clang. Therefore this candidate can build and structurally inspect an x86_64 PE32+ EFI application, run host architecture-neutral tests and compile-check ARM64/RISC-V contracts, but it cannot honestly produce boot-time QEMU measurements or native ARM64/RISC-V artifacts on this host.

The seed contains no copied Linux kernel/driver source. Repository licensing still applies to new source in this worktree; reuse of third-party kernel or driver code in a future proprietary/dual-licensed substrate requires an explicit license boundary review rather than copy/paste.

## Decision gate

Owner approval remains required after reproducible comparative evidence. The next evidence step is QEMU x86_64 handoff plus minimal interrupt/timer, physical/virtual-memory and IPC/capability benchmarks, followed by the exact same schema against the Linux reference candidate.
