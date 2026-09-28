# KERNEL_SEED — M1 Swypik-owned platform substrate

## Status and non-claims

This is a buildable architecture/boot seed, not a complete kernel. It does **not** yet implement context switching, page tables, interrupt controllers, a scheduler, processes, a VFS, VirtIO drivers, networking, graphics, persistent storage or `ExitBootServices` handoff.
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

Per-architecture context layouts live under `include/swypik/arch/<arch>/`. The host build compiles all three contract layouts with static assertions. ARM64 and RISC-V artifacts are **not** cross-compiled by the installed x86_64 MinGW compiler; these checks prove header/layout consistency only.

## Capability and IPC seed

`src/core/capability.c` implements a fixed-capacity capability table with opaque 64-bit handles, generation-based stale-handle rejection, domain binding, lease-fence binding, per-object rights masks and explicit revocation. A slot is permanently retired when its 32-bit generation reaches exhaustion; generation values never wrap back to a stale handle.
It is intentionally allocator-free and small enough to replace with a real kernel object table later without changing the public object/grant concepts.

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

Resource policy is fail-closed before capability creation: all resources have nonzero length; MMIO/DMA/shared-memory ranges may not wrap; port-I/O stays within the 16-bit port space; IRQ describes exactly one 32-bit vector; config space is a non-wrapping window inside the v1 4 KiB per-device configuration aperture; clock/reset/power describes one discrete control. Overlapping MMIO/port-I/O/DMA/shared-memory ranges of the same kind are rejected globally, and overlapping config or duplicate IRQ/control resources are rejected within one node.

`parent_id` and `CONTAINS` jointly form the hierarchical topology and must be acyclic. Self-parent/self-edge, duplicate edges, and cycles in that hierarchy are rejected. Other edge kinds are directed association edges and are not treated as hierarchy for cycle policy.
The broader signed Hardware Manifest described by the universal-install architecture wraps this graph with architecture/ABI/endianness, firmware/boot environment, ACPI/DeviceTree evidence and CPU/GPU/NPU capability inventory.

## x86_64 UEFI seed

`src/boot/uefi_x86_64.c` uses a minimal first-party UEFI ABI declaration, prints a deterministic Swypik seed banner/status through `ConOut`, calls firmware `GetMemoryMap`, and records the raw descriptor buffer address, size, stride, version, map key and entry count in `SwypBootInfo`.
The buffer is static (128 KiB), so capture does not mutate the firmware memory map through allocator calls. If the map does not fit, the loader fails explicitly.

The seed performs no disk writes, does not call `ExitBootServices`, and returns to firmware after reporting `status=seed-only no-kernel-handoff`.

## Reproducible local build

`build.ps1` uses only locally installed `gcc`, `objdump` and `nasm`, writes only below `out/`, runs host core tests, compiles the three architecture contract probes, builds `out/efi/BOOTX64.EFI`, rejects unexpected DLL imports, checks PE32+/x86_64/EFI subsystem metadata and writes a SHA-256 hash.
It also builds the benchmark record emitter and emits a clearly marked `placeholder` NDJSON record; zeroes are never represented as measurements.

QEMU is required for actual boot evidence and is not installed on the current workstation. No toolchain installation is performed by this task.
