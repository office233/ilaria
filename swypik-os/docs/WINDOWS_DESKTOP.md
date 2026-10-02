# Native Windows desktop

## Delivery contract

The default Windows artifact is `bin/swypik-os.exe`, a Go executable using Win32
and GDI directly. There is no Electron host, npm dependency installation, bundled
Chromium, WebView renderer or HTTP server for the desktop UI. Windows supplies
kernel services and device drivers; this executable is not a standalone OS.
The Linux boot prototype is retained independently and selected explicitly with
`-Target Linux` in the PowerShell build helpers.

The build uses `CGO_ENABLED=0`, with GUI subsystem 2 for the primary executable
and console subsystem 3 for `swypik-os-console.exe`. Both use the same Windows
entrypoint. Builds are unsigned development artifacts, not an installed service,
a signed production distribution or a replacement Windows shell.

## Startup, storage and shutdown

`cmd/swypik-os/main_windows.go` parses options before creating runtime objects.
`-version`, `-help` and `-check` return before hardware inventory, worker startup,
window creation, directory creation or network requests. `-check` is configuration
validation, not a live health test of Ilaria or the GPU.

Direct execution defaults to `%LOCALAPPDATA%\SwypikOS` for state and logs, and its
`workspace` child directory for user work. The `SWYPIK_STATE_DIR` and
`SWYPIK_WORKSPACE_DIR` environment variables or the explicit `-data-dir` and
`-workspace` flags override those defaults. The repository batch launcher selects
the checkout as its workspace. Paths are resolved before runtime startup;
relative legacy writes resolve against the selected workspace, never the
launcher's accidental current directory. This is path selection, not confinement:
the process retains the launching Windows user's filesystem permissions.

The persistent index is `search-index.jsonl`; the older JSON index is imported
and retained with a `.migrated` suffix after successful migration. A torn final
JSONL write is removed. Other index corruption is quarantined with a warning,
retaining only validated earlier documents. The original damaged file remains
available for inspection. Unique startup logs are written under
`logs/desktop-*.log` without depending on a console's stderr handle. GUI startup
errors use a native message box. Credentials are supplied at runtime and are not
embedded in artifacts or printed in startup logs.

The Compute tab can query an available NVIDIA management tool for model and VRAM
inventory. It records consent for future contribution; no training work currently
runs from this desktop. No automatic training job, cloud coordinator request or
payment is triggered by launch. Closing the window cancels the active operation
and closes the agent manager before its checkpoint store.

## Win32 lifecycle and input

Window creation and the message loop are pinned to one operating-system thread.
The module handle, class registration, window creation and refresh timer are
checked. Creation occurs without `WS_VISIBLE`; the application stores its HWND
before showing the window, avoiding early paints against an unset handle.

`GetMessageW` distinguishes a normal message, `WM_QUIT`, and an error. Fonts,
timers, windows and class registration are cleaned up on normal exit and failures.
The native window class is `SwypikOS_Native_Class`. Startup/shutdown evidence is
persisted in the log.

`WM_CHAR` is decoded as UTF-16, including surrogate pairs. Tests cover Romanian
diacritics, supplementary characters and malformed sequences. GDI font fallback,
complex-script shaping, full accessibility and DPI-adaptive layouts still require
work; correct text storage alone does not establish those capabilities.

## Commands and search

The command dispatcher accepts one asynchronous command at a time. Blocking AI
or terminal work does not execute on the Win32 message thread. Tasks have a
context deadline, cancellation and panic reporting. Workers update synchronized
view state, not GDI handles. `/cancel` requests cancellation of background work,
pending confirmations and the agent run. The desktop has no certified physical
E-stop or hardware actuation path. Context cancellation is cooperative; Windows
Job Objects supply lifecycle control for approved child processes.

Queries in the Search tab read only the persistent local index. Empty indexes and unmatched
queries produce explicit empty results. An index does not populate itself: the
Windows `/crawl URL [pages]` requires confirmation before contacting the site,
enforces robots rules and rejects private destinations. `/index [dir]` indexes
local text files inside the configured workspace. Search tests use a known
local document and a nil Ilaria engine to catch accidental inference fallback.
The renderer no longer executes a hardcoded search query during each paint.

Ilaria is an optional real inference backend. The default origin is
`http://127.0.0.1:8091`; remote inference must use the existing authenticated HTTPS
contract and `ILARIA_API_TOKEN`. No real model is bundled or automatically started.
A missing backend produces an error when a prompt is submitted.

The Windows entrypoint wires `core/agent.Manager` to workspace read/write/edit/list,
process execution and local search tools. Each proposed tool requires one explicit
approval; F8 approval requires the prompt to have been visible for at least 500 ms.
Existing-file writes require a SHA256 from an earlier read. Windows checkpoints
use a private per-user location, exclusive writer locking and flushed replacement;
`/resume` replans safely interrupted runs with fresh approvals. Uncertain tool
outcomes block automatic replay. Approved commands run in a Windows Job Object
with an allowlisted environment and descendant cleanup. This controls process
lifecycle; filesystem and network sandboxing remain to implement.

## UI maturity

Search and workspace listing are connected to their local engines. Legacy app,
finance, device actuation, BCI and distributed training modules remain prototypes
outside the desktop entrypoint. Their presence in source does not establish
working desktop integrations or validated physical drivers.

The desktop has a Home screen and six functional tabs. Windows and Linux use
distinct native checkpoint adapters; both share the approval-gated agent runtime.
The Linux session and private service remain separate from Windows delivery.
Full accessibility, production credential storage, signed releases and physical
hardware validation remain open requirements.

## Verification and artifacts

```powershell
powershell -File scripts/build.ps1
powershell -File scripts/verify.ps1 -Race
powershell -File scripts/smoke-windows.ps1
.\bin\swypik-os-console.exe -check
```

The build runs tests and vet, stages both binaries, validates PE headers and
executes console checks before publishing. `build-manifest.json` records the
actual Go version, source revision/dirty flag and binary SHA256 values. The ZIP
contains the two binaries and their manifest/checksums. Existing release outputs
are not replaced after a failed compilation or check.

Race verification requires a compatible C compiler even though the release build
does not. The new Windows CI workflow builds/tests artifacts; a committed workflow
is not evidence that a remote CI run passed.

The lifecycle smoke test starts its own instance from an unrelated working
directory with isolated data and workspace paths. It verifies visible HWND
ownership/class, message responsiveness before and after native Unicode input,
absence of observed direct browser children and owned listening TCP ports, exit
code zero and the persisted shutdown log. Sampling does not prove absence of all
possible future network activity. Test artifacts are retained under `out/`.
Optional screenshots are taken only when the test owns the foreground window;
otherwise the report records why no screenshot was captured. Other running
SwypikOS processes are never terminated by this test.

The Linux ISO is still built separately:

```powershell
powershell -File scripts/verify.ps1 -Target Linux -Distro swypik
powershell -File scripts/build.ps1 -Target Linux -Distro swypik -KernelVersion <installed-kernel>
```

See the main README for Linux prerequisites and VM-only safety constraints.
