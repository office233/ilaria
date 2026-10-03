# AGENTS.md — SwypikOS

SwypikOS owns machine authority: Control Kernel, capabilities, leases,
recovery, Compute Fabric, devices/drivers, sandboxing, platform/runtime and UI.

Ilaria is a cognitive provider, not an authority source. Swyp plans/contracts
must pass through the OS capability and verification boundaries.

The first-party native kernel seed lives under `kernel/`. The Linux path is a
reference/prototype path and must not be confused with the production kernel
decision.

Required gate:

```powershell
go vet ./...
go test -count=1 -timeout 180s ./...
```

Do not read or expose user secrets. Do not deploy/push without explicit owner
approval.
