# Swypik-owned native kernel seed

This directory is the M1 first-party kernel/platform **seed** requested for ADR-OS-BASE-001. It is deliberately separate from `swypik-os/system/rootfs` and the Linux reference candidate.
It is not a production kernel and does not claim Windows/macOS/Linux hardware parity.

The seed is C11/freestanding-first. No external kernel or driver source is copied
here. Build entrypoints validate their actual local toolchain rather than relying
on a fixed workstation inventory.

Run from this directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

The original `build.ps1` uses MinGW GCC and objdump. With Zig, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-host.ps1 -Compiler <zig-path>
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-portable.ps1 -Zig <zig-path>
```

`test-host.ps1` runs non-privileged host tests. The same x86_64 tests can run on
Linux with PowerShell and GCC; the assembly retains its explicit Microsoft x64
calling convention while selecting the host's COFF or ELF section metadata.
`build-portable.ps1` cross-builds and checks an x86_64 UEFI PE image, including a
second-build reproducibility comparison. Neither entrypoint boots the image or
installs it on a device.

The script writes only to `out/`. See `KERNEL_SEED.md`, `DRIVER_DOMAIN.md`, and `ADR-OS-BASE-001.md` for scope and architecture.
