# KERNEL_SEED — M1 Swypik-owned platform substrate

## Status and non-claims

This is a buildable architecture/boot seed, not a complete kernel. The x86_64
track now has host-verified 4-level page-table mechanics, per-driver address
spaces, APIC routing semantics, capability-gated MMIO/IRQ/DMA/config operations,
an IOMMU mapping manager with a host-verified Intel VT-d legacy backend, PCI ECAM address/access logic and an
`ExitBootServices` handoff into `swyp_kernel_entry`. It still does **not** provide
SMP scheduling, XSAVE/XSTATE coverage for AVX-class state, a VFS, VirtIO
drivers, networking, graphics or persistent storage.
The existing Linux path remains isolated as a reference candidate and is not modified by this work.

## Trusted-core boundary

The privileged substrate contains deterministic mechanisms only: boot/architecture contracts, memory/address-space interfaces, interrupt/timer interfaces, thread-context storage, bounded IPC primitives, capability objects and the typed device graph.
Ilaria/model inference is not part of privileged kernel code. Adaptive/generated drivers are intended to execute in isolated user-mode driver domains and receive only brokered capabilities.

## Architecture-neutral contracts

`include/swypik/kernel/contracts.h` defines versioned contracts for:

- `SwypBootInfo` and `SwypPhysicalMemoryMap`;
- `SwypArchInfo` for x86_64, ARM64 and RISC-V 64;
- `SwypPageAllocator`;
- `SwypAddressSpace` / MMU mapping operations;
- `SwypInterruptSource`;
- `SwypTimerSource`;
- opaque, aligned `SwypThreadContext` storage.

Per-architecture context layouts live under `include/swypik/arch/<arch>/`. The
host build compiles all three contract layouts with static assertions. ARM64 and
RISC-V artifacts are **not** native cross-built by the current x86_64 host
toolchain; these checks prove header/layout consistency only.

## Capability and IPC seed

`src/core/capability.c` implements a fixed-capacity capability table with opaque 64-bit handles, generation-based stale-handle rejection, domain binding, lease-fence binding, per-object rights masks and explicit revocation. A slot is permanently retired when its 32-bit generation reaches exhaustion; generation values never wrap back to a stale handle.
It is intentionally allocator-free and small enough to replace with a real kernel object table later without changing the public object/grant concepts.

`src/core/driver_domain.c` builds the first driver-domain authority broker on
that table. Exact `DeviceGraph` resources are selected with explicit rights,
checked for exclusive live ownership, minted atomically into a domain/fence and
resolved through domain + fence + handle + rights + object-type checks. Teardown
revokes the domain's grants so old handles fail by generation. This is the
mechanism layer required by user-mode drivers; it does not yet perform the
hardware operation represented by a successful grant lookup.

`src/core/device_broker.c` is the privileged operation gate above those grants.
It mediates MMIO mappings, IRQ lifecycle, DMA mappings and configuration-space
access through injected platform operations. Every call revalidates domain,
lease fence, capability handle, rights and object type before any backend call.
Persistent mappings/bindings use separate generation-protected broker handles;
teardown quiesces the domain, cleans outstanding backend state and only then
revokes its resource capabilities.

`src/core/device_platform.c` connects the broker's MMIO and IRQ paths to the
portable `SwypAddressSpace` and `SwypInterruptSource` contracts. Its host tests
verify physical-page alignment, covering-page calculation, non-executable user
device mappings, VA reserve/release, vector allocation, bind/unmask/EOI and
mask/unbind/release teardown.

`src/core/kernel_runtime.c` composes the architecture-neutral capability table
and driver-domain manager with `SwypX86DriverRuntimeManager`,
`SwypDevicePlatform` and `SwypDeviceBroker`. Opening a driver domain creates the
x86 address space before capability publication and rolls the address space back
if grant creation fails. Closing a domain quiesces and cleans broker state,
revokes capabilities and only then destroys the x86 runtime state. Host E2E
tests map MMIO through this complete stack, query the generated page tables,
activate the driver CR3 in a fake hardware backend, switch back to the kernel
root and verify zero page-table leaks plus stale-capability rejection.

## x86_64 isolation and device substrate

`src/arch/x86_64/address_space.c` implements bounded 4-level PML4/PDPT/PD/PT
address spaces with 4 KiB leaves, lower-canonical user VA validation, NX by
default, device-cache flags, transactional mapping rollback, full-range
preflight for unmap/protect, empty-table reclamation and CR3-aware destruction.
Host fault-injection verifies that an intermediate page-table allocation failure
does not leave a partial mapping or leaked child table.

`src/arch/x86_64/driver_runtime.c` owns fixed-capacity per-driver address spaces,
exact VA allocations and globally unique IRQ vectors under `domain_id +
lease_fence`. The same virtual device window can therefore be reused safely in
different driver CR3s. A domain cannot close while VA, IRQ or IOMMU state is
still live, and an active CR3 cannot be destroyed.

`src/arch/x86_64/native_mmu.c` provides the native x86_64 primitives used by the
address-space contract: direct-map physical translation, `mov CR3`, CR3 readback
and `invlpg`. These privileged instructions are compile-verified by the host
gate but deliberately not executed in user mode.

The direct-map contract is sparse: physical-to-virtual translation succeeds only
for explicitly registered mapped ranges. Firmware/MMIO holes cannot be turned
into synthetic kernel pointers merely because they sit below a global physical
limit.

`src/arch/x86_64/privilege.c` defines the first ring0/ring3 privilege contract:
kernel/user code/data selectors, a 64-bit TSS with `RSP0` and IST slots, canonical
GDT/TSS encoding and 256-entry IDT gate construction. After CR3 takeover the UEFI
path installs a new GDT/TSS plus an emergency IDT whose vectors use a dedicated
guarded IST and terminate in a kernel halt stub, so early NMI/fault delivery
cannot jump back into firmware IDT memory.

`src/arch/x86_64/apic.c` implements IOAPIC route ownership and LAPIC EOI
semantics. Binding first masks an existing route, programs a kernel-owned
destination/vector, preserves firmware polarity/trigger bits, and only then may
unmask. Unbind neutralizes and masks the route. `apic_mmio.c` provides the actual
xAPIC selector/window and LAPIC MMIO access primitive for already-mapped APIC
pages. `apic_router.c` composes multiple non-overlapping IOAPIC GSI ranges into
one `SwypInterruptSource`, so driver IRQ capabilities are routed by GSI rather
than assuming IOAPIC #0.

`timer.c` provides a dedicated LAPIC scheduler vector and two hardware modes.
The injected count-periodic mode is used by host/platform tests. Native boot
prefers TSC-deadline mode when CPUID advertises it and the TSC frequency can be
derived from leaf `0x15` or `0x16`; the scheduler interval is 1 ms. If those
facts cannot be demonstrated, native preemption remains disabled instead of
guessing a LAPIC frequency. Timer interrupts capture the current ring3 context,
consume scheduler quantum, EOI the LAPIC, repatriate kernel CR3 and resume the
kernel continuation with `PREEMPT` on expiry. The timer is armed only while a
driver continuation is live.

`extended_state.c` keeps x87/SSE state outside the portable 320-byte thread ABI.
Each driver thread gets a separate aligned 512-byte FXSAVE image plus FS/GS base
state. Runtime trap/yield/preempt paths save that state, and the next launch
restores it before entering ring3. Native boot enables MP/NE/OSFXSR/
OSXMMEXCPT before binding this backend. Host E2E tests verify state isolation
across yield, CR3 switches and timer preemption. AVX/AVX-512 XSAVE state is not
claimed yet.

`src/arch/x86_64/iommu.c` manages page-aligned IOVA allocations and mapping
lifecycle under domain/device/fence identity. Every map/unmap is followed by a
domain invalidation; invalidate failure during teardown is retryable without a
second hardware unmap. DMA mapping requires both the device DMA capability and
a separate shared-memory capability, so a driver never supplies an arbitrary
physical buffer. Device attachment is also explicit and fence-bound; a PCI
driver domain cannot map DMA until its Requester ID has been attached.

`src/arch/x86_64/vtd.c` now implements the legacy Intel VT-d hardware backend:
4 KiB root/context tables, per-domain hardware DIDs, four-level 48-bit
second-level page tables, PCI Requester-ID attachment, context/IOTLB invalidation,
translation enable/disable and fail-closed teardown. `vtd_mmio.c` is the native
register aperture backend. DMAR discovery now preserves DRHD/RMRR device scopes,
including complete PCI paths. `vtd_router.c` routes direct endpoint Requester IDs
to the exact scoped DRHD with `INCLUDE_PCI_ALL` as fallback and can fan domain
invalidation across every VT-d unit used by that domain. Multi-hop endpoint and
sub-hierarchy scopes are resolved through the live ECAM topology by validating
each PCI-to-PCI bridge and following its primary/secondary/subordinate bus
registers; malformed or unavailable topology is refused rather than guessed.
`platform_boot.c` initializes all discovered DRHD units and exposes one routed
`SwypX86Iommu` to the runtime. RMRR identity preservation is now capability
bound: KernelRuntime accepts an RMRR requester only when the exact reserved
range is present as an explicit `SHARED_MEMORY` resource for that device. The
router then installs an R/W identity mapping before publishing the attach, and
removes it transactionally on detach. The KernelRuntime derives the Requester ID
from the device's CONFIG resource BDF, auto-attaches it before DMA becomes
usable, and detaches it only after broker DMA mappings have been cleaned.

`src/arch/x86_64/pci_ecam.c` implements segment/bus/device/function ECAM address
calculation plus aligned 1/2/4-byte config access. Sub-dword writes use bounded
read-modify-write and config resources carry the PCI BDF/segment encoding in
their `aux` field. The physical ECAM read/write primitive is still provided by
the platform runtime rather than discovered/mapped automatically at boot.

`src/core/ipc.c` implements a bounded in-memory endpoint/reference queue. Send and receive are checked at the IPC boundary against an endpoint capability, subject domain, lease fence and the required `SEND`/`RECEIVE` right. The queued `sender_capability` is written only from the successfully authenticated handle, never trusted from caller message bytes. It is a semantics test fixture for the machine-independent IPC contract, not a scheduler-integrated production IPC transport.

## Typed DeviceGraph wire v1

`DeviceGraph` is firmware-source-independent. It models PCI/USB/ACPI/DeviceTree/VirtIO/platform nodes, device classes, vendor/device/class/progIF identity, firmware version, IOMMU grouping, features, resources and dependency/topology edges.
It deliberately has no raw serial-number field.

The canonical wire representation is byte-defined, little-endian and does not depend on C struct padding:

- 24-byte `SWDG` v1 header;
- 96 bytes per node;
- 40 bytes per resource;
- 24 bytes per edge.

The decoder rejects wrong magic/version, non-canonical lengths, nonzero v1 reserved/padding bytes, fixed-width strings without a canonical NUL terminator, capacity overflow, duplicate node IDs, unsafe resource ranges and broken references. Header bytes 18-23, node bytes 38-39 and 44-47, resource bytes 12-15, and edge bytes 20-23 are reserved and must be zero. Fixed-width firmware/model strings must contain a NUL byte and all bytes from the first NUL through the end of the field must be zero.

Resource policy is fail-closed before capability creation: all resources have
nonzero length; MMIO ranges may not wrap; DMA/shared-memory ranges are 4 KiB
aligned, page-sized and non-wrapping; port-I/O stays within the 16-bit port
space; IRQ describes exactly one 32-bit vector; config space is a non-wrapping
window inside the v1 4 KiB per-device configuration aperture; clock/reset/power
describes one discrete control. Overlapping MMIO/port-I/O/DMA/shared-memory
ranges of the same kind are rejected globally, and overlapping config or
duplicate IRQ/control resources are rejected within one node.

`parent_id` and `CONTAINS` jointly form the hierarchical topology and must be acyclic. Self-parent/self-edge, duplicate edges, and cycles in that hierarchy are rejected. Other edge kinds are directed association edges and are not treated as hierarchy for cycle policy.
The broader signed Hardware Manifest described by the universal-install architecture wraps this graph with architecture/ABI/endianness, firmware/boot environment, ACPI/DeviceTree evidence and CPU/GPU/NPU capability inventory.

## x86_64 UEFI seed

`src/boot/uefi_x86_64.c` now performs a real first-party takeover path. Before the
final memory-map capture it reserves an `EfiLoaderData` bootstrap arena laid out
as `page tables | guard | emergency IST | guard | continuation stack`. The
takeover callback rebuilds PE identity ranges plus higher-half direct-map ranges
against every fresh firmware map key without additional firmware allocations,
then `ExitBootServices` publishes that exact map. Assembly switches CR3 and stack
immediately, confirms the new root, installs the emergency GDT/TSS/IDT, and
probes a real allocator page through the new direct map before setting the final
handoff flags. It then discovers ACPI platform state, maps APIC/optional ECAM,
initializes `SwypKernelRuntime`, binds the kernel root to the scheduler, installs
the IRQ/syscall IDT entries and only then enters `swyp_kernel_entry_runtime`.

The current runtime entry therefore starts after firmware boot services are
gone, kernel CR3/direct-map are active, GDT/TSS/IST and exception traps are live,
the platform/APIC path has passed discovery, and scheduler + driver ABI entry
points are bound. Without an external init image it halts deliberately; there
is no ambient bootstrap driver or fabricated workload.

### Explicit initial task (2026-10-02)

The UEFI loader optionally reads `\EFI\SWYPIK\INIT.SWD` from the image's boot
volume. Absence is recorded, not replaced with a built-in task. The SWYDRV1
image is capped at 1 MiB and parsed before ExitBootServices; directories,
corruption, truncation, growth during reads and size overflow are refused.
Its loader-owned source pages remain read-only supervisor input until reboot.
The added `SwypBootInfo` fields extend the existing prefix, keeping
`boot_flags` at offset 160; the boot harness checks the structure's size.

An explicitly provided image runs through the existing domain, W^X image
loader, scheduler, ring-3 and syscall paths. A separate COMPUTE/PLATFORM
admission API grants **zero** device capabilities; the resource-bearing driver
API still refuses an empty grant policy. Hardware preemption is required.
When calibrated TSC-deadline support is absent, a count-based LAPIC quantum is
used only while the task is running; its count is not a duration claim.
After at most 128 dispatches, an unfinished task is stopped and its domain,
user pages and entry stack are cleaned up.

The proof exposed a boot-only stack corruption: `TSS.RSP0` pointed at the
suspended boot continuation's stack, so ring-3 interrupts overwrote live
kernel call frames. Init now has a separate 64 KiB supervisor-only NX entry
stack between unmapped guard pages; the prior RSP0 is restored afterwards.
`RUNTIME_HANDOFF_VALIDATED` distinguishes the intentional final kernel halt
from emergency halts or a prematurely completed stage.

```bash
python3 tools/make-init-image.py INIT.SWD
python3 boot-qemu.py --efi out/efi-portable/BOOTX64.EFI \
  --ovmf-code /usr/share/OVMF/OVMF_CODE_4M.fd \
  --ovmf-vars /usr/share/OVMF/OVMF_VARS_4M.fd --init INIT.SWD
```

The supplied first-party probe checks CS privilege level 3 and DOMAIN_ID 1,
yields, resumes and exits with code 42. `--mode loop` produces an infinite-loop
probe; use `--init-outcome limited` to require timer preemption, bounded
termination and cleanup. `--init-outcome refused` requires invalid input to
stay unexecuted. These are execution probes, not real hardware drivers, a
general-purpose userspace, multicore task scheduling, or a signed boot chain.

### Confined init-task faults (2026-10-02)

Init explicitly admits `(thread=1, domain=1, lease=1)` for fault termination
after loading its image and before dispatch. The existing exception table now
routes synchronous CPL3 task exceptions through this exact admission, running
scheduler thread, active zero-grant domain, loaded image, driver CR3 and live
kernel continuation. Missing/stale admission, kernel-mode exceptions, NMI,
double fault, machine check, reserved/system exceptions and reserved-bit page
faults retain the fatal-record/emergency-halt path. There is no implicit
workload, new capability, filesystem or network authority.

On a confined fault the runtime captures terminal registers, disarms the LAPIC
timer, quiesces the domain, stops **all threads of that epoch**, restores and
checks kernel CR3, consumes the admission and resumes the kernel continuation
with `SWYP_KERNEL_DRIVER_RUN_FAULT`, not EXIT. Terminal capture deliberately
accepts a bad RIP/RSP; resumable contexts still require canonical addresses and
the existing mapped image/stack bounds. Initial launch alignment remains strict.
Init then removes the stopped threads, unloads/releases user image
and stack pages, revokes the domain and clears extended state. Its separate
supervisor entry stack and RSP0 are restored/cleaned by the existing wrapper.
The failed epoch cannot be reopened, reloaded or activated through the runtime,
and stopped threads cannot be made READY. A fresh lease is a different epoch;
this milestone is not a general restart supervisor.

`SwypBootInfo` ABI version remains 1, with the entire original 232-byte prefix
preserved (`boot_flags` at 160, init input at 168, observed domain at 224).
The appended 88-byte, version-1 `SwypDriverFaultRecord` at offset 232 makes the
total size 320. It records thread/domain/lease, vector, hardware error code,
CR2 for #PF (zero otherwise), RIP, CS, restored kernel CR3 and
`SWYP_ERR_FAULT` (-8). `INIT_FAULTED` is bit 18; `INIT_FAILED` and `INIT_CLEANED`
must also be present and `INIT_EXITED` must be absent. The final
`RUNTIME_HANDOFF_VALIDATED` bit is withheld unless evidence agrees with the
runtime record, the timer/continuation are inactive, kernel CR3 is current and
the faulty epoch has no remaining scheduler, image, domain or extended-state
slot. Any failed containment or cleanup remains fail-closed.

The external image generator adds `ud2` (#UD, vector 6), `supervisor-read`
(#PF, vector 14, error 5, CR2 `0xffffc00000001000`) and `privileged` (CLI,
#GP, vector 13, error 0). Each checks CPL3/domain1 and yields before faulting;
none calls successful EXIT. `bad-stack` sets RSP=1 then executes UD2, proving
termination does not depend on a resumable user stack. The supervisor-read
target is the mapped supervisor-only entry stack, not an arbitrary unmapped
address. `call-loop` is a healthy CALL/prologue/balanced-push loop which checks
user IF on every iteration. `--require-call-stack-preemption` requires repeated
real CPL3 timer trace frames, at least one RSP%16=8 and saved IF=1 on every
observed user timer. These are first-party, deterministic execution probes.

The CALL probe reproduced a tightly coupled pre-existing defect: capture,
stack-range validation and launch preparation required RSP%16=0 at arbitrary
interrupt boundaries. Before the fix a healthy task halted on its first timer
at RSP `0x4fffffffffe8`, with neither cleanup nor validated final handoff.
Capture now marks a kernel-captured resumable context, and a separate resume
preparation path accepts in-range unaligned stacks. Fresh launches still reject
unaligned RSP, and stack guards, canonical checks, image W^X and CPL/SS checks
are retained. No alignment restriction is added to arbitrary AMD64 execution
points, where CALL/push/prologues legitimately change RSP.

Run the Windows gates from the kernel directory with the already installed
compiler (adjust only the compiler path if relocated):

```powershell
$Zig = 'E:\nexus\ramasite\local\tools\zig-0.16.0\zig.exe'
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-host.ps1 -Compiler $Zig
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-portable.ps1 -Zig $Zig
python -B -m unittest discover -s tests -p 'test_*.py' -v
$env:GOCACHE = Join-Path $PWD 'out\go-cache-windows'
Push-Location ..
go vet ./...
go test -count=1 -timeout 180s ./...
Pop-Location
git diff --check
```

For Linux host C tests without PowerShell, from the same kernel directory in
WSL Ubuntu (the installed Zig uses the assembly's explicit Microsoft ABI):

```bash
T="$HOME/.local/share/copilot-tools"
mkdir -p out/host
mapfile -t sources < <(find src -type f \( -name '*.c' -o -name '*.S' \) \
  ! -name runtime_mem.c ! -name contract_check.c | sort)
"$T/zig/zig" cc -std=c11 -Wall -Wextra -Werror -fno-pie -no-pie -Iinclude \
  "${sources[@]}" tests/host_core_test.c tests/init_host_test.c -o out/host/core-tests-linux
out/host/core-tests-linux
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
export PATH="$T/go/bin:$PATH" GOMODCACHE="$T/gomodcache" GOCACHE="$PWD/out/go-cache-linux"
cd ..
go vet ./...
go test -count=1 -timeout 180s ./...
```

Run the QEMU regression matrix from the kernel directory in WSL Ubuntu. Save
Bash scripts with LF and invoke them with `wsl.exe -d Ubuntu -- bash SCRIPTFILE`
from Windows rather than embedding Bash in PowerShell 5.1 command quoting.
All emulator evidence is in a unique WSL-home directory, not the main checkout.
No KVM, network, installation or deployment is used:

```bash
set -euo pipefail
K="$PWD"
P="$HOME/.local/share/copilot-tools/qemu-system"
export LD_LIBRARY_PATH="$P/usr/lib/x86_64-linux-gnu:$P/lib/x86_64-linux-gnu"
O=$(mktemp -d "$HOME/swypik-fault-XXXXXXXX")
cp out/efi-portable/BOOTX64.EFI "$O/BOOTX64.EFI"
for mode in success loop call-loop ud2 supervisor-read privileged bad-stack; do
  python3 -B tools/make-init-image.py "$O/$mode.swd" --mode "$mode"
done
python3 -c 'from pathlib import Path; import sys; p=Path(sys.argv[1]); p.joinpath("corrupt.swd").write_bytes(b"invalid"); p.joinpath("oversized.swd").write_bytes(b"\0"*(1048576+1))' "$O"
run() {
  name="$1"; shift
  python3 -B "$K/boot-qemu.py" --efi "$O/BOOTX64.EFI" \
    --qemu "$P/usr/bin/qemu-system-x86_64" \
    --qemu-data "$P/usr/share/qemu" --qemu-data "$P/usr/share/seabios" \
    --ovmf-code "$P/usr/share/OVMF/OVMF_CODE_4M.fd" \
    --ovmf-vars "$P/usr/share/OVMF/OVMF_VARS_4M.fd" \
    --out "$O/$name" --timeout 90 "$@" > "$O/$name.json"
}
run no-init-1
run no-init-4 --cpus 4
run no-init-1-1024 --memory-mib 1024
run no-init-4-1024 --cpus 4 --memory-mib 1024
run no-init-iommu --iommu
run success-1 --init "$O/success.swd"
run success-4 --cpus 4 --init "$O/success.swd"
run loop --init "$O/loop.swd" --init-outcome limited
run corrupt --init "$O/corrupt.swd" --init-outcome refused
run oversized --init "$O/oversized.swd" --init-outcome refused
for cpus in 1 4; do
  for mode in ud2 privileged bad-stack supervisor-read; do
    vector=6; error=0; address=0
    if [ "$mode" = privileged ]; then vector=13; fi
    if [ "$mode" = supervisor-read ]; then vector=14; error=5; address=0xffffc00000001000; fi
    run "$mode-$cpus" --cpus "$cpus" --init "$O/$mode.swd" --init-outcome fault \
      --expected-fault-vector "$vector" --expected-fault-error "$error" \
      --expected-fault-address "$address" --trace-interrupts
  done
done
for cpus in 1 4; do
  run "call-loop-$cpus" --cpus "$cpus" --init "$O/call-loop.swd" --init-outcome limited \
    --require-call-stack-preemption --hmp "info lapic"
done
# Inspect the warning and LAPIC mode; requesting a feature does not prove it.
run call-loop-tsc-requested --cpu max,+tsc-deadline --init "$O/call-loop.swd" --init-outcome limited \
  --require-call-stack-preemption --hmp "info lapic"
echo "Evidence: $O"
```

The harness accepts only known ABI/version-size combinations (168/232/320
bytes), rejects truncated records, and never picks a favorable record among
ambiguous live candidates. `--init-outcome fault` requires the expected vector,
versioned fault record, exact task epoch/CPL, failed-not-exited status, cleanup,
restored kernel CR3 and final validated handoff. Optional expected error/address
arguments make the probes exact. The loop outcome requires exactly 128
yield/preemption dispatch returns. Host tests also reject wrong identities,
kernel/system exceptions, failed timer disarm/CR3 restoration, incomplete
cleanup and replay; all allocated task pages return to the fixture baseline.
The real repeated count-timer probe checks user IF rather than assuming that
the continuation's kernel IF=0 persists after the next IRET. Deadline-mode host
tests separately exercise three nonpreempting/preempting/disarm/rearm cycles
through the actual scheduler/continuation interfaces. Real TSC-deadline
delivery is not proven when QEMU TCG rejects that requested CPU feature; inspect
`qemu_output` and `info lapic` before making any timer-mode claim.
This is bounded single-init/BSP fault isolation, not production OS recovery,
SMP userspace scheduling, full XSTATE coverage or physical-hardware validation.

Verified local evidence: Windows and Linux C host gates and all 10 Python tests
pass. The final portable EFI builds twice identically with SHA-256
`42a0732c0befc0021c6c5b084e481676d2e36406fc5672f5d23bb0c0ca15014e`.
All 21 QEMU expected outcomes pass: ten old-path cases, eight confined-fault
cases, two healthy CALL-loop cases and one unsupported-deadline/count-fallback
case. Fault cases record flags `0x7abff`, status -8, exact vector/error/address,
cleanup and final handoff, without EXIT. Healthy CALL loops record one yield
and 127 preemptions; all 127 observed user timer frames have RSP%16=8 and IF=1.
LAPIC evidence is masked periodic mode with initial/current count zero after
cleanup. Requesting TSC-deadline emits an explicit unsupported-TCG warning;
that case is not evidence of real deadline delivery.

The Windows full product `go vet ./...` and `go test -count=1 -timeout 180s ./...`
pass. Linux full vet and relevant package vet/tests pass:
`go vet ./internal/nativegraph ./core/boot ./core/controlkernel` and
`go test -count=1 -timeout 180s ./internal/nativegraph ./core/boot ./core/controlkernel`.
The broader Linux Go suite is **not clean**: unchanged
`cmd/plan-supervisor/TestPlanCompletionRequiresTypedBoundValueAndCleanExit`
intermittently reports completion/preflight failure (both with and without
concurrent QEMU), while its isolated five-run test passes; a serial full run
instead reports `internal/planprocess/TestOutputAndInputBoundsTerminateChild/stderr_limit`
returning EOF before the expected stderr-limit error. These Go transport files
are outside this milestone and were not modified or silently skipped. No
whole-system, Go-daemon/native-kernel integration or physical hardware claim
follows from these kernel probes.

## Reproducible local build

`build.ps1` uses only locally installed `gcc`, `objdump` and `nasm`, writes only below `out/`, runs host core tests, compiles the three architecture contract probes, builds `out/efi/BOOTX64.EFI`, rejects unexpected DLL imports, checks PE32+/x86_64/EFI subsystem metadata and writes a SHA-256 hash.
It also builds the benchmark record emitter and emits a clearly marked `placeholder` NDJSON record; zeroes are never represented as measurements.

`build-portable.ps1` is the verified no-system-toolchain path. It uses the
checksum-pinned portable Zig toolchain, compiles the full current kernel/runtime
dependency graph with `-nostdlib`, supplies first-party freestanding memory
primitives, validates PE32+/x86_64/EFI subsystem/entry/import metadata, and
normalizes only non-runtime COFF timestamp/`.buildid` metadata. Two consecutive
builds on 2026-09-30 produced the identical SHA-256
`50c7952a14dc53f6410ec573933c388c01747b6316dfefb42c0008fb1b8f09b2`.

For the architecture/security core gate without the EFI toolchain, use
`test-host.ps1`. It accepts either GCC or an explicit Zig compiler path and
compiles the same core with `-std=c11 -Wall -Wextra -Werror` before executing the
host tests. This does not substitute for the EFI/PE inspection performed by
`build.ps1`.

QEMU boot evidence (2026-10-02): `boot-qemu.py` boots the `build-portable.ps1`
image from a FAT ESP under OVMF in `qemu-system-x86_64` (TCG, `-no-reboot`),
requires the pre-handoff ConOut lines on serial, waits for the vCPU to halt,
dumps guest RAM and reads the live `SwypBootInfo.boot_flags`. All ten stages
through `DRIVER_ABI_READY` are reached with 1 or 4 CPUs, 512 MiB or 1 GiB and
with an emulated Intel VT-d unit, with no CPU reset. Getting there fixed four
boot-only defects that host tests could not see: privilege validation rejected
the TSS busy bit set by `LTR` and the accessed bits the CPU sets on loaded
segment descriptors; compound-literal zeroing of `SwypX86PlatformBoot`
(~2.4 MiB) and `SwypX86Vtd` (~134 KiB) created stack temporaries far larger than
the 64 KiB continuation stack (`-Wframe-larger-than=16384` now fails the build);
and DMAR hardware without coherent page walks (QEMU's emulated VT-d) halted the
boot instead of continuing without an IOMMU. In that case `iommu_status`
records `SWYP_ERR_UNSUPPORTED`, `IOMMU_READY` stays clear and driver DMA is
refused. `IOMMU_READY` is not proven on any platform, and physical hardware is
not claimed. TCG emulation does not measure timing.

```bash
python3 boot-qemu.py --efi out/efi-portable/BOOTX64.EFI \
  --ovmf-code /usr/share/OVMF/OVMF_CODE_4M.fd --ovmf-vars /usr/share/OVMF/OVMF_VARS_4M.fd \
  [--cpus 4] [--memory-mib 1024] [--iommu]
```
