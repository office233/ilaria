# SwypikOS — native operating-system prototype

The product target is a **bootable, Linux-based, AI-driven operating system**.
It is not a Windows application, Electron host, Chrome app window, or web page
presented as an OS. Linux supplies the kernel and real device drivers; Swypik
supplies its native session, service, approval-gated agent and own search index.

**Maturity: pre-alpha, RAM-only VM prototype.** This is not a finished Windows or
macOS replacement. No custom kernel, disk installer, Secure Boot chain, persistent
user partition or production Wayland compositor is claimed. No Ilaria/Nexus model
weights are bundled. AI calls fail explicitly until a real Nexus service is configured.

## Build a live ISO

Use an isolated x86_64 Linux builder (CI uses Ubuntu 24.04), Go, and these tools:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends linux-image-virtual busybox-static \
  kmod grub-pc-bin grub-efi-amd64-bin xorriso mtools qemu-system-x86 ovmf
sudo env PATH="$PATH" bash scripts/build-os.sh
```

The script assembles ordinary files under `out/`; it never formats or writes a
block device. It packages the installed kernel and matching module dependencies.
`KERNEL_VERSION` can select a particular installed kernel. The build manifest
records the actual toolchain, kernel and package versions. This is **not yet a
bit-for-bit reproducible or signed release**; repeat builds may select newer
installed packages unless all inputs are pinned.

```sh
qemu-system-x86_64 -machine q35 -m 768 -smp 2 \
  -cdrom out/swypik-os-native.iso -boot d -vga std \
  -nic user,model=virtio-net-pci -serial mon:stdio
```

Use a VM only. No host disk is passed to this command. The prototype does not
mount disks, install alongside Windows, migrate personal files or enable Secure
Boot. Files and the index survive a service restart but **not a VM reboot**.

## Native interface

F1 opens Home, F2 Search, F3 Agent, F4 Network, and F5 Workspace. This first native
renderer uses a Linux framebuffer and evdev keyboard input, not a browser.
Mouse navigation, full Unicode shaping, accessibility, multiple windows and a
production Wayland session remain to implement.

In Search, enter a query against your own index. An empty index produces no
invented results. Type `crawl https://example.org/` to propose indexing a site;
F8 confirms contacting that website, and F9 cancels. The UI crawl visits up to
8 same-origin pages. Results are ranked using BM25, with URL, timestamp and hash.
No DuckDuckGo, Google, Bing or other search-provider API supplies these results.

In Agent, type a goal. F8 explicitly consents to sending that goal and approved
metadata to the configured Nexus service. Every proposed tool then needs a
separate, one-time F8 approval; F9 cancels. Tools currently inspect network
adapters, list workspace entries and query the local search index. There is no
shell, root tool, autonomous installation, arbitrary file write or payment tool.

Nexus still owns the model. `swypikd --ilaria-url` accepts the existing loopback
HTTP or authenticated HTTPS contract; remote HTTPS requires `ILARIA_API_TOKEN`.
Provision tokens at runtime, never in the ISO. The default loopback service is
not included, and absent inference is reported as an error rather than simulated.

## Verification

```sh
go test -race -count=1 ./...
go vet ./...
python3 scripts/smoke-os.py
python3 scripts/smoke-os.py --uefi --out out/smoke-uefi
```

The boot tests use the real ISO in diskless QEMU, require native-session and agent
UID 1000 plus a DHCP lease, and capture pixels from the VM. They do not establish
physical-laptop compatibility or successful real-model inference. Check the
workflow result and its logs rather than treating this README as a test report.

## Structure and migration

`system/rootfs` contains init and network setup. `cmd/swypikd` serves a private Unix
socket; `cmd/swypik-session` is the native UI. `core/agent`, `core/network`,
`core/search`, `core/service` and `core/session` are the new execution path.

The Electron host, its npm dependency tree, Windows launcher and shortcut were
removed. The old browser-served UI and hosted Windows entrypoint were also
removed; their source remains in Git history, not in the OS image. The previous
embedded-app/MCP interface has **not** been ported to the native session.
Windows `.ps1` product launchers now explain the Linux image build instead of
producing a misleading `.exe` OS.

Several older modules remain prototypes, including simulated distributed compute,
rewards and hardware synthesis. They do not supply real drivers, a bootloader or
model training. The simulated installer now fails instead of reporting success.
Older documents describe the retired Windows prototype; this README and the
native design documents define the current target. See [native OS design](docs/NATIVE_OS.md),
[search limits](docs/OWN_SEARCH.md) and [repository audit](docs/NATIVE_AUDIT.md).
