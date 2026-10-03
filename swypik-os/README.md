# SwypikOS — native Windows desktop

The current desktop delivery is **`bin/swypik-os.exe`: a native Go/Win32
Windows application, without Electron, Chromium, WebView, Node or an HTTP UI
server**. It uses the Windows kernel and drivers. The EXE is not an independent
bootable operating system. The separate Linux OS prototype is preserved below;
it is no longer the default Windows build target.

## Build and run the Windows EXE

From a Windows checkout with Go installed:

```powershell
powershell -File scripts/build.ps1
.\bin\swypik-os.exe -workspace "D:\swypik-os"
```

`Start-SwypikOS.bat` launches an already-built EXE using this checkout as its
workspace. It does not download dependencies or open a browser. The build runs
Go tests and vet, checks both PE subsystem headers, and writes:

```text
bin/swypik-os.exe                    Native GUI; no console window
bin/swypik-os-console.exe            Same native app with console diagnostics
bin/swypik-os-windows-amd64.zip       Portable package on an amd64 builder
bin/build-manifest.json              Build/toolchain facts and SHA256 hashes
bin/SHA256SUMS                       Binary checksums
```

The direct EXE defaults to `%LOCALAPPDATA%\SwypikOS\workspace`; logs, the search
index and local state are under `%LOCALAPPDATA%\SwypikOS`. Use `-workspace` and
`-data-dir` to override these locations. Relative legacy file operations resolve
in the selected workspace, but that directory is **not a security sandbox**.

```powershell
.\bin\swypik-os-console.exe -version
.\bin\swypik-os-console.exe -check
powershell -File scripts/verify.ps1 -Race
powershell -File scripts/smoke-windows.ps1
```

`-check` prints configuration without creating files, opening a window or making
network requests. Race tests need a compatible C compiler; the release binaries
are built with CGO disabled. The smoke test launches its own isolated window,
checks Win32 ownership and responsiveness, sends a harmless local search command,
checks for browser children/TCP listeners, and verifies clean shutdown plus logs.
It never closes other running SwypikOS sessions.

## Run with Ilaria

SwypikOS and Ilaria are sibling products in the Nexus workspace. From the
workspace root:

```powershell
powershell -File swypik-os\scripts\start-with-ilaria.ps1 -IlariaURL http://127.0.0.1:8091
```

The script builds only the native desktop, validates its configuration, and
connects it to the explicitly selected, already running Ilaria service. It does
not load weights, start a missing server or assume a pretrained model family.
Ilaria's canonical model is IMC, trained from scratch; model quality and GPU
readiness require separate measured gates. Missing services fail explicitly.
The agent shows every step and runs nothing without approval.

## Windows desktop: what works

Seven tabs (Home plus Ctrl+1…6), a native input field with paste, history (↑/↓) and IME, and
word-wrapped, scrollable, DPI-aware rendering:

| Tab | What it does |
| --- | --- |
| Acasă | Open the six functional tabs, start a conversation or choose a workspace action. |
| Chat | Conversation with the configured Ilaria service. No service, no answer: errors are shown, never simulated. |
| Agent | Give a goal. Ilaria plans one step at a time using `workspace.read/write/edit/list`, `process.run` and `search.query`. **Every step is shown and needs approval** (F8 approve, F9 deny; a prompt must be visible for 500 ms first). Edits require the file hash from a prior read, so stale content is never overwritten. Runs are checkpointed and survive restarts (`/resume`). |
| Căutare | Your own search engine: BM25F ranking, Romanian/Hungarian diacritic folding, prefix matching and snippets. `/index [dir]` indexes local text and code files; `/crawl URL [pages]` indexes a site after confirmation, honouring robots.txt and blocking private addresses. No Google, Bing or DuckDuckGo. |
| Fișiere | Browse and preview files inside the workspace. |
| Calcul | Detected NVIDIA GPUs and your consent for future Ilaria training contribution. No work runs yet; see [the design](../ramasite/docs/swypik-os/ILARIA_COMPUTE.md). |
| Setări | `/ilaria https://…` switches the Ilaria endpoint, `/test` checks it, `/workspace DIR` saves the workspace for the next restart. |

Connect Ilaria (for example the Azure deployment) as described in
[docs/ILARIA_INTEGRATION.md](../ramasite/docs/swypik-os/ILARIA_INTEGRATION.md). Approved commands run
with your permissions inside a Windows Job Object; that is lifecycle control,
not a sandbox. See [Windows architecture and limitations](../ramasite/docs/swypik-os/WINDOWS_DESKTOP.md).

## Separate Linux OS prototype

The preserved Linux track supplies a bootable Linux kernel with real drivers,
a framebuffer session, a private service, an approval-gated agent and an own
search index. The remainder of this README describes that separate track, not
the Windows EXE or its keyboard shortcuts.

**Maturity: pre-alpha, RAM-only VM prototype.** This is not a finished Windows or
macOS replacement. No custom kernel, disk installer, Secure Boot chain, persistent
user partition or production Wayland compositor is claimed. No Ilaria/Ilaria model
weights are bundled. AI calls fail explicitly until a real Ilaria service is configured.

## Linux: build a live ISO

Use an isolated x86_64 Linux builder (CI uses Ubuntu 24.04), Go, and these tools:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends linux-image-virtual busybox-static \
  kmod grub-pc-bin grub-efi-amd64-bin xorriso mtools qemu-system-x86 ovmf
KERNEL_VERSION=<installed-generic-kernel-version>
sudo env PATH="$PATH" KERNEL_VERSION="$KERNEL_VERSION" bash scripts/build-os.sh
```

The script assembles ordinary files under `out/`; it never formats or writes a
block device. It packages the installed kernel and matching module dependencies.
`KERNEL_VERSION` is required; the builder never silently picks an Azure/host kernel. The build manifest
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

## Linux: native interface

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
metadata to the configured Ilaria service. Every proposed tool then needs a
separate, one-time F8 approval; F9 cancels. Tools currently inspect network
adapters, list workspace entries and query the local search index. There is no
shell, root tool, autonomous installation, arbitrary file write or payment tool.

Ilaria still owns the model. `swypikd --ilaria-url` accepts the existing loopback
HTTP or authenticated HTTPS contract; remote HTTPS requires `ILARIA_API_TOKEN`.
Provision tokens at runtime, never in the ISO. The default loopback service is
not included, and absent inference is reported as an error rather than simulated.

## Linux: build from Windows using WSL

```powershell
powershell -File scripts/verify.ps1 -Target Linux -Distro swypik
powershell -File scripts/build.ps1 -Target Linux -Distro swypik -KernelVersion <installed-generic-kernel-version>
```

Install Linux development dependencies inside the selected WSL distribution first;
the helpers do not install software automatically. Results, exact source snapshots
and test logs are copied into a unique `out/linux-*` directory.
`out/last-linux-build.txt` identifies that directory. WSL is only the build host.

## Linux: agent recovery

The last run is checkpointed in the owner-only directory selected by
`swypikd --state-dir` (default `/var/lib/swypik/agent`). Service restart does not
replay any tool. Pending approvals become invalid. For a safe interrupted run,
F6 requests resume and F8 confirms sending the saved goal/evidence to Ilaria.
Every tool then needs a fresh approval. Original deadlines and budgets remain.
An interrupted tool with an unrecorded outcome cannot be resumed automatically.
This stores only the last run, not a multi-run history; starting a new run replaces
it. State is plaintext with restricted permissions, not encrypted. The RAM-only
ISO still loses state at VM reboot. A separate agent-recovery design document
is not included in this checkout.

## Linux: verification

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

The Electron host, its npm dependency tree and old browser-served UI remain
removed; their source is available only in Git history. The new Windows entrypoint
is `cmd/swypik-os/main_windows.go`, with `ui/engine` providing Win32/GDI rendering.
The previous embedded-app/MCP interface has not been ported to either native UI.
PowerShell helpers now default to the native Windows EXE. Select `-Target Linux`
explicitly for the preserved WSL verification/ISO workflow; `build-linux.ps1`
retains its existing implementation. No bootloader or driver replacement is
installed by the Windows desktop build.

Several older modules remain prototypes, including simulated distributed compute,
rewards and hardware synthesis. They do not supply real drivers, a bootloader or
model training. The simulated installer now fails instead of reporting success.
Older documents describe different migration stages; this README and
[Windows desktop design](../ramasite/docs/swypik-os/WINDOWS_DESKTOP.md) define the current EXE target.
For the separate Linux track, see [native OS design](../ramasite/docs/swypik-os/NATIVE_OS.md),
[search limits](../ramasite/docs/swypik-os/OWN_SEARCH.md) and [repository audit](../ramasite/docs/swypik-os/NATIVE_AUDIT.md).

## Durable plan supervisor

`cmd/plan-supervisor` is the Windows/Linux headless reference path for complete
Swyp plans: immutable IR, exact host scopes, durable cumulative budgets,
independent persistent Ilaria verification and Control Kernel commit. It uses
the existing resource governor and reports measured process CPU/RSS. It does
not yet replace the native UI's agent path or implement automatic recovery.
See the [supervisor v1 milestone](../ramasite/docs/workspace/milestones/supervisor-v1.md) for host
configuration, the trusted JSONL service interface, measurements and limits.

```powershell
go build ./cmd/plan-supervisor
# From the Nexus repository root:
./ramasite/scripts/verify-supervisor.ps1
```
