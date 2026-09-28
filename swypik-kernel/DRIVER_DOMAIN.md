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

## Synthesis boundary

Ilaria may synthesize source/IR and tests in an isolated build domain. Ilaria does not mint capabilities and does not get unrestricted kernel authority.
A candidate must pass schema/ABI checks, forbidden-operation scanning, static checks where supported, deterministic unit/property tests, emulator/fake-device protocol tests, capability/effect audit, controlled hardware probing, canary activation, health/fault gates and rollback evidence before activation.

Unknown hardware fails to a generic standards driver, degraded safe mode or an unsupported-device report. Model confidence is never an authorization signal.

## Kernel-resident exceptions

Kernel-resident driver logic is reserved for minimal mechanisms that cannot safely be brokered to a domain. Moving code into the trusted core requires an explicit threat-model/latency justification and does not grant Ilaria/model code privileged execution.

## Safety boundary

This seed does not implement safety-critical automotive control. Generated code must not control brakes, steering, airbags, propulsion or equivalent safety-critical actuators without a separately certified architecture and OEM authorization.
