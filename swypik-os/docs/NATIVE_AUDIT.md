# Repository audit and native migration

Baseline: `420cd74239245bf1454e3a0cfeab60d6777ce44c`, 153 original files.
Initial repository metadata incorrectly reported an empty repository; branch/tree
and file reads located the actual source. This is an architecture/critical-path
review with tests, not proof that every line or hardware path is correct.

## Findings

1. **Normal launch used Electron.** Start-SwypikOS.bat invoked electron.exe;
   desktop/package.json declared Electron 44.4.5. README's no-npm claim contradicted it.
2. Direct Go executable launch used Edge/Chrome --app, or Win32 GDI as a fallback.
   Neither was a bootable independent operating system.
3. core/boot/installer.go logged formatting, kernel/EFI installation and success
   without doing those operations. Its success path is now disabled.
4. core/hal/cuda_driver.go wrapped installed Windows NVIDIA DLLs, not network
   drivers. Its tensor microkernel was a CPU loop. Windows-only syscall symbols
   prevented Linux compilation until separated by platform filenames.
5. core/search/search.go invented sources/answers/counters; the web UI sent
   searches to DuckDuckGo. The new native path uses only the actual own index.
6. Ilaria exposed text chat, not native function calling. A bounded read-only
   agent loop now links structured decisions, validation, one-time approvals,
   tool output and replanning. JSON adaptation does not establish native Ilaria
   function calling or prove quality on a real model.
7. The old web API could execute commands with user rights and expose configured
   Home/workspace paths. Origin checks were not a sandbox. The native image has
   neither that API nor an arbitrary command-execution tool.
8. Electron provided isolated remote app views and MCP connectors. Removing it
   removes those implementations. Equivalent native functions are **not yet ported**.
9. First Windows CI run failed TestRootBoundary on a valid descendant. Root-only
   canonicalization mixed short/aliased paths. The new helper resolves both operands;
   this is not protection against hostile concurrent filesystem changes.
10. Distributed training/rewards/hardware synthesis/BCI/world-model modules include
    simulations. They are not accepted GPU work, physical drivers or a complete OS.
    The legacy wallet is not encrypted key storage. These historical components
    are outside the native runtime and need separate audits before integration.

## Migration

Removed Electron, npm manifest/lockfile, Windows launcher/shortcut, browser-served
UI and hosted entrypoint. Added native Linux commands, private Unix IPC, non-root
service/session, actual kernel/initramfs/GRUB assembly, kernel module packaging,
DHCP, BIOS/UEFI VM smoke tests, own search and approval-gated read-only agent.
Unrelated historical Go prototypes remain in source. Removed UI can be recovered
from Git history. No disk-writing installation path is enabled.

## Evidence and gaps

Local Linux development checks passed with Go 1.23.2: go test -race ./... and
 go vet ./.... Test fixtures no longer assume or enumerate the developer's real
Documents directory. Windows CMD tests are explicitly platform-scoped.
CI reruns all tests and attempts the actual ISO boots; inspect its logs/artifacts
for each outcome rather than interpreting this document as a successful boot report.

Pre-alpha only. Persistent storage, real Ilaria inference/weights, full Wayland,
native MCP/apps, writable sandboxed tools, accounts/credentials, Wi-Fi/firmware,
audio, signed updates, rollback and physical hardware certification remain.
No revenue guarantee, security certification or company affiliation is established.
