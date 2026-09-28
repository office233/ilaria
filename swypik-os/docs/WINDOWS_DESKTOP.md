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

The persistent index is `search-index.json`; invalid existing indexes stop startup
instead of being silently discarded. Unique startup logs are written under
`logs/desktop-*.log` without depending on a console's stderr handle. GUI startup
errors use a native message box. Credentials are supplied at runtime and are not
embedded in artifacts or printed in startup logs.

Swarm inventory is constructed with compute and training explicitly disabled.
An available NVIDIA management tool can supply model and VRAM inventory; unknown
TFLOPS remain unknown rather than being inferred from a model name. No automatic
training job, cloud coordinator request or payment is triggered by desktop launch.
Closing the window cancels the active command and stops the Swarm worker.

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
view state, not GDI handles. `cancel` requests cancellation. `stop`, `estop` and
emergency-stop phrases bypass the busy gate, cancel the active task and request a
software controller stop. This is not a certified or verified physical E-stop.
Legacy routines that do not accept context may finish before cancellation takes
effect; this is not process isolation or forced preemption.

`search <query>` reads only the persistent local index. Empty indexes and unmatched
queries produce explicit empty results. An index does not populate itself: the
Windows crawl/approval interaction remains to implement. Search tests use a known
local document and a nil Ilaria engine to catch accidental inference fallback.
The renderer no longer executes a hardcoded search query during each paint.

Ilaria is an optional real inference backend. The default origin is
`http://127.0.0.1:8091`; remote inference must use the existing authenticated HTTPS
contract and `ILARIA_API_TOKEN`. No real model is bundled or automatically started.
A missing backend produces an error when a prompt is submitted.

The existing developer command dispatcher is retained, including its prototypes
and simulations. It is not wired to `core/agent.Manager` approvals or durable run
recovery. Do not treat the command filter as a sandbox or expose it to untrusted
remote callers. Windows approval prompts, run history, credential storage and a
Windows-appropriate durable store must precede a production autonomous release.

## UI maturity

Search and workspace listing are connected to their local engines. Other legacy
app panels are marked as prototypes because their demonstration statuses do not
prove working media pipelines, finance, messaging, app installation or hardware
actuation. The voice button explicitly reports that capture is not implemented;
it does not pretend to activate a microphone.

The next integration boundary is the existing approval-gated agent runtime, not
more simulated capability claims. Its Linux checkpoint implementation must not
be relabeled as Windows persistence. The Linux session and service remain intact
while the native Windows adapter is developed separately.

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
