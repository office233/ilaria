# Native OS architecture and acceptance gates

## Decision status

The clarified requirement is a bootable **independent SwypikOS**, not an app
hosted by Windows, Chrome or Electron and not automatically a Linux distribution.

The repository currently contains a **Linux-based bootable reference prototype**.
That is a useful bring-up/compatibility test bed, but it is **not a final product
kernel decision**. Production kernel/platform ownership is gated by
`ADR-OS-BASE-001`, comparative prototypes, benchmarks and owner approval.

No document or implementation may silently promote the current Linux prototype
into the final SwypikOS architecture.

Current reference path:

```
BIOS/UEFI -> GRUB -> Linux -> initramfs /init -> BusyBox init
                                       |-> Linux modules + DHCP
                                       |-> swypikd (UID 1000, Unix IPC)
                                       `-> swypik-session (UID 1000, fbdev + evdev)
```

Production candidates must include at minimum:

1. a Swypik-owned kernel/platform prototype;
2. a hybrid compatibility architecture where third-party kernels/drivers are
   isolated compatibility domains rather than implicit OS identity;
3. the current Linux-based approach as a measured reference candidate.

The same workloads must be compared for boot time, memory, IPC, fault isolation,
security/capability enforcement, driver coverage, power behavior and engineering
complexity before the product base is chosen.

The current Linux session is a native diagnostic desktop, not a complete
compositor. Wayland/DRM/KMS/Mesa/libinput remain valid technologies for the Linux
reference path, not mandatory foundations of the final SwypikOS shell.
Do not relabel the framebuffer implementation as a production compositor.

The model is a userspace service with limited tools, **not PID 1 or kernel code**.
Kernel and network operations must remain available when inference is offline.
No language-model output is executed as a shell command or granted root access.

## Hardware and networking — current Linux reference

The ISO packages real Linux modules and their dependencies. VM targets include
VirtIO PCI/network/block, evdev, and available Bochs, PS/2/USB keyboard and Intel
E1000 adapters. Build fails when required VirtIO or evdev drivers are missing.
Drivers on this prototype come from the selected distribution kernel, not from
Swypik-authored drivers. This statement describes current state only.

Networking is adapter -> Linux network driver -> TCP/IP -> IP/default route/DNS
-> TLS/application protocols. BusyBox udhcpc obtains address, route and DNS.
Adapter-up is not proof of Internet access. The Network panel distinguishes
adapter inventory from connectivity verification.

Wi-Fi association, WPA credentials, captive portals, VPNs, Bluetooth, sound,
battery management and broad Intel/AMD/NVIDIA coverage need separate work and
hardware tests. The Linux reference may use NetworkManager/iwd/BlueZ/PipeWire;
the final SwypikOS platform must expose equivalent first-party contracts regardless
of which substrate wins the ADR. QEMU boot is not universal hardware support.

## Security boundaries

Init is privileged to mount pseudo-filesystems, load modules and configure the
network. Both model-facing daemon and UI run as UID 1000. IPC is a 0600 Unix
socket under a 0700 runtime directory. There is no TCP API listener in the native
image. HTTP framing over the private socket is not a browser interface.

Agent runs have duration, step-count, output-budget and tool-registration limits.
Approval binds a run ID, one-time approval ID and immutable arguments. Unknown
actions, malformed JSON, duplicate keys and expired approvals fail closed.
Model observations are untrusted data. Tool cancellation is cooperative: only
application-owned bounded tools are registered in this version.

This is not a complete hostile-code sandbox. UI and daemon share a local identity;
a malicious process with that identity can access the session. Path canonicalization
is not handle-relative protection against concurrent filesystem mutation.
Production needs separate service identities, portal/broker interfaces, namespaces,
seccomp/cgroups, credential storage, application signing and recovery. Never
reintroduce the old web shell API as an unrestricted agent tool.

## Storage and release

The prototype boots into RAM. /home and /var are bounded tmpfs mounts. No block
devices are mounted, formatted or used as persistent state. The index persists
across daemon restarts only. No lossless migration is claimed.

Before installation on physical machines: explicit GPT/EFI disk selection,
encrypted persistent user storage, tested backup/restore, signed A/B updates,
rollback, recovery image, Secure Boot strategy and physical hardware matrix.
The old fake boot installer is disabled intentionally.

The reference build packages GPL kernel/BusyBox/GRUB and other distribution
components. Package versions and copyright notices accompany the image. Obtain
and supply matching corresponding sources and satisfy redistribution obligations
before public distribution. Do not claim authorship of third-party kernel/drivers.
If the final product uses a Swypik-owned kernel, do not transplant GPL kernel
code/drivers into it without an explicit licensing review and compatible design.
No company affiliation is established by this code.

## Verification scope

`go test -race` and `go vet` exercise portable packages and native API code. CMD
lifecycle tests are Windows-only. QEMU smoke tests attempt BIOS and UEFI boot,
assert UID 1000, obtain a virtual NIC DHCP lease and capture actual pixels.
Actual workflow logs determine which attempts passed. These tests contain no
model weights and do not validate real Ilaria inference, physical Wi-Fi or disk installation.

## Primary references

- Linux initramfs: https://docs.kernel.org/filesystems/ramfs-rootfs-initramfs.html
- Linux VirtIO: https://docs.kernel.org/driver-api/virtio/virtio.html
- Linux framebuffer ABI: https://docs.kernel.org/fb/framebuffer.html
- Wayland architecture: https://wayland.freedesktop.org/
- QEMU: https://www.qemu.org/docs/master/system/introduction.html
