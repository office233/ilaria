# Swypik-owned native kernel seed

This directory is the M1 first-party kernel/platform **seed** requested for ADR-OS-BASE-001. It is deliberately separate from `swypik-os/system/rootfs` and the Linux reference candidate.
It is not a production kernel and does not claim Windows/macOS/Linux hardware parity.

The seed is C11/freestanding-first because the current workstation has MinGW GCC, NASM and objdump but no Rust, Zig, Clang or QEMU. No external kernel or driver source is copied here.

Run from this directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

The script writes only to `out/`. See `KERNEL_SEED.md`, `DRIVER_DOMAIN.md`, and `ADR-OS-BASE-001.md` for scope and architecture.
