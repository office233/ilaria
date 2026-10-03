# SWOS-000 / OS-kernel-driver audit — current state, gaps and realistic path

> **OWNER CORRECTION — 2026-09-28:** constatările de current-state din acest audit rămân utile, dar recomandarea strategică de a fixa Linux ca product kernel este **superseded**. Linux rămâne reference/prototype/compatibility candidate. Kernelul/platforma de producție SwypikOS se decid numai prin ADR-OS-BASE-001 + prototipuri + benchmark + owner approval. Nu integra schimbări care presupun că „Linux = final SwypikOS” doar pe baza acestui audit.

**Role:** OS/kernel/driver architect auditor  
**Checkout inspected:** `E:\nexus\swypik-os`  
**Repository / HEAD observed:** `E:\nexus`, `main @ 96290fa`  
**Date:** 2026-09-28  
**Mode:** source audit only. No code changes, no deploy, no disk operations, no QEMU/build/test execution in this task. The only write made by this audit is this report.  
**Strategic inputs read:** `E:\CEO\specs\mission-swypikos-ilaria.md`, `E:\CEO\projects\swos\m0\A-swypikos-audit.md`.

---

# 0. Executive answer to the owner

There are **three different things in the repository and they must not be conflated**:

1. **The product that runs today on Windows is a native Windows application, not an operating system.**
   - Entry point: `cmd/swypik-os/main_windows.go`.
   - It is explicitly build-tagged for Windows and calls Win32 through `user32.dll`, `gdi32.dll`, `kernel32.dll` and `shell32.dll` in `ui/engine/native_runtime_windows.go`.
   - It uses the **Windows kernel, Windows TCP/IP stack, Windows filesystem, Windows device model and already-installed vendor drivers**.
   - It is genuinely native and does not use Electron/WebView/Chromium, but that does **not** make it an OS.
   - The current Windows entrypoint imports `core/agent`, `core/coder`, `core/compute`, `core/ilaria`, `core/search`, `core/service`, `ui/desktop`, `ui/engine`; it does **not** import `core/hal`, `core/audio` or `core/bridge`.
   - The "Windows installer" only creates `Start-SwypikOS.bat`; it does not install an OS.

2. **There is a real bootable Linux prototype, but it is a pre-alpha RAM-only live image intended primarily for QEMU/diagnostics.**
   - Build: `scripts/build-os.sh`.
   - Boot chain: **BIOS/UEFI -> GRUB -> stock distribution Linux kernel -> initramfs -> BusyBox init -> swypikd + swypik-session**.
   - The script copies an already-installed host kernel `/boot/vmlinuz-$KVER`; SwypikOS does not contain its own kernel source or custom kernel tree.
   - It requests nine top-level Linux module targets: `virtio_pci virtio_net virtio_blk bochs evdev atkbd usbhid e1000 e1000e`, plus whatever module dependencies `modprobe --show-depends` resolves. Additional drivers may exist only if compiled into the selected stock kernel.
   - It has no `/lib/firmware`, no udev coldplug/modalias pipeline, no persistent root/user filesystem and no production device manager.
   - `/home`, `/var`, `/run`, `/tmp` are tmpfs; the boot script explicitly says no disks are mounted or formatted.
   - The UI writes pixels directly to `/dev/fb0` and reads raw `/dev/input/event*`; only `EV_KEY` keyboard events are interpreted.
   - Networking is real Linux networking for supported NICs: kernel driver -> link up -> BusyBox `udhcpc` -> IPv4 address/default route/`resolv.conf` -> Go TCP/IP clients.
   - It is **not** a production compositor, installer, updateable system, or general-purpose laptop OS.

3. **What is missing for a real OS comparable conceptually with Windows/macOS is mostly the platform layer between the kernel and Swypik's own shell/orchestrator.**
   - Broad hardware support and firmware.
   - udev/device discovery/hotplug.
   - Persistent encrypted storage and installer.
   - DRM/KMS + Mesa + Wayland compositor.
   - libinput/xkb/IME.
   - ALSA/PipeWire/WirePlumber.
   - NetworkManager + iwd/WPA3 + IPv6 + VPN.
   - BlueZ.
   - libcamera/V4L2 + privacy portals.
   - power/logind/UPower/thermal/suspend/hibernate.
   - USB mass storage/Thunderbolt/automount.
   - real user/session/login model.
   - secure boot/measured boot.
   - signed image updates, A/B rollback and recovery.
   - app sandbox/package model.
   - a hardware qualification program.

**Recommended product strategy:** keep **Linux as the kernel and hardware-driver substrate**, and make **SwypikOS own the userland, shell, security/capability broker, orchestration runtime, AI integration, search, settings and update policy**. Writing a new general-purpose kernel is not the rational M1-M4 path.

---

# 1. Source-of-truth observations

## 1.1 Windows path is an application hosted by Windows

`cmd/swypik-os/main_windows.go:1-4`:

- `//go:build windows`
- source comment explicitly calls it a native Windows desktop application.

The entrypoint imports only:

- `core/agent`
- `core/coder`
- `core/compute`
- `core/ilaria`
- `core/search`
- `core/service`
- `ui/desktop`
- `ui/engine`

(`cmd/swypik-os/main_windows.go:25-34`).

`ui/engine/native_runtime_windows.go:11-72` binds directly to Win32 DLLs and APIs including:

- `CreateWindowExW`
- `GetMessageW`
- `DrawTextW`
- GDI device contexts/bitmaps/fonts
- `ShellExecuteW`

Therefore:

**Hardware ownership on this path is Windows.** SwypikOS is a user process. A NIC, GPU, NVMe controller, USB device, audio codec, camera or Bluetooth controller works only because Windows already has a working kernel driver and service stack for it.

The current Windows "installer" confirms the same boundary:

- `installer/windows/installer_windows.go:58-75` creates `Start-SwypikOS.bat`.
- It requires an already-built `bin/swypik-os.exe`.
- It does not touch partitions, boot configuration, drivers or Windows services.

## 1.2 Linux path is truly bootable, but deliberately minimal

`scripts/build-os.sh`:

- requires an explicit already-installed Linux kernel version;
- copies `/boot/vmlinuz-$KVER`;
- builds `swypikd` and `swypik-session` for `linux/amd64`;
- packages selected Linux modules and dependencies;
- builds a GRUB rescue ISO;
- prints: `not an installer or a production release`.

`system/rootfs/init:4-12` mounts only:

- proc
- sysfs
- devtmpfs
- devpts
- tmpfs for `/run`, `/tmp`, `/home`, `/var`.

`system/rootfs/etc/init.d/rcS:6-20`:

- loads a fixed module list;
- changes ownership of framebuffer/TTY/input devices to uid 1000;
- raises every discovered network interface;
- launches `udhcpc`.

`system/rootfs/etc/inittab:1-5` respawns:

- `swypikd` as user `swypik`;
- `swypik-session` as user `swypik`.

This is a real Linux userspace image, not a fake browser shell, but its current scope is **diagnostic live environment**, not a desktop OS distribution.

## 1.3 Current native smoke test proves a narrow VM contract

`scripts/smoke-os.py` boots a diskless QEMU q35 guest with:

- standard VGA;
- VirtIO network;
- optional OVMF UEFI;
- no persistent disk.

It waits for:

- `SWYPIK_DAEMON_READY uid=1000`
- `SWYPIK_NATIVE_READY uid=1000`
- `SWYPIK_NET_READY`

and captures framebuffer pixels.

`.github/workflows/verify.yml` is configured to:

- run Go race tests and vet;
- build the RAM-only ISO on Ubuntu 24.04;
- boot BIOS and UEFI smoke variants.

This task did **not** rerun those jobs because the owner requested strict read-only operation except for this report. The existing M0 audit records a green Go test/vet baseline at the same observed HEAD, but that is not equivalent to physical hardware validation.

---

# 2. Driver taxonomy: what is a driver and what is not

For this audit:

- **Kernel driver** = code running in kernel context or a loadable kernel module that binds to hardware, handles device lifecycle/interrupts/DMA/MMIO, and participates in the kernel device model.
- **User-space adapter** = code that talks through an OS API, device node, vendor DLL/library, command-line management tool or IPC service.
- **Inventory** = read-only enumeration/status collection.
- **Simulation/candidate** = no verified hardware transport.

This distinction matters because several packages use the word "driver" but are not kernel drivers.

## 2.1 `core/hal`

`core/hal/hal.go:83` explicitly says:

> Manager is a legacy inventory, not the native OS kernel driver loader.

Actual behavior:

- host/CPU inventory from Go runtime;
- Linux UART discovery by checking a few character-device paths;
- Linux CAN discovery by checking `/sys/class/net/{can0,vcan0,slcan0}`;
- NVIDIA inventory through `nvidia-smi`;
- simulations exist in `core/hal/simulation.go`.

The Windows `CUDADriver` is also **not** a kernel driver. It loads:

- `nvcuda.dll`
- `nvml.dll`

and calls vendor APIs. Those DLLs only work because the NVIDIA Windows kernel driver is already installed.

The non-Windows implementation says Linux GPU telemetry is not implemented and its tensor function is explicitly a CPU reference calculation.

## 2.2 `core/autogenesis` and installer driver synthesis

This is **candidate source generation only**.

Source comments and metrics say:

- state remains `DRAFT`;
- `compiled=false`;
- `loaded=false`;
- `hardware_probe=not_performed`;
- generated source is marked `UNVERIFIED DRIVER CANDIDATE`;
- it has no hardware transport.

So "autogenerated drivers" must not be counted as driver support.

## 2.3 `core/network`

`core/network/status.go` calls Go `net.Interfaces()` and records addresses.

Important fields:

- `DriverOwner = host_operating_system` on non-Linux;
- `DriverOwner = linux_kernel` on Linux;
- `Internet = not_tested`.

It is inventory only. An UP adapter does not prove DNS/TLS/Internet.

## 2.4 `core/compute`

`core/compute/compute.go`:

- executes `nvidia-smi`;
- parses GPU name, VRAM, driver version and utilization;
- does not schedule jobs;
- explicitly states that coordinator work is not implemented.

Inventory, not driver.

## 2.5 `core/audio`

`core/audio/audio.go` implements:

- float32 ring buffers;
- VAD energy calculation;
- synthesized tone generation.

It does **not** open ALSA, PipeWire, WASAPI, `/dev/snd`, a USB audio device, or a codec.

Despite comments containing "DMA" and "direct-to-speaker/mic", the current implementation is an **in-memory audio buffer/algorithm prototype**, not a hardware audio driver.

## 2.6 `core/bridge`

`core/bridge/device.go`:

- shells out to `adb devices`;
- labels ADB devices as USB-connected phones;
- if no phone is detected, creates a synthetic `P2P-WIFI` fallback entry;
- the "DeployToMobile" method only returns success text; it does not perform an OS deployment.

`clipboard_windows.go` uses Windows clipboard APIs.

This is a user-space bridge/prototype, not USB/Wi-Fi/Bluetooth driver infrastructure.

---

# 3. Driver audit by subsystem

| Subsystem | What exists today | Kernel vs user-space | Current verdict | Required production substrate |
|---|---|---|---|---|
| **Storage** | `virtio_blk` is a requested module target; rootfs mounts only pseudo/tmp filesystems; no disk is mounted/formatted | Linux stock kernel driver + no storage userland | **VM-only prototype** | full kernel module set for NVMe/AHCI/SATA/USB storage, udev, udisks2; GPT/ESP; ext4/btrfs; LUKS2; fsck/recovery; installer |
| **Ethernet NIC** | `virtio_net`, `e1000`, `e1000e`; BusyBox `udhcpc` | real Linux kernel drivers + minimal userland DHCP | **Partial** | distro NIC modules/firmware, NetworkManager, IPv4/IPv6/SLAAC, system DNS, captive/VPN policy |
| **Wi-Fi** | no intentional Wi-Fi module/firmware packaging; no supplicant/iwd/NM | none in Swypik image | **Missing** | cfg80211/mac80211 stack, Intel/MediaTek/Realtek/Qualcomm drivers + `linux-firmware`, wireless-regdb, NetworkManager+iwd, WPA2/WPA3, captive portal |
| **Bluetooth** | no BlueZ, no BT firmware/userland | none | **Missing** | `btusb` family + firmware, BlueZ, PipeWire BT profiles, pairing/settings/security policy |
| **GPU / display** | `bochs` requested for VM; UI writes `/dev/fb0`; Windows app uses Win32/GDI; Linux CUDA telemetry unavailable | Linux fbdev/VM driver; Windows vendor user-space wrapper | **Prototype** | DRM/KMS drivers (i915/xe/amdgpu/nouveau/NVIDIA), firmware, Mesa/Vulkan, Wayland compositor, hotplug/HiDPI/multi-monitor |
| **USB / HID** | `usbhid`, `evdev`, `atkbd`; session reads raw event nodes | real Linux HID/input drivers + raw user-space reader | **Partial** | udev, libinput, pointer/touchpad/touch/pen; usb-storage/uas; USB-C/Thunderbolt policy; hotplug/permissions |
| **Audio** | no sound module packaging; `core/audio` is only memory buffers | no hardware audio path | **Missing** | ALSA drivers incl. HDA/SOF/USB audio, firmware/UCM, PipeWire, WirePlumber, volume/device policy |
| **Camera** | no V4L2/libcamera path; camera simulation explicitly fails when no camera bound | none | **Missing** | `uvcvideo`, V4L2/libcamera, PipeWire camera, privacy portal/permissions |
| **Power / ACPI** | kernel may contain built-in ACPI support, but Swypik userspace has only poweroff on Ctrl-Alt-Del | no production power service | **Missing at OS level** | systemd-logind, UPower, power-profiles-daemon/tuned, thermald, lid/power key, suspend/resume/hibernate |
| **PCIe** | `virtio_pci` explicitly packaged; HAL merely labels NVIDIA inventory as PCIe | kernel VM transport + user-space inventory | **Partial / VM-focused** | full distro PCI device support, udev/modalias probing, hotplug where applicable, IOMMU/security policy |
| **Filesystems** | proc/sysfs/devtmpfs/devpts/tmpfs only in explicit boot path | kernel VFS, but no persistent data plane | **Missing for installed OS** | ext4 or btrfs root/data, LUKS2, snapshots, NTFS3 interoperability, quotas, recovery |
| **Input** | raw `EV_KEY` only, hard-coded US scancode map | evdev kernel + custom raw reader | **Prototype** | libinput, xkbcommon, Romanian layout, mouse/touchpad/gesture/touch/pen, IME, seat ownership |
| **Secure Boot** | GRUB ISO can boot BIOS/UEFI; no signing chain | firmware/bootloader only | **Missing** | signed UKI, shim/MOK or owned trust chain, kernel lockdown/module signing, TPM measured boot |
| **Update / rollback** | rebuild ISO manually | none | **Missing** | signed image updates, A/B or OSTree/bootc, boot counting, automatic rollback, recovery image, fwupd |

### Important nuance

The build script copies dependencies of the selected top-level module targets, and the stock distribution kernel may contain other drivers built in. Therefore the accurate statement is **not** "the kernel can only contain nine drivers"; it is:

> SwypikOS intentionally stages only nine top-level driver targets plus their resolved module dependencies, has no general module/firmware population strategy and no udev modalias device-management pipeline. Hardware support outside that narrow path is accidental/built-in, not an OS contract.

---

# 4. Connectivity: how SwypikOS reaches the Internet today

## 4.1 Windows application path

Path:

```text
NIC / Wi-Fi hardware
  -> Windows vendor/kernel driver
  -> Windows NDIS + TCP/IP + DHCP/DNS/WLAN services
  -> Go net / net/http in swypik-os.exe
  -> search crawler and/or Ilaria HTTP(S)
```

SwypikOS itself does not:

- associate to an SSID;
- authenticate WPA2/WPA3;
- run DHCP;
- configure DNS;
- manage routes;
- load NIC firmware;
- provide a VPN stack.

`core/ilaria/backend.go:41-52` allows:

- loopback HTTP to `127.0.0.1`; or
- authenticated HTTPS with a token.

`core/search/crawl.go:114-153` resolves DNS and opens TCP using Go's standard networking stack with SSRF protections.

So Internet on the Windows product is **Windows Internet connectivity consumed by a normal native application**.

## 4.2 Linux live prototype path

Path:

```text
supported NIC
  -> Linux kernel driver
  -> Linux network stack
  -> rcS: ip link set <iface> up
  -> BusyBox udhcpc
  -> IPv4 + default route + /etc/resolv.conf
  -> Go net / net/http
  -> search crawler and optional Ilaria endpoint
```

`system/rootfs/etc/udhcpc.script`:

- applies the leased IP/netmask;
- installs the first default gateway;
- rewrites `/etc/resolv.conf` from DHCP DNS servers.

This is a real TCP/IP path, but it currently assumes the kernel can already drive the interface.

### Current connectivity limitations

- no Wi-Fi association/authentication;
- no WPA3;
- no captive portal;
- no IPv6 configuration policy;
- no VPN;
- no firewall policy;
- no NetworkManager/iwd;
- no robust link failover;
- no per-task network namespace/policy;
- `core/network` does not test actual Internet connectivity;
- live image has no bundled Ilaria model/server, so the default loopback `127.0.0.1:8091` AI path is not self-contained.

An autonomous OS needs connectivity split into distinct services:

1. **kernel device support** — NIC/WLAN/BT drivers + firmware;
2. **link management** — Ethernet/WLAN association, regulatory domain, roaming;
3. **IP management** — DHCPv4/v6, SLAAC, routes;
4. **resolver** — validated DNS policy;
5. **security** — firewall, VPN, per-app/per-task network capabilities;
6. **observability** — distinguish link, IP, DNS, TLS and Internet reachability;
7. **offline degradation** — shell/files/search/system management must work without inference/cloud.

---

# 5. What is missing before the Linux track can be called a real desktop OS

A Windows/macOS-class conceptual OS does not require rewriting every kernel driver, but it does require owning and validating the complete experience above the kernel.

## P0 platform gaps

1. **Device manager**
   - systemd/udev or equivalent;
   - modalias coldplug/hotplug;
   - firmware loading;
   - stable device identities and permissions.

2. **Persistent storage**
   - GPT/ESP layout;
   - root/data filesystems;
   - encrypted user state;
   - explicit install/recovery flows;
   - safe interaction with existing Windows partitions.

3. **Display compositor**
   - DRM/KMS;
   - Wayland;
   - multi-monitor/hotplug;
   - HiDPI/fractional scaling;
   - software-render fallback.

4. **Input/seat/session**
   - libinput;
   - xkbcommon;
   - real Romanian layout;
   - pointer/touchpad/touch/pen;
   - login/session ownership.

5. **Networking**
   - NetworkManager + iwd;
   - firmware;
   - IPv6;
   - WPA3;
   - captive portal;
   - VPN/firewall.

6. **Audio/camera/Bluetooth**
   - ALSA/SOF/UCM;
   - PipeWire/WirePlumber;
   - BlueZ;
   - V4L2/libcamera;
   - user consent portals.

7. **Power and laptop lifecycle**
   - suspend/resume;
   - lid/power button;
   - battery;
   - thermal management;
   - hibernate policy.

8. **Boot/update/recovery**
   - signed boot chain;
   - image signing;
   - A/B update;
   - boot counting;
   - rollback;
   - rescue environment.

9. **Security model**
   - distinct service identities;
   - polkit/capability broker;
   - namespaces/seccomp/cgroups for workers;
   - MAC policy (AppArmor/SELinux);
   - app portals;
   - secrets broker;
   - module/artifact trust.

10. **Hardware qualification**
    - defined supported devices;
    - firmware inventory;
    - suspend/resume and hotplug testing;
    - update/rollback on actual machines.

---

# 6. Strategic choice: own kernel vs Linux kernel + Swypik userland vs another base

## 6.1 Option A — new Swypik kernel from scratch

### What it actually means

Not just scheduler + memory management. To compete as a general desktop OS it requires:

- SMP/NUMA;
- virtual memory;
- VFS;
- block layer;
- filesystems;
- TCP/IP;
- USB;
- PCI/PCIe;
- ACPI;
- power management;
- IOMMU;
- graphics/display;
- input;
- audio;
- Wi-Fi/Bluetooth;
- camera;
- storage/NVMe/AHCI;
- security model;
- process ABI/runtime;
- crash dump/recovery;
- thousands of hardware quirks and firmware combinations;
- a driver development/signing/vendor ecosystem.

### Cost / time / risk

**ROM engineering estimate, not a budget commitment:**

- narrow research kernel on a VM: months;
- useful kernel on one controlled machine: likely 1-2+ years with specialists;
- credible general laptop/desktop driver coverage: **tens to hundreds of engineer-years**;
- parity breadth with Windows/Linux/macOS ecosystems: open-ended multi-year program.

Primary risk is not booting; it is the **driver and hardware ecosystem**.

### Verdict

**Do not put this on the M1-M4 product critical path.**

A custom kernel can exist later as a research track for specific appliances, verified kernels, hypervisors or safety domains, but it should not block SwypikOS desktop delivery.

---

## 6.2 Option B — Linux kernel + Swypik-owned immutable userland

### Model

```text
UEFI
 -> signed UKI / boot manager
 -> upstream LTS Linux kernel + distro-tested modules + linux-firmware
 -> systemd/udev/logind
 -> NetworkManager/iwd, BlueZ, PipeWire, UPower, udisks2, fwupd
 -> Wayland compositor
 -> Swypik shell + settings + search + capability broker
 -> swypikd / orchestrator / Ilaria / Swyp Lang runtime
 -> sandboxed apps/tools/workers
```

Swypik owns:

- desktop shell and UX;
- orchestration/control plane;
- AI-native capability model;
- search;
- settings/policy UI;
- capability broker;
- sandbox integration;
- update channel/policy;
- image composition;
- signed artifacts;
- supported hardware matrix.

Linux owns:

- hardware abstraction and the vast majority of kernel drivers.

### Cost / risk

**ROM estimate:**

- substantially lower than own-kernel;
- a focused team can get a supported-hardware developer preview in quarters rather than years;
- broad consumer hardware quality still requires a dedicated qualification/driver/firmware team.

Risk is **medium and manageable** because driver coverage is inherited from upstream Linux, Mesa and vendor stacks.

### Verdict

**Historical recommendation — superseded by owner correction on 2026-09-28.**

Linux remains a technically viable reference/product candidate, but it is no
longer the selected architecture. The final kernel/platform choice must pass
ADR-OS-BASE-001 against a Swypik-owned kernel/platform prototype and a hybrid
compatibility design.

---

## 6.3 Option C — ship a conventional distro with a Swypik theme/session

This is the fastest bootstrap but should not be the end state.

Pros:

- quickest access to packaging, drivers and desktop plumbing;
- low initial bring-up cost.

Cons:

- mutable distro semantics can leak into the product;
- update/recovery contract is less controlled;
- difficult to guarantee deterministic, signed base state;
- risks becoming "an app/session on Ubuntu/Fedora" rather than a coherent OS product.

### Verdict

Use a mainstream distribution **as a package/kernel source and bring-up environment**, but build a **Swypik-owned immutable image** with pinned packages, SBOM, signing and rollback.

---

## 6.4 Linux reference candidate (not final product base)

### Kernel

- upstream Linux LTS, initially x86-64;
- distro-maintained config/modules;
- full `linux-firmware`;
- no custom kernel fork unless a measured requirement cannot be upstreamed/configured.

### Image builder

Recommended first choice: **mkosi + Debian stable/minimal + selected backports where hardware support requires it**.

Why:

- reproducible declarative image composition;
- integrates naturally with systemd, UKIs, repart and image workflows;
- avoids carrying a bespoke initramfs assembler as the production OS builder.

If latest laptop hardware support becomes more important than Debian stability, evaluate a Fedora/bootc package base, but keep the same Swypik image contract.

### Init/device stack

- systemd;
- udev;
- logind;
- tmpfiles/sysusers;
- journald with bounded persistent policy.

### Storage

- GPT;
- ESP;
- root A/root B or equivalent immutable image slots;
- LUKS2 encrypted persistent state;
- btrfs for user/state snapshots if operational testing validates it; ext4 is acceptable if simpler reliability wins.

### Boot/security

- signed Unified Kernel Images;
- systemd-boot or shim-managed chain where hardware/Windows coexistence requires it;
- TPM2 measured boot;
- module signature policy;
- recovery UKI.

### Updates

Preferred first implementation:

- systemd-sysupdate/repart-compatible A/B images;
- signed update manifests;
- boot counting;
- automatic rollback;
- fwupd for firmware.

OSTree/bootc remains a valid ADR alternative if it materially simplifies fleet update/rollback.

### Desktop

- Wayland;
- initial compositor based on a mature wlroots/Smithay path;
- Swypik shell as first-party surface;
- do **not** write a compositor from scratch before hardware/device plumbing is stable.

### Apps

- signed first-party Swypik system services;
- Flatpak + xdg-desktop-portal for third-party desktop apps;
- Swypik approval UI can become the policy frontend for camera/mic/screen/file/device portals.

---

# 7. M1 / M2 / M4 OS-driver roadmap

These are **OS-track deliverables aligned to the mission milestones**. They do not replace the mission's orchestration, Swyp Lang or Ilaria deliverables.

## M1 — Autonomous Kernel: provide a real security-capable OS substrate

Goal: the orchestrator must stop depending on "user process with full host authority".

### M1 OS/driver deliverables

1. ADR: compare Swypik-owned kernel/platform, hybrid compatibility, and this Linux reference path; no product path is assumed before owner approval.
2. Replace production BusyBox/fixed-module boot path with:
   - systemd;
   - udev;
   - full curated kernel module tree;
   - linux-firmware.
3. Create declarative image builder under a new production path; keep current RAM ISO only as diagnostic image.
4. Introduce persistent disposable-QEMU installation:
   - GPT/ESP;
   - encrypted state;
   - deterministic boot.
5. Create distinct identities:
   - shell user;
   - `swypikd` system service;
   - sandbox worker identities.
6. Wire Linux sandbox primitives required by mission M1:
   - user/mount/pid/net namespaces;
   - seccomp;
   - cgroups v2;
   - brokered filesystem/device/network capabilities.
7. Networking foundation:
   - NetworkManager;
   - iwd;
   - system resolver;
   - Ethernet + Wi-Fi on one supported reference laptop.
8. Start DRM/KMS + Wayland bring-up on Intel reference hardware.
9. Add hardware-report collector and immutable evidence bundle.

### M1 exit gate

A signed development image boots on QEMU and one declared physical reference machine, persists state across reboot, has wired/Wi-Fi connectivity, and runs `swypikd` in a real least-privilege sandbox. No model is required for boot/network/files/settings.

---

## M2 — Swyp Lang Seed: make device authority typed and brokered

Goal: Swyp Lang/IR receives **capabilities**, not raw hardware authority.

### M2 OS/driver deliverables

1. Define a stable device/tool capability ABI:
   - `display.read`
   - `input.observe`
   - `network.connect`
   - `camera.capture`
   - `audio.capture`
   - `usb.mount`
   - etc.
2. Map capabilities to D-Bus/portal/broker operations, never raw MMIO from model code.
3. Wayland desktop baseline:
   - compositor;
   - libinput;
   - xkbcommon;
   - Romanian keyboard;
   - pointer/touchpad.
4. Audio:
   - ALSA/SOF;
   - PipeWire/WirePlumber.
5. Bluetooth:
   - BlueZ + headset/keyboard pairing.
6. Camera:
   - V4L2/libcamera + permission portal.
7. Power:
   - logind/UPower;
   - suspend/resume on reference laptops.
8. Storage:
   - safe installer flow;
   - LUKS2;
   - rollback snapshot policy.
9. Package/app isolation:
   - Flatpak/portals or equivalent.

### M2 exit gate

Swyp Lang can request typed device operations through the broker; direct unscoped device access from an agent worker is denied. Reference Intel/AMD laptops pass display, input, Wi-Fi, audio, camera and suspend/resume tests.

---

## M4 — SwypikOS Integration: productionize hardware + update + agent/device orchestration

Goal: integrate orchestrator, Ilaria, Swyp Lang and real device surfaces under one signed platform contract.

### M4 OS/driver deliverables

1. signed/versioned device/plugin manifests;
2. independent verifier for privileged device actions;
3. secure boot + measured boot + module trust;
4. signed A/B self-update with canary/rollback;
5. recovery image and offline repair;
6. broader GPU support:
   - Intel;
   - AMD;
   - NVIDIA signed optional stack;
7. broader Wi-Fi/BT chipset matrix;
8. USB-C/Thunderbolt/external storage;
9. printer/scanner/firmware update integration;
10. ARM64 feasibility/bring-up if still a product requirement;
11. hardware telemetry and driver health into orchestration;
12. fault injection across boot, storage, network, power, driver/service crash and update paths.

### M4 exit gate

No feature is called "supported" without a passing hardware row, reproducible evidence bundle, signed build identity and rollback/recovery proof.

---

# 8. Hardware bring-up matrix

The matrix should be versioned in-repo and every release should carry exact machine identifiers, firmware revisions, kernel, driver and firmware package versions.

| Tier | Reference target | Current state | M1 target | M2 target | M4 target |
|---|---|---|---|---|---|
| **T0 VM** | QEMU q35 + OVMF + VirtIO net/block + virtio-gpu | current smoke harness covers BIOS/UEFI, VirtIO DHCP, std VGA framebuffer; not rerun in this audit | persistent qcow2 install, udev, systemd, Wayland, encrypted state | Secure Boot+swtpm, A/B update/rollback, fault injection | required on every commit/release |
| **T1 Intel laptop** | 12th/13th gen or Core Ultra, Intel iGPU, Intel AX2xx WLAN/BT, NVMe, SOF audio, UVC camera | unsupported as a declared contract | boot, NVMe, i915/xe, wired/Wi-Fi, basic input | audio, BT, camera, touchpad, suspend/resume, battery | external displays, firmware update, long-cycle reliability |
| **T2 AMD laptop** | Ryzen 7040/8040-class, amdgpu, NVMe, mt792x/rtw89-class WLAN | unsupported | boot/storage/network/display bring-up | audio/BT/camera/power/input | full regression and update qualification |
| **T3 NVIDIA desktop** | x86-64 host + Turing/Ampere/Ada GPU | Windows app can inventory NVIDIA through host stack; Linux image has no NVIDIA stack | software/IGPU fallback must boot | signed optional NVIDIA stack + Wayland | CUDA/compute qualification + update rollback of driver extension |
| **T4 Peripheral lab** | USB keyboard/mouse, USB SSD, USB audio, webcam, BT headset/keyboard, USB-C dock | only keyboard-class HID is in current minimal path | HID + storage hotplug | audio/camera/BT/dock | repeated hotplug, suspend/resume, failure injection |
| **T5 Legacy/variance** | Realtek Ethernet/WLAN, different NVMe controllers, common laptop vendors | unqualified | inventory only | selected high-volume devices | expand based on telemetry/support demand |
| **T6 ARM64** | one explicit development board/laptop | no Linux session build; current session is amd64-only | out of scope unless strategic requirement confirmed | architecture ADR + CI cross-build | real hardware bring-up if approved |

## Per-machine evidence to collect

- SMBIOS/DMI product/version;
- BIOS/UEFI version;
- `lspci -nnk`;
- `lsusb`;
- kernel config/version;
- loaded modules;
- firmware load failures from kernel log;
- DRM connectors/modes;
- network chipset + firmware;
- audio codec/SOF state;
- camera node/libcamera enumeration;
- battery/power supply;
- suspend/resume log;
- Secure Boot/TPM state;
- update slot/version.

No serial numbers or other device-identifying secrets should enter public artifacts.

---

# 9. Acceptance tests

## 9.1 Build and provenance

**AT-BUILD-01** — clean builder produces image from pinned inputs; manifest includes kernel, packages, firmware and source revision.

**AT-BUILD-02** — SBOM and license/corresponding-source bundle is emitted for distributable builds.

**AT-BUILD-03** — build refuses unpinned/unknown signing material and reports dirty source state.

**AT-BUILD-04** — image boots with no network and no Ilaria service; basic OS functions remain available.

## 9.2 Boot / firmware / Secure Boot

**AT-BOOT-01** — OVMF UEFI boot on QEMU.

**AT-BOOT-02** — physical UEFI boot on each T1/T2/T3 reference.

**AT-BOOT-03** — Secure Boot enabled: correctly signed UKI boots.

**AT-BOOT-04** — tampered UKI/module is rejected.

**AT-BOOT-05** — TPM measured-boot values are recorded and change on image mutation.

## 9.3 Install / storage / recovery

All destructive tests run only against disposable VM disks or explicitly provisioned lab hardware.

**AT-STOR-01** — installer creates expected GPT/ESP/root/state layout on a blank qcow2.

**AT-STOR-02** — reboot preserves `/var/lib/swypik` and user state.

**AT-STOR-03** — LUKS2 unlock works with configured policy/recovery key.

**AT-STOR-04** — power cut during update does not corrupt the active slot.

**AT-STOR-05** — failed new slot rolls back automatically.

**AT-STOR-06** — recovery image can inspect/repair state without model/network.

**AT-STOR-07** — external USB storage mounts through user policy; raw block access is denied to unprivileged agent workers.

## 9.4 Networking

**AT-NET-01** — Ethernet DHCPv4.

**AT-NET-02** — IPv6 SLAAC/DHCPv6 and DNS.

**AT-NET-03** — WPA2 and WPA3-SAE Wi-Fi association.

**AT-NET-04** — reconnect after AP loss and suspend/resume.

**AT-NET-05** — captive portal state is detected, not misreported as Internet.

**AT-NET-06** — DNS failure, TCP failure and TLS failure are surfaced distinctly.

**AT-NET-07** — per-task network namespace/capability denies destinations outside policy.

**AT-NET-08** — OS remains operable when all network is removed.

## 9.5 Graphics / display

**AT-GFX-01** — compositor starts on Intel DRM/KMS.

**AT-GFX-02** — compositor starts on AMD DRM/KMS.

**AT-GFX-03** — NVIDIA path either starts successfully or falls back without blocking boot.

**AT-GFX-04** — hotplug external monitor, mode change and primary-display change.

**AT-GFX-05** — HiDPI/fractional scaling does not lose input alignment.

**AT-GFX-06** — compositor crash restarts/recovery path without destroying user state.

## 9.6 Input

**AT-IN-01** — keyboard, mouse and touchpad.

**AT-IN-02** — Romanian standard layout emits `ă â î ș ț` correctly.

**AT-IN-03** — AltGr/dead keys/repeat behavior.

**AT-IN-04** — approval/consent cannot be triggered by stale key-repeat events.

**AT-IN-05** — device hotplug ownership follows the active seat.

## 9.7 Audio / Bluetooth / camera

**AT-AUD-01** — PipeWire playback on internal HDA/SOF.

**AT-AUD-02** — microphone capture through portal approval.

**AT-AUD-03** — USB audio hotplug.

**AT-BT-01** — pair/unpair Bluetooth keyboard.

**AT-BT-02** — A2DP playback + HFP/HSP microphone path where hardware supports it.

**AT-CAM-01** — UVC camera enumeration and live frame acquisition.

**AT-CAM-02** — camera/mic denied without capability/portal approval.

## 9.8 Power / laptop lifecycle

**AT-PWR-01** — lid close/open suspend/resume.

**AT-PWR-02** — 100 suspend/resume cycles on T1 and T2 reference machines with network/audio restored.

**AT-PWR-03** — battery percentage/charging state and low-power policy.

**AT-PWR-04** — thermal service responds to load without kernel warnings or user-session loss.

**AT-PWR-05** — hibernate only if the encrypted/signed-boot design can support it safely; otherwise feature remains explicitly disabled.

## 9.9 USB / devices

**AT-DEV-01** — repeated keyboard/mouse hotplug.

**AT-DEV-02** — USB SSD attach/mount/unmount/remove.

**AT-DEV-03** — USB-C dock with display + Ethernet + USB hub where supported.

**AT-DEV-04** — malformed/unsupported device never grants direct agent authority.

## 9.10 Security / sandbox

**AT-SEC-01** — `swypikd` does not run as root.

**AT-SEC-02** — shell and daemon use separate identities.

**AT-SEC-03** — agent worker cannot read outside brokered filesystem scope.

**AT-SEC-04** — agent worker cannot open raw block devices, `/dev/mem`, input devices, camera or microphone without capability.

**AT-SEC-05** — seccomp denies forbidden syscalls.

**AT-SEC-06** — cgroup CPU/RAM/IO limits are enforced.

**AT-SEC-07** — untrusted plugin with missing/invalid signature cannot load.

**AT-SEC-08** — capability token is scoped, expiring and non-replayable.

## 9.11 Update / rollback

**AT-UPD-01** — signed update moves inactive slot only.

**AT-UPD-02** — hash/signature mismatch aborts before activation.

**AT-UPD-03** — simulated boot failure triggers automatic previous-slot recovery.

**AT-UPD-04** — user state survives update and rollback.

**AT-UPD-05** — firmware update uses fwupd policy and is independently recoverable.

**AT-UPD-06** — downgrade protection follows explicit release policy.

---

# 10. Immediate engineering actions

## P0 — do before adding more fake "driver" surface

1. **Freeze terminology.**
   - Rename/document `core/hal`, `core/compute`, `core/audio`, `core/bridge` as inventory/adapters/prototypes where applicable.
   - Never call generated Go skeletons "working drivers".

2. **Write ADR-OS-001: Linux kernel is the product hardware substrate.**
   - Own-kernel work becomes a separate research track.

3. **Create a production image path next to, not inside, the current diagnostic ISO path.**
   - Suggested: `system/mkosi/`, `system/units/`, `system/repart.d/`, `system/sysupdate.d/`.

4. **Do not evolve the fixed BusyBox module loop into a large manual driver list.**
   - Replace it with normal Linux device discovery: udev + modalias + firmware.

5. **Create `docs/HARDWARE_MATRIX.md` and a read-only hardware evidence collector.**

6. **Make first physical target explicit.**
   - One Intel reference laptop is enough for M1.
   - Add one AMD laptop at M2.
   - NVIDIA is an optional extension, not the only display path.

7. **Keep hardware control out of LLM code.**
   - Ilaria/Swyp Lang request capabilities through a broker.
   - The broker talks to NetworkManager, PipeWire, BlueZ, udisks2, fwupd, portals and privileged services.

8. **Separate OS health from AI health.**
   - boot/network/storage/settings must pass with Ilaria offline.

9. **Use signed A/B/recovery before real-machine self-update.**
   - No in-place mutation of the only bootable root.

10. **Delete or quarantine misleading legacy prototypes from product graphs.**
    - especially synthetic device success claims and metadata-only installer paths once replacements exist.

---

# 11. Architecture target

```text
+-----------------------------------------------------------------------+
| Swypik shell / Settings / Search / Files / Notifications              |
| Swyp Lang runtime / Ilaria UI / Orchestrator                          |
+-------------------------- capability broker ---------------------------+
| portal APIs | polkit | device services | sandbox worker supervisor     |
+------------------------------------------------------------------------+
| Wayland | PipeWire | NetworkManager+iwd | BlueZ | udisks2 | UPower     |
| libinput | libcamera | fwupd | systemd-logind | systemd-resolved       |
+------------------------------------------------------------------------+
| systemd / udev / cgroups v2 / namespaces / seccomp / MAC policy       |
+------------------------------------------------------------------------+
| Mesa / libdrm | ALSA | storage/filesystems | TCP/IP | USB | PCIe       |
+------------------------------------------------------------------------+
| Upstream Linux LTS kernel + curated modules + linux-firmware           |
+------------------------------------------------------------------------+
| UEFI + signed UKI + TPM2 + A/B image + recovery                        |
+------------------------------------------------------------------------+
| Hardware                                                              |
+------------------------------------------------------------------------+
```

The correct differentiation is above the stable Linux hardware substrate:

- AI-native orchestration;
- capability/security semantics;
- Swyp Lang;
- Ilaria;
- deterministic evidence/recovery;
- own shell/search/settings;
- signed, recoverable OS image.

Reimplementing commodity NIC/NVMe/USB/audio drivers would consume enormous effort without increasing the unique value of SwypikOS.

---

# 12. Final verdict

**Today:**

- `cmd/swypik-os` = **real native Windows application**, dependent on Windows kernel/drivers.
- `scripts/build-os.sh + system/rootfs + cmd/swypikd + cmd/swypik-session` = **real bootable Linux pre-alpha**, RAM-only, VM-oriented, with a very narrow explicitly staged driver set and no production desktop plumbing.
- `core/hal`, `core/network`, `core/compute`, `core/audio`, `core/bridge` = mostly **inventory, user-space wrappers, algorithms or prototypes**, not kernel drivers.
- `installer/universal` = **metadata only**, not OS installation.
- `core/autogenesis` = **unverified driver candidate generation**, never compiled/loaded/probed.
- Secure Boot, persistent encrypted install, update/rollback, broad laptop drivers, Wayland, Wi-Fi, Bluetooth, audio, camera and power management are **not implemented in the current Linux image**.

**Recommended path:**

> Build SwypikOS as a real Linux-based operating-system distribution with an immutable, signed Swypik-owned userland and desktop. Reuse upstream Linux drivers and mature device services. Put Swypik's engineering differentiation into orchestration, security/capabilities, recovery, AI-native UX, Swyp Lang and Ilaria.

That path is technically credible, preserves the owner's requirement that SwypikOS become a real bootable OS rather than a Windows app, and avoids spending M1-M4 rebuilding the global hardware-driver ecosystem from zero.
