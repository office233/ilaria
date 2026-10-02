# DRIVER_DOMAIN — capability-isolated generated/adaptive drivers

## Authority model

Generated or adapted device code is user-mode by default. A driver domain has no ambient kernel memory, filesystem, network, device configuration or DMA authority.
The privileged kernel/device broker grants explicit capability objects derived from the verified `DeviceGraph` resource set.

Supported seed object classes are:

- MMIO range: read/write/map rights;
- architecture port I/O: read/write rights;
- IRQ/vector: bind/ack rights;
- DMA/IOMMU resource: read/write/map rights;
- device configuration space: read/write rights;
- clock/reset/power control: read/control rights;
- bounded shared memory: read/write/map rights;
- IPC endpoint: send/receive rights.

Every grant binds to a driver-domain ID and a monotonic lease fence. Revocation invalidates the handle generation; generation exhaustion permanently retires the slot so an ancient handle can never become current again. IPC entry points resolve the endpoint capability at the boundary with the calling domain, lease fence and required send/receive right before queue access, and sender identity stored in a message is kernel-authenticated rather than caller-authored.

`include/swypik/kernel/driver_domain.h` and `src/core/driver_domain.c` now
implement the first architecture-neutral driver-domain broker over this table.
The broker accepts a validated `DeviceGraph` node plus an exact resource/right
policy, binds policy entries by the complete resource descriptor rather than
graph order, mints only the requested rights subset, and binds every handle to
the driver-domain ID and Control Kernel lease fence. Live overlapping resource
ownership is exclusive, so a second domain cannot concurrently receive the same
MMIO/port-I/O/DMA/shared-memory range or the same device IRQ/config/control
resource. Resolve checks domain ownership, fence, rights, object type and device
node; teardown revokes all domain handles and stale generations remain invalid.
Capability-table capacity is preflighted so a domain is not partially published
just because the table fills during a grant set.

`include/swypik/kernel/device_broker.h` and `src/core/device_broker.c` add the
capability-gated privileged operation boundary. The seed now exposes mediated
operations for:

- MMIO map/unmap: `MAP` is mandatory, requested read/write access must also be
  present in the grant, range slicing cannot escape the exact MMIO object, and
  backend mappings are forced to user/device/non-executable semantics;
- IRQ bind/ack/unbind: the driver never chooses a global interrupt vector;
  `BIND` authorizes binding and `ACK` is checked independently for each ack;
- DMA map/unmap: `MAP` plus the requested read/write direction is required on
  both the device DMA aperture and a second shared-memory capability; the
  driver cannot inject a raw physical address, and the mapping size cannot
  escape either exact resource;
- device configuration read/write: only 1/2/4-byte accesses inside the granted
  configuration aperture are forwarded and read/write rights are independent;
- clock/reset/power control: state reads require `READ`, while mutations require
  the separate `CONTROL` right, so telemetry-only drivers cannot power-cycle a
  device.

Backend-private tokens are never returned to the driver. The broker issues its
own generation-protected mapping/binding handles, so an old MMIO/DMA/IRQ handle
cannot become valid again after cleanup. Domain teardown first marks the domain
`QUIESCED`; normal capability resolution then fails immediately. The broker
cleans every outstanding MMIO mapping, IRQ binding and DMA mapping and only then
revokes the underlying capability handles. A cleanup failure leaves the domain
quiesced and the cleanup record retryable rather than restoring hardware access.

`include/swypik/kernel/device_platform.h` and `src/core/device_platform.c` now
provide the reusable platform adapter for those backend families:

- MMIO is translated into the target domain's `SwypAddressSpace`: physical
  ranges are page-aligned, the covering page count is calculated with overflow
  checks, a domain VA range is reserved, and only `READ/WRITE + USER + DEVICE`
  flags reach `AddressSpace.map`; execute/global mappings are never introduced;
- IRQ binding allocates a kernel-owned vector, binds the hardware source through
  `SwypInterruptSource`, unmasks it only after a successful bind, routes ack to
  `end_of_interrupt`, and masks/unbinds/releases the vector on teardown;
- DMA and config-space requests are forwarded only after the broker has
  validated both capabilities/ranges/rights, into fence-bound runtime backends.

The platform adapter keeps cleanup state separate from driver-visible broker
handles. MMIO unmap can therefore finish address-space unmap first and retry VA
release if the allocator reports a transient failure. IRQ teardown similarly
tracks controller unbind separately from vector release, while IOMMU teardown
tracks hardware unmap separately from invalidation.

The x86_64 path now supplies concrete mechanism backends behind these contracts:
PML4/PDPT/PD/PT driver address spaces, native CR3/invlpg primitives, IOAPIC/LAPIC
routing and MMIO access, a fence-bound IOVA/IOMMU mapping manager, and PCI ECAM
address/config access. Host tests connect all of these through one driver-domain
flow. The IOMMU manager is now backed by legacy Intel VT-d root/context and
second-level page tables. DMAR device scopes are preserved and Requester IDs are
routed across multiple DRHD units; a scoped unit takes precedence over
`INCLUDE_PCI_ALL`. Multi-hop endpoint/sub-hierarchy scopes are resolved from
live ECAM bridge topology and fail closed when a bridge path is inconsistent.
Requester ownership is exclusive across domains, hardware DID allocation is
separate from logical domain IDs, and invalidation failure is fail-closed. RMRR
identity mappings are admitted only when the exact reserved range is explicitly
present as a device `SHARED_MEMORY` resource, so firmware reservation semantics
cannot silently expand DMA authority.

`src/core/kernel_runtime.c` is the composition boundary over those pieces. It
owns the shared capability table, driver-domain manager, x86 driver runtime,
device-platform adapter and device broker, so capability epoch and address-space
epoch open/close as one lifecycle rather than through unrelated callers.

Once a kernel root is bound, the scheduler participates in that lifecycle. If a
driver epoch being closed owns the currently running scheduler thread, the
runtime stops that epoch, repatriates execution to kernel CR3, removes stopped
thread records, then cleans broker state/revokes capabilities and destroys the
driver address space. An active driver CR3 is therefore never destroyed in place.

## Synthesis boundary

Ilaria may synthesize source/IR and tests in an isolated build domain. Ilaria does not mint capabilities and does not get unrestricted kernel authority.
A candidate must pass schema/ABI checks, forbidden-operation scanning, static checks where supported, deterministic unit/property tests, emulator/fake-device protocol tests, capability/effect audit, controlled hardware probing, canary activation, health/fault gates and rollback evidence before activation.

The Go Hardware Manifest now carries explicit typed resources (`MMIO`,
`PORT_IO`, `IRQ`, `DMA`, `CONFIG`, `DEVICE_CONTROL`, `SHARED_MEMORY`) and rejects
invalid or conflicting ranges using the same conservative rules as the kernel
wire graph. Protected DeviceSynth verification requires an externally
authorized resource-grant plan with exact resource descriptors and exact rights;
the normalized grant plan is included in the verifier's signed evidence-summary
hash. The universal installer passes those same grants plus the active lease
fence to the driver-domain activation boundary and includes the grant-plan hash
in the Control Kernel side-effect request hash.

Unknown hardware fails to a generic standards driver, degraded safe mode or an unsupported-device report. Model confidence is never an authorization signal.

## Kernel-resident exceptions

Kernel-resident driver logic is reserved for minimal mechanisms that cannot safely be brokered to a domain. Moving code into the trusted core requires an explicit threat-model/latency justification and does not grant Ilaria/model code privileged execution.

## Safety boundary

This seed does not implement safety-critical automotive control. Generated code must not control brakes, steering, airbags, propulsion or equivalent safety-critical actuators without a separately certified architecture and OEM authorization.

## Remaining substrate work

The remaining gap is now above page-table takeover, ACPI/APIC/ECAM bootstrap,
multi-DRHD/multi-IOAPIC routing, CR3 dispatch and single-CPU timer preemption:
XSAVE/XSTATE coverage beyond legacy FXSAVE, SMP scheduler/APIC affinity and
stress, firmware/hardware boot evidence, and certified platform-specific
clock/reset/power operations. The exception/trap/syscall stubs, ring3
image/stack loader, scheduler address switching, TSC-deadline preemption and
x87/SSE+FS/GS thread state are host-gated; generated code must never bypass the
broker entry points while the remaining platform work is added.
