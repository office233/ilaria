# SwypikOS vs Windows 11 and macOS: capability parity and roadmap

28 September 2026. Scope: the **Linux track** (`scripts/build-os.sh`, `system/rootfs`,
`cmd/swypikd`, `cmd/swypik-session`). The Windows track (`bin/swypik-os.exe`) is an
application running on Windows and inherits every Windows capability; it is not
compared here except where noted.

Every "today" cell below was checked against the repository at commit `484e0e7`.
"Missing" means no code or packaged component exists in the Linux image.

## 0. What the Linux image actually is today

| Fact | Evidence |
| --- | --- |
| Stock distribution kernel (CI: Ubuntu `linux-image-virtual`), no custom kernel | `scripts/build-os.sh` (`KERNEL_VERSION`, copies `/boot/vmlinuz-$KVER`), `.github/workflows/verify.yml` |
| Only 9 kernel modules packaged: `virtio_pci virtio_net virtio_blk bochs evdev atkbd usbhid e1000 e1000e` | `scripts/build-os.sh` module loop, `system/rootfs/etc/init.d/rcS` |
| No `/lib/firmware`, no udev; modules are loaded from a fixed list, not by modalias | `scripts/build-os.sh`, `rcS` |
| BusyBox init, two respawned processes as UID 1000 (`swypikd`, `swypik-session`) | `system/rootfs/etc/inittab`, `system/rootfs/init` |
| RAM only: `/home`, `/var` are tmpfs; no block device mounted | `system/rootfs/init`, `rcS` ("No disks are mounted or formatted") |
| GRUB `grub-mkrescue` ISO, BIOS + UEFI, unsigned, `gfxpayload=1024x768x32` | `scripts/build-os.sh` |
| UI draws on `/dev/fb0` (32 bpp, 640x480..4096x2160), keyboard via raw evdev, no mouse | `core/session/framebuffer_linux.go`, `core/session/session_linux.go` (`readKeys`, `keyText`) |
| Font: built-in 5x7 uppercase bitmap glyphs; unknown runes render as `?` | `core/session/render.go` |
| DHCP via BusyBox `udhcpc` on every interface; IPv4 route + `resolv.conf` | `rcS`, `system/rootfs/etc/udhcpc.script` |
| Agent: approval-gated, read-only tools (`network.interfaces`, `workspace.list`, search) | `core/agent/tools.go`, `cmd/swypikd/main_linux.go` |
| No model bundled; inference is a remote/loopback Ilaria endpoint | `cmd/swypikd/main_linux.go` (`--ilaria-url`), `README.md` |
| amd64 only (`//go:build linux && amd64`, `GOARCH=amd64`) | `core/session/*.go`, `cmd/swypik-session/main_linux.go`, `scripts/build-os.sh` |

The Linux binaries import only `core/{agent,ilaria,search,service,session,network}` and
`internal/safepath` (`go list -deps ./cmd/swypikd ./cmd/swypik-session`). Packages such as
`core/hal`, `core/audio`, `core/notifications`, `core/appstore`, `core/security`,
`core/boot`, `installer/universal` and `mobile/bridge` are **not in the OS image** and are
mostly legacy prototypes or simulations (`core/hal/simulation.go`, `core/boot/installer.go`
returns an error by design, `installer/universal/data/drivers/` is empty).

## 1. Capability matrix

Legend for the SwypikOS column: **Missing** = nothing exists; **Prototype** = exists but is
diagnostic/VM-only; **Partial** = real but incomplete.

| Capability | Windows 11 | macOS | SwypikOS Linux track today | Recommended way to get it |
| --- | --- | --- | --- | --- |
| Boot / firmware / Secure Boot | UEFI, Secure Boot, TPM 2.0 required, measured boot | Apple silicon Secure Boot, signed system volume | **Prototype.** GRUB ISO boots BIOS/UEFI in QEMU (`build-os.sh`, `scripts/smoke-os.py --uefi`). Unsigned; Secure Boot **missing**; no measured boot | systemd-boot + Unified Kernel Images (`ukify`), shim (Microsoft 3rd-party CA) + MOK for own key, signed in CI; systemd-measure/TPM PCR policy |
| Installer, partitioning, dual-boot | Setup, BitLocker-aware, Windows Boot Manager | Recovery OS installer, APFS containers | **Missing.** `core/boot/installer.go` deliberately fails; ISO never touches disks | `systemd-repart` definitions + own Go installer UI (or Calamares first); GPT/ESP detection, BitLocker detection, require pre-shrunk free space for dual-boot initially; add boot entry, never rewrite Windows ESP files |
| Filesystem & encryption | NTFS/ReFS, BitLocker | APFS, FileVault | **Missing.** tmpfs only (`system/rootfs/init`); no persistent FS, no encryption | ext4 or btrfs (snapshots) on LUKS2, `systemd-cryptenroll` TPM2+PIN, recovery key; NTFS read/write via kernel `ntfs3` for Windows data |
| Kernel & driver model | NT kernel, WDM/WDF, WHQL signed drivers | XNU, DriverKit, kexts deprecated | **Partial.** Real Linux kernel; 9 VM modules; no udev coldplug, no firmware (`build-os.sh`, `rcS`) | Full distro kernel + all modules, `systemd-udevd` modalias autoload, `linux-firmware`, DKMS/akmods only for out-of-tree (NVIDIA) |
| GPU: Intel (i915 / Xe) | Vendor driver | Apple GPU / legacy Intel | **Missing.** Only `bochs` (VM) + fbdev; no DRM drivers, no GuC/HuC/DMC firmware | Kernel `i915`/`xe` + `linux-firmware` (i915/xe blobs) + Mesa (Iris GL, ANV Vulkan) + intel-media-driver (VA-API) |
| GPU: AMD | Vendor driver | n/a (older Macs only) | **Missing** | Kernel `amdgpu` + `linux-firmware` (amdgpu) + Mesa (radeonsi, RADV) + VA-API in Mesa |
| GPU: NVIDIA | Vendor driver | n/a | **Missing** in image. `core/hal/discovery.go` only calls `nvidia-smi` for inventory (Windows EXE uses `core/hal/cuda_driver_windows.go`) | Turing+: NVIDIA open kernel modules (GSP firmware) + proprietary userspace, MOK-signed for Secure Boot; fallback `nouveau` + Mesa NVK (Vulkan) for older/unsupported; CUDA only via the NVIDIA stack |
| Display server, compositor, HiDPI, multi-monitor | DWM, per-monitor DPI, HDR, VRR | WindowServer, Retina, ProMotion | **Prototype.** Single `/dev/fb0`, fixed 2x bitmap scale, no hotplug, no windows (`framebuffer_linux.go`, `render.go`); `docs/NATIVE_OS.md` states it is not a compositor | Wayland on DRM/KMS: ship an existing wlroots compositor (labwc/sway) or smithay one (niri/cosmic-comp) first, Swypik shell as layer-shell clients; later an own smithay-based compositor. fractional-scale, color-management/HDR, VRR, output hotplug |
| Input: keyboard layouts (incl. Romanian) | Built-in layouts, Romanian (Standard) | Built-in, Romanian | **Prototype.** Hard-coded US QWERTY scancode table (`keyText` in `session_linux.go`); no AltGr, no dead keys, no `ș ț ă â î` input; renderer folds uppercase diacritics and shows `?` for lowercase ones | `xkbcommon` + xkeyboard-config (`ro(std)` with comma-below ș/ț), layout switcher in Settings |
| Input: IME | TSF, built-in IMEs | Input Sources | **Missing** on Linux (Windows EXE has IME via Win32) | `text-input-v3` + `input-method-v2` in compositor, fcitx5 or IBus |
| Input: mouse, touchpad gestures | Precision Touchpad | Force Touch trackpad | **Missing.** Only `EV_KEY` events handled; no pointer (`readKeys`) | `libinput` (in compositor): acceleration, tap, palm rejection, 3/4-finger gestures, `hid-multitouch`, `i2c-hid`, `psmouse` modules |
| Input: touch, pen | Windows Ink | iPad-only (Sidecar) | **Missing** | libinput touch/tablet-v2 protocol, `wacom` kernel driver, libwacom |
| Audio | WASAPI, Spatial | Core Audio | **Missing.** No sound modules. `core/audio/audio.go` is an in-memory ring buffer, not in the image | ALSA kernel drivers (`snd-hda-intel`, SOF + `sof-firmware`, `snd-usb-audio`), ALSA UCM, PipeWire + WirePlumber, PulseAudio/JACK compat |
| Networking: Ethernet | Built-in | Built-in | **Partial.** `e1000/e1000e/virtio_net` + `udhcpc` IPv4 (`rcS`, `udhcpc.script`); read-only inventory `core/network/status.go`; no IPv6 config, no Realtek r8169 etc. | NetworkManager (DHCPv4/v6, SLAAC, DNS via systemd-resolved), all NIC modules + firmware |
| Networking: Wi-Fi (firmware, WPA3) | Built-in | Built-in | **Missing.** No cfg80211/mac80211 drivers, no firmware, no supplicant (`docs/NATIVE_OS.md` lists it as separate work) | Kernel iwlwifi/mt7921/rtw89/ath11k/ath12k/brcmfmac + `linux-firmware` + `wireless-regdb`; iwd (WPA3-SAE, fast) as NetworkManager backend; captive portal via NM connectivity check |
| Networking: VPN | Built-in IKEv2/L2TP + apps | Built-in IKEv2 + apps | **Missing** | Kernel WireGuard + NetworkManager plugins (OpenVPN, OpenConnect, strongSwan) |
| Bluetooth | Built-in, LE Audio | Built-in | **Missing** | Kernel `btusb`/`btintel`/`btmtk`/`btrtl` + firmware, BlueZ, PipeWire bluez5 (A2DP/HFP/LE Audio) |
| Printing / scanning | Mopria/IPP, vendor drivers | AirPrint | **Missing** | CUPS + cups-browsed, IPP Everywhere (driverless), Gutenprint/HPLIP for legacy; SANE + sane-airscan (eSCL/WSD) |
| Power: suspend/hibernate, battery, thermal | Modern Standby, hibernate, battery saver | Sleep, Low Power Mode | **Missing.** No ACPI userspace; only `ctrlaltdel -> poweroff` in `inittab` | systemd-logind (lid, power key, s2idle/S3), UPower, power-profiles-daemon (or tuned-ppd), thermald on Intel, hibernate to encrypted swap (note: kernel lockdown under Secure Boot restricts hibernation) |
| USB / Thunderbolt / external storage auto-mount | Built-in | Built-in | **Partial.** `usbhid` only; no mass storage mount, no Thunderbolt authorization | Kernel `usb-storage`/`uas`/`thunderbolt`, `bolt` (TB/USB4 authorization), udisks2 for user mounts (exFAT, NTFS3, FAT) |
| Camera / microphone permissions | Privacy settings per app | TCC prompts | **Missing.** No V4L2/audio stack | `uvcvideo`/libcamera, PipeWire camera, xdg-desktop-portal (Camera, ScreenCast) + Flatpak permission store; Swypik approval UI as the portal frontend |
| Notifications | Action Center | Notification Center | **Missing** in image. `core/notifications/broker.go` is an in-process classifier not linked into `swypikd` | freedesktop Notifications D-Bus spec served by the Swypik shell; keep the classifier as a policy layer |
| File manager | Explorer | Finder | **Prototype.** F5 lists workspace entries via `workspace.list` (32 entries, no contents, `core/agent/tools.go`) | Own shell view backed by GIO/udisks2 + trash spec, or ship Nautilus/Thunar initially; file chooser via xdg-desktop-portal |
| App model, packaging, sandboxing | Win32/MSIX, AppContainer | .app, App Sandbox, notarization | **Missing.** Only two built-in static binaries | Flatpak (bubblewrap, portals, OCI) for third-party apps; base OS image-based; Swypik tools as signed first-party services |
| App store | Microsoft Store | App Store | **Missing** in image. `core/appstore/appstore.go` is a seeded in-memory catalog | Flathub + own remote; frontend over libflatpak + AppStream metadata; reviews/signing via Flatpak remotes |
| Updates (atomic / rollback) | Windows Update (CBS, rollback) | Signed snapshot updates | **Missing.** Rebuild ISO manually; `docs/NATIVE_OS.md` requires signed A/B + rollback | Image-based A/B via `systemd-sysupdate` + UKI boot counting (`systemd-bless-boot`), or OSTree/bootc; fwupd + LVFS for firmware; Flatpak for apps |
| Backup | File History, OneDrive | Time Machine | **Missing** | btrfs snapshots (snapper) for rollback; restic/borg to external/cloud for real backup; restore tested in CI |
| User accounts, login, biometrics | Local/MS account, Windows Hello | Local/Apple ID, Touch ID | **Missing.** Single auto-started user; `/etc/shadow` has locked passwords; `su` from `inittab`; no PAM, no seat manager | systemd-logind seats, PAM, greetd + Swypik greeter, optional systemd-homed; fprintd/libfprint for fingerprint; IR face (Howdy) is immature |
| Security: firewall | Defender Firewall | Application Firewall | **Missing** (no nftables) | nftables default-deny inbound, firewalld or own small policy tool |
| Security: permissions, sandbox, MAC | UAC, AppContainer, VBS | TCC, SIP, sandbox | **Partial.** UID 1000 daemon + session, 0600 Unix socket, no root agent, bounded tools, approvals bound to run/approval IDs (`cmd/swypikd/main_linux.go`, `docs/NATIVE_OS.md`). UI and daemon share one identity (documented gap) | Separate service users, systemd sandboxing (`ProtectSystem`, `NoNewPrivileges`, seccomp), polkit for privileged actions, AppArmor or SELinux, Flatpak portals |
| Security: TPM, disk encryption | TPM 2.0, BitLocker | Secure Enclave, FileVault | **Missing** | LUKS2 + TPM2 unlock (`systemd-cryptenroll`), PCR policy tied to signed UKI |
| Accessibility (screen reader, magnifier, high contrast) | Narrator, Magnifier, contrast themes | VoiceOver, Zoom | **Missing.** README: "accessibility ... remain to implement" | AT-SPI2 + Orca; compositor zoom; high-contrast theme; shell toolkit must expose AT-SPI (GTK4 via gotk4 does; the custom bitmap renderer cannot realistically) |
| Localization | 100+ languages | 40+ languages | **Missing** on Linux: English uppercase-only strings, no Unicode shaping (`render.go`); Windows EXE has Romanian tab names | glibc locales, gettext, fontconfig + FreeType + HarfBuzz, Noto fonts; `ro_RO` first |
| System-wide search | Windows Search | Spotlight | **Partial, differentiator.** Own BM25 index + crawler with confirmation, diacritic folding (`core/search/*`), agent tool; indexes only explicit dirs; no file-change watching | Keep own engine; add fanotify/inotify incremental indexing, content extractors, per-app providers via D-Bus |
| AI assistant | Copilot (cloud) | Apple Intelligence (on-device + PCC) | **Partial, differentiator.** Approval-gated agent with checkpoints (`core/agent/*`); no model bundled, fails explicitly without Ilaria | Ship a local inference service option (llama.cpp/vLLM-class runtime for Ilaria weights) so "local-first" is real; keep per-step approvals |
| Settings app | Settings | System Settings | **Missing** on Linux (Windows EXE has a Settings tab) | Own shell Settings backed by D-Bus services: NetworkManager, BlueZ, UPower, PipeWire, logind, localed/timedated, fwupd, polkit |
| Virtualization / containers | Hyper-V, WSL2, Sandbox | Virtualization.framework | **Missing** | KVM + QEMU + libvirt, Podman, distrobox/toolbox; Waydroid for Android apps |
| Gaming (Vulkan, Proton) | DirectX 12, Game Pass | Metal, Game Porting Toolkit | **Missing** (no GPU driver) | Mesa RADV/ANV/NVK or NVIDIA Vulkan, Steam (Flatpak) + Proton, gamescope, gamemode. Kernel anti-cheat titles will not work |
| Developer tools | VS, WSL, winget | Xcode, Homebrew | **Missing** in image (build happens on a separate host) | Flatpak IDEs, distrobox for toolchains, Git, Go toolchain in a dev container |
| Mobile (Android / ARM) | Discontinued | iOS separate | **Missing.** amd64-only build tags; `mobile/bridge/bridge.go` is a Go struct, not an OS | aarch64 builds of the same stack; phones via mainline Linux (postmarketOS device support) or an AOSP/GSI base with Swypik as launcher + agent |

## 2. Strategy statement: what SwypikOS should and should not build

**Writing custom drivers for every GPU, keyboard, Wi-Fi chip and laptop is not feasible.**
Windows and macOS drivers are the product of vendor engineering and certification programs
spanning decades; NVIDIA, AMD and Intel GPU drivers alone are millions of lines, depend on
signed firmware, and change with every hardware generation. No small team can reproduce
that, and "AI-generated drivers" for hardware that cannot be tested are a safety risk.

The realistic strategy, already stated in `docs/NATIVE_OS.md`, is:

- **Hardware layer (reuse):** Linux kernel + `linux-firmware` + Mesa + NVIDIA open kernel
  modules, udev, libinput, PipeWire, BlueZ, NetworkManager/iwd, CUPS, fwupd. SwypikOS
  selects, pins, signs, tests and ships them; it does not rewrite them.
- **System plumbing (reuse):** systemd (logind, udevd, repart, sysupdate, cryptenroll),
  systemd-boot + UKI + shim, LUKS2, Flatpak + portals, a Wayland compositor library.
- **SwypikOS layer (own):** the shell/desktop, Settings, approval UI, the agent runtime and
  its permission model, the search engine, onboarding/installer UX, update policy, and the
  hardware compatibility matrix.

**Where SwypikOS can be better than Windows 11 / macOS**

| Area | Why it can be better | Honest status |
| --- | --- | --- |
| Agent with explicit approvals | Every tool call shows immutable arguments and needs a one-time approval; the model never gets a shell or root (`core/agent`, `docs/NATIVE_OS.md`). Copilot/Apple Intelligence do not expose this level of per-action control | Implemented with read-only tools only; needs a real local model to be "local-first" |
| Own search | Local BM25 index with transparent ranking, no ad/search-provider dependency, Romanian/Hungarian diacritic folding (`core/search`) | Works on explicit directories; no live file watching yet |
| Low resource use | Static Go daemons, `GOMEMLIMIT=128MiB` (`system/rootfs/usr/bin/start-swypikd`), no browser runtime, minimal base | **Unmeasured.** `docs/TECHNOLOGY_DECISIONS.md` states no comparative benchmarks exist; a full graphics stack will raise usage |
| Transparency / privacy | No telemetry, open components, reproducible build manifest (`build-manifest.txt`) | Build is not yet reproducible or signed |

**Where SwypikOS can at best match (because the same upstream components do the work):**
GPU performance and features, Wi-Fi/Bluetooth/audio coverage, suspend reliability, printer
support, and gaming compatibility equal what the Linux ecosystem delivers on a given machine.
**Where it will likely stay behind:** proprietary apps (Microsoft Office, Adobe, many
anti-cheat games), vendor-specific laptop features, enterprise management (Intune/MDM,
Group Policy), Apple ecosystem continuity, OEM certification and pre-installation.

## 3. Prioritized roadmap

Order matters: persistence and a real distro base come before any UI work, because every
later stack (GPU, audio, Wi-Fi, updates) depends on udev, firmware, systemd and a disk.

### P0 - installable, persistent, updatable base (VM first, then 2-3 reference laptops)

| # | Step | Concrete repo changes |
| --- | --- | --- |
| 1 | Replace the hand-assembled BusyBox initramfs with a real distro base (Debian stable recommended) | New `system/mkosi/mkosi.conf` (+ `mkosi.conf.d/` package lists: `linux-image-amd64`, `firmware-linux`, `firmware-misc-nonfree`, `systemd`, `udev`, `mesa`, `network-manager`, `iwd`); new `scripts/build-image.sh`. Keep `scripts/build-os.sh` as the diagnostic RAM ISO and CI smoke path |
| 2 | Move init from BusyBox to systemd; let udev load modules by modalias | Replace `system/rootfs/init`, `etc/inittab`, `etc/init.d/rcS` (fixed module loop) with `system/units/swypikd.service` (User=swypik, `ProtectSystem=strict`, `NoNewPrivileges`, `StateDirectory=swypik`, `RuntimeDirectory=swypik`) and a session unit; drop `udhcpc.script` in favor of NetworkManager |
| 3 | Disk layout and persistence | `system/repart.d/*.conf`: ESP 1 GiB, root A, root B, LUKS2 `/home` (or btrfs `@home`). `swypikd` already takes `--index` and `--state-dir`; point them at `/var/lib/swypik` on disk |
| 4 | Bootloader + Secure Boot | systemd-boot + UKI built with `ukify` in `scripts/build-image.sh`; signing key handling in CI; shim + MOK enrollment doc; plan MOK signing for NVIDIA modules |
| 5 | Installer | New `cmd/swypik-installer` (Go) calling `systemd-repart`, `bootctl install`, `systemd-cryptenroll --tpm2-device=auto`; detect BitLocker and existing ESP; dual-boot only into user-provided free space. Keep `core/boot/installer.go` and `installer/universal` disabled or delete them after the new path lands |
| 6 | Atomic updates + rollback | `system/sysupdate.d/*.transfer` for A/B root + UKI, boot counting (`systemd-bless-boot`); signed update manifests; fwupd for firmware |
| 7 | Tests that prove it | Extend `scripts/smoke-os.py` with `--install` (install to qcow2 in QEMU with swtpm + OVMF Secure Boot vars), `--reboot` (index/agent state survives), `--update` and `--rollback`; add jobs to `.github/workflows/verify.yml` |
| 8 | Separate identities (security gap already documented) | Run `swypikd` and the shell as different users; socket group permission; polkit rules for privileged actions |

### P1 - daily-driver desktop and hardware stacks

| # | Step | Concrete repo changes |
| --- | --- | --- |
| 1 | Wayland session | Ship an existing compositor (labwc or sway via wlroots, or niri/cosmic-comp via smithay) and turn `cmd/swypik-session` into Wayland layer-shell clients (panel, launcher, agent/approval overlay, notifications). Evaluate GTK4 via gotk4 (+ gtk4-layer-shell) for text shaping, IME, HiDPI and AT-SPI. Keep `core/session` fbdev code as a recovery/diagnostic mode only. Long term: own compositor on smithay (Rust) if needed |
| 2 | GPU | Include i915/xe/amdgpu/nouveau + firmware + Mesa in the image; NVIDIA open modules + userspace as an optional signed extension (sysext) with first-boot detection; replace `nvidia-smi` shelling in `core/hal/discovery.go` with a read-only DRM/sysfs inventory for Settings |
| 3 | Input | libinput + xkbcommon in the compositor; `ro(std)` layout default for `ro_RO`; fcitx5 for IME; remove the US-only `keyText` table from the production path |
| 4 | Audio + Bluetooth | PipeWire + WirePlumber + `sof-firmware` + ALSA UCM; BlueZ; volume/device UI in the shell |
| 5 | Networking | NetworkManager + iwd backend; extend `core/network/status.go` to read NM state over D-Bus (connectivity state, SSIDs); keep the agent tool read-only, changes via Settings + polkit |
| 6 | Power + devices | logind, UPower, power-profiles-daemon, thermald, udisks2, bolt, CUPS + sane-airscan, fwupd |
| 7 | Settings, notifications, file manager, login | Own Settings UI over the D-Bus services above; freedesktop notification server (reuse `core/notifications` as policy); file view over GIO/udisks2; greetd + Swypik greeter + PAM, fprintd |
| 8 | Local inference | Optional local Ilaria runtime service so the agent works offline; `cmd/swypikd --ilaria-url` then defaults to it |
| 9 | Hardware test matrix | New `docs/HARDWARE_MATRIX.md` + `scripts/hw-report.sh` (collects `lspci -nnk`, `lsusb`, `dmesg` firmware errors, `journalctl -k`). Reference set: Intel Core Ultra/12th-gen laptop (i915/xe, iwlwifi, SOF), AMD Ryzen 7040/8040 laptop (amdgpu, mt7922/rtw89), desktop with NVIDIA RTX (open modules) and one pre-Turing NVIDIA (nouveau), a USB-C dock with 2 monitors. Per-machine checks: boot, Secure Boot, Wi-Fi WPA3, BT headset, speakers/mic/HDMI audio, 20x suspend/resume, lid, battery estimate, external monitor hotplug, USB drive auto-mount, IPP printer, fwupd |

### P2 - parity polish and expansion

| # | Step | Notes |
| --- | --- | --- |
| 1 | Accessibility | AT-SPI2 + Orca, compositor magnifier, high-contrast theme, keyboard-only navigation audit |
| 2 | Apps and store | Flatpak + Flathub + own remote; replace the seeded catalog in `core/appstore/appstore.go` with an AppStream/libflatpak-backed frontend; portals for camera/mic/screen share wired to the Swypik approval UI |
| 3 | Backup | btrfs snapshots before updates; restic/borg user backup with tested restore |
| 4 | Localization | gettext for the shell, `ro_RO` + `hu_HU` + `en_US`, HarfBuzz text |
| 5 | Search | inotify/fanotify incremental indexing, extractors (PDF, Office), search providers from apps |
| 6 | Gaming, virtualization, dev | Steam/Proton + gamescope; KVM/libvirt, Podman, distrobox, Waydroid |
| 7 | ARM64 and phones | Drop `amd64`-only build tags in `core/session` and `cmd/swypik-session`, add `GOARCH` to the build; aarch64 laptop image; phone target via postmarketOS-supported devices or an AOSP base with Swypik launcher/agent |
| 8 | Release obligations | Reproducible, signed builds; GPL corresponding source for kernel/BusyBox/GRUB/etc. (already flagged in `docs/NATIVE_OS.md`); firmware and NVIDIA redistribution licenses; media codec patent review |

## 4. Summary of the largest gaps

1. No persistent install: RAM-only tmpfs, no installer, no disk layout, no dual-boot.
2. No update/rollback or Secure Boot chain; ISO is unsigned GRUB.
3. Only 9 VM kernel modules, no firmware and no udev: real laptops will lack GPU, Wi-Fi, audio and USB storage support (anything not built into the kernel).
4. No GPU stack at all (no DRM driver, no Mesa, no NVIDIA modules).
5. UI is a single-framebuffer diagnostic screen, not a Wayland compositor: no windows, mouse, multi-monitor or HiDPI.
6. Keyboard input is US-only raw evdev; no Romanian layout, IME, touchpad or touch.
7. No audio, Bluetooth, Wi-Fi, VPN, printing, power management or auto-mount.
8. No accounts/login/PAM, firewall, encryption or separate service identities.
9. No app model, sandbox, store, accessibility or localization.
10. The differentiators (approval-gated agent, own search) exist, but the agent has no bundled local model and resource claims are unmeasured.
