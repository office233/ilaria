# Worker 4 — real optional energy counters

State: COMPLETE

## Workspace / branch

- MCP access verified for `E:\\nexus`.
- Branch observed and preserved: `codex/nexus-supervisor-v3`.
- Existing modified/untracked work was preserved. No branch/index/history change, reset/clean, stage/commit, push, deploy or publication was performed.
- Read before edits: root `AGENTS.md`, `swypik-os/AGENTS.md`, `docs/milestones/supervisor-v2.md`, coordination README, and active Worker 1/2/3 reports; Worker 5's report was read after it appeared.
- Product boundary held: this worker wrote only new `swypik-os/core/resource/energy*` files plus this report. No existing resource file, supervisor, CLI, benchmark, Swyp or Ilaria file was edited.

## Final changed files / handoff ownership

Worker 4 now hands these files to Worker 5 and will not edit them further:

- `swypik-os/core/resource/energy.go` (new)
- `swypik-os/core/resource/energy_linux.go` (new)
- `swypik-os/core/resource/energy_windows.go` (new)
- `swypik-os/core/resource/energy_other.go` (new)
- `swypik-os/core/resource/energy_test.go` (new)
- `swypik-os/core/resource/energy_linux_test.go` (new)
- `swypik-os/core/resource/energy_windows_test.go` (new)
- `docs/coordination/chrome-2026-10-01/worker-4.md`

No existing code file was claimed or modified.

## Stable public API for Worker 5

Package: `swypik-os/core/resource`.

```go
type EnergyStatus string

const (
    EnergyStatusAvailable   EnergyStatus = "available"
    EnergyStatusUnavailable EnergyStatus = "unavailable"
)

type EnergyUnit string

const (
    EnergyUnitMicrojoule    EnergyUnit = "microjoule"
    EnergyUnitPicowattHour  EnergyUnit = "picowatt_hour"
)

type EnergyDeltaStatus string

const (
    EnergyDeltaBaseline    EnergyDeltaStatus = "baseline"
    EnergyDeltaMeasured    EnergyDeltaStatus = "measured"
    EnergyDeltaUnavailable EnergyDeltaStatus = "unavailable"
)

type EnergyCounterSample struct {
    ID                  string
    Status              EnergyStatus
    Reason              string
    Source              string
    Scope               string
    Domain              string
    Unit                EnergyUnit
    Counter             uint64
    CounterRange        uint64
    ObservedAt          time.Time
    SourceTimestamp     uint64
    SourceTimestampUnit string
    DeltaStatus         EnergyDeltaStatus
    DeltaReason         string
    DeltaJoules         float64
    Interval            time.Duration
}

type EnergySample struct {
    Status   EnergyStatus
    Reason   string
    Counters []EnergyCounterSample
}

func NewEnergySampler() *EnergySampler
func (s *EnergySampler) Sample() EnergySample
func (s *EnergySampler) Close() error
```

Consumer rules:

- Construction starts no goroutine, ticker or periodic sampler. Discovery and reads happen only on `Sample`.
- The first valid observation of each counter is `DeltaStatus == "baseline"`; it is not a zero-joule measurement.
- `DeltaStatus == "measured"` is emitted only from two real compatible observations with a monotonic interval and monotonic raw cumulative counter. `DeltaJoules == 0` remains a valid measured zero delta and is serialized explicitly.
- `Source`, `Scope`, `Domain`, raw `Unit`, raw `Counter`, observation timestamp, source timestamp where the OS supplies one, interval and raw range are preserved. The API never changes a package/system/channel counter into process energy.
- A counter decrease with a reported range is `counter_decreased_wrap_or_reset`; without a range it is `counter_decreased_or_reset`. Because the available APIs do not identify whether an observed decrease was a hardware wrap or an external/software reset, no joule delta is fabricated for that interval. The new sample becomes the next baseline.
- An unavailable read breaks continuity, so a later recovery begins at a new baseline rather than spanning an unobserved discontinuity.
- Unsupported platform, absent hardware counter, permission denial, unsupported version/unit, invalid metadata/output and read failure are explicit unavailable states.
- `Close` is idempotent. `Sample` and `Close` are serialized by the sampler mutex.
- Platform discovery is lazy and cached per sampler. Recreate the sampler to intentionally rediscover hot-plugged/newly-permitted counters.

## Real platform backends

### Linux

Source: Linux kernel powercap sysfs ABI.

Primary documentation:
- https://cdn.kernel.org/doc/html/latest/power/powercap/powercap.html
- kernel ABI exposes `energy_uj`, `max_energy_range_uj` and zone `name`.

Implementation:
- Uses only zones that actually expose a readable `energy_uj`.
- Raw unit is `microjoule`; `max_energy_range_uj` is preserved as raw counter-range metadata when parseable.
- Source is `linux_powercap`; scope is `powercap_zone`; domain is the kernel zone name; ID carries the zone hierarchy.
- The only product path constant is the kernel-defined ABI root `/sys/class/powercap`; there is no vendor/device/zone path, Intel/AMD name, CPU model or TDP constant in product logic.
- Handles the normal sysfs-class shape where a top-level powercap entry is a symlink to its device tree; synthetic Linux tests prove this path.
- Reads only. It never writes `energy_uj`, changes permissions, invokes sudo/root, or enables/configures a counter.

### Windows

Source: Microsoft Energy Metering Interface (EMI).

Primary documentation:
- https://learn.microsoft.com/en-us/windows-hardware/drivers/powermeter/energy-meter-interface
- https://learn.microsoft.com/en-us/windows/win32/api/emi/ns-emi-emi_channel_measurement_data
- https://learn.microsoft.com/en-us/windows/win32/api/emi/ns-emi-emi_metadata_v1
- https://learn.microsoft.com/en-us/windows/win32/api/emi/ns-emi-emi_metadata_v2
- https://learn.microsoft.com/en-us/windows/win32/api/emi/ns-emi-emi_channel_v2

Implementation:
- Discovers present EMI devices with the documented `GUID_DEVICE_ENERGY_METER` through SetupAPI device interfaces; no concrete hardware/device path is hardcoded.
- Supports EMI V1 and V2 metadata, bounded to 1 MiB metadata and 4096 channels before allocation.
- Accepts only the currently documented `EmiMeasurementUnitPicowattHours`; unknown future units are unavailable rather than guessed.
- Reads `AbsoluteEnergy` as cumulative picowatt-hours and `AbsoluteTime` as the EMI-provided 100 ns timestamp.
- V1 scope is `metered_hardware`; V2 scope is `emi_channel`; the OS metadata name is preserved as domain.
- Opens read-only EMI handles with ordinary user access. Access denial is reported; there is no elevation, driver installation, service creation or permission mutation.
- E3/SRUM/software estimation is intentionally excluded.

### Other platforms

`energy_other.go` reports `unavailable / unsupported_platform`; it does not estimate.

## What is deliberately not a joule measurement

No code in this handoff converts CPU%, CPU time, TDP, RSS, battery drain, wall-clock time, thermal data, process counters or system/package energy attribution into per-process joules. A whole package/system/channel measurement keeps that hardware/OS scope.

## Verification evidence

Focused Windows-host checks:

- `gofmt -w core/resource/energy.go core/resource/energy_linux.go core/resource/energy_windows.go core/resource/energy_other.go core/resource/energy_test.go core/resource/energy_linux_test.go core/resource/energy_windows_test.go` — PASS.
- `go test -count=1 ./core/resource` — PASS, `ok swypik-os/core/resource`.
- `go vet ./core/resource` — PASS.
- `go test -count=1 -run TestWindowsEnergyCapabilityProbe -v ./core/resource` — PASS; observed capability: `status=unavailable reason=no_counter counters=0`. This workstation did not expose an EMI counter, so no Windows joule measurement is claimed.

Linux compile/runtime checks without installing anything:

- `GOOS=linux GOARCH=amd64 GOWORK=off go vet -mod=readonly ./core/resource` — PASS.
- `GOOS=linux GOARCH=amd64 GOWORK=off go test -mod=readonly -c -o %TEMP%\\swypik-resource-linux.test ./core/resource` — PASS.
- Cross-compiled Linux test binary executed directly in existing WSL2 — PASS:
  - `TestLinuxEnergyReaderPowercapFixture`
  - `TestLinuxEnergyReaderMissingPowercapIsUnavailable`
  - `TestLinuxEnergyReaderFollowsTopLevelClassSymlink`
  - `TestLinuxEnergyCapabilityProbe`
  - all `TestEnergySampler*` synthetic delta/conversion/reset tests
- Real WSL2 capability observation: `status=unavailable reason=no_counter counters=0`. This WSL instance did not expose a powercap energy counter, so no Linux joule measurement is claimed.

SwypikOS gates:

- Final `go vet ./...` — PASS.
- Final `go test -count=1 -timeout 180s ./...` — PASS: **51 packages OK, 0 failed**.
- One earlier concurrent full-suite run transiently failed outside this worker's ownership in `internal/planprocess/TestOutputAndInputBoundsTerminateChild/stderr_limit` with `EOF` instead of the expected output-limit error. No foreign file was edited. Immediate `go test -count=10 -run TestOutputAndInputBoundsTerminateChild ./internal/planprocess` passed, and the final full-suite rerun passed 51/51.
- `git diff --check` from `E:\\nexus` — PASS. Git emitted only pre-existing line-ending warnings for unrelated tracked documentation files.
- `gofmt -d core/resource/energy.go core/resource/energy_linux.go core/resource/energy_windows.go core/resource/energy_other.go core/resource/energy_test.go core/resource/energy_linux_test.go core/resource/energy_windows_test.go` — no output.
- Scoped `git status --short` showed only the eight claimed Worker 4 files as untracked.

Race/LSP limits, reported rather than hidden:

- `go test -race -count=1 ./core/resource` could not run on the Windows host because the configured Go toolchain has `CGO_ENABLED=0`; `go env CC` is `gcc`, but `gcc` is not installed/available. Per task constraints, nothing was installed or enabled.
- The Bridge Go LSP check was unavailable because `gopls` is not installed. No language server was installed. Compiler/vet/tests above are the verification evidence.

## Synthetic coverage

Fixtures explicitly cover:

- no read at construction / on-demand-only behavior;
- first-sample baseline;
- microjoule -> joule delta conversion;
- picowatt-hour -> joule conversion using the EMI 100 ns source timestamp;
- monotonic interval handling;
- counter range preservation;
- decrease with range as wrap-or-reset ambiguity with no fabricated delta;
- decrease without range as reset/discontinuity with no fabricated delta;
- unavailable read breaking continuity and requiring a new baseline;
- metadata identity change breaking continuity;
- idempotent close and safe zero-value sampler;
- Linux powercap discovery, missing counter, top-level sysfs symlink traversal;
- Windows EMI V1/V2 metadata parsing, variable/aligned V2 channel layout handling, unknown unit rejection and malformed UTF-16 metadata rejection.

## Worker 5 integration handoff

Worker 5 can now consume this API.

Recommended integration semantics:

1. Construct one `EnergySampler` for the measurement session and `defer Close()`.
2. Call `Sample()` at the explicit start boundary; accept only a real available counter and treat its delta as baseline.
3. Call `Sample()` at the explicit end boundary; consume `DeltaJoules` only where `DeltaStatus == EnergyDeltaMeasured`.
4. Preserve `Source`, `Scope`, `Domain`, `Unit`, timestamps and interval in evidence. Never relabel package/system/channel energy as process energy.
5. If the requested counter is absent or discontinuous, emit energy unavailable with the concrete reason; do not fall back to CPU%, TDP, RSS, battery or an estimator.
6. Multiple counters can exist. Integration must choose/report the desired hardware scope explicitly rather than sum unrelated/nested domains blindly.

This handoff makes no claim that the current Windows host or WSL2 instance exposed a real energy counter; both capability probes observed `no_counter`.
