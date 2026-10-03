# Worker 4 — Round 2: native device-graph wire adapter

State: COMPLETE

## Workspace / branch

- ChatGPT Bridge MCP access verified for `E:\\nexus`.
- Branch observed and preserved throughout: `codex/nexus-supervisor-v3`.
- Existing dirty/untracked work was preserved. No reset/clean, branch switch, stage/commit, push, deploy or publication was performed.
- Read before edits: root `AGENTS.md`, `swypik-os/AGENTS.md`, current coordination `README.md`, current `coordinator.md`, current worker reports, seed `device_graph.h` / `device_graph.c`, and the Go `devicesynth` manifest/validation model.
- `swypik-os/kernel/AGENTS.md` does not exist; root/product instructions applied to the kernel test addition.
- Original Worker 4 energy files and `worker-4.md` remained untouched after their prior handoff to Worker 5.
- No secrets, private/user data, corpus/checkpoint/weights, active training files, drivers, installer state, or system permissions were read or modified.

## Final changed files / released ownership

Worker 4-R2 now releases exactly these new files and will not edit them further:

- `swypik-os/internal/nativegraph/encode.go`
- `swypik-os/internal/nativegraph/identity.go`
- `swypik-os/internal/nativegraph/encode_test.go`
- `swypik-os/internal/nativegraph/README.md`
- `swypik-os/kernel/tests/nativegraph_wire_probe.c`
- `scripts/verify-nativegraph-wire.py`
- `docs/coordination/chrome-2026-10-01/worker-4-r2.md`

No kernel implementation/header, devicesynth implementation, installer, driver, CLI/supervisor, energy, or Worker 5 integration file was modified.

## Stable public API

Package: `swypik-os/internal/nativegraph`.

```go
const (
    WireMagic         = uint32(0x47445753)
    WireVersion       = uint16(1)
    WireHeaderBytes   = 24
    WireNodeBytes     = 96
    WireResourceBytes = 40
    WireEdgeBytes     = 24

    MaxNodes     = 32
    MaxResources = 64
    MaxEdges     = 64
)

type NodeMapping struct {
    DeviceID string
    StableID string
    NativeID uint64
}

type Result struct {
    Wire                []byte
    HardwareBindingHash string
    Nodes               []NodeMapping
}

func Encode(manifest devicesynth.HardwareManifest) (Result, error)
```

`Encode` calls the existing `HardwareManifest.Validate()` first and then the existing `devicesynth.HardwareBindingHash`. It introduces no second manifest authority, capability store, grant database, or trust root.

## Seed-v1 supported subset

The adapter is deliberately narrow and fail-closed:

- architecture must be `x86_64`;
- endianness must be `little`;
- ABI identity must be `win64` or `sysv-amd64`;
- native wire version is 1;
- exact wire record sizes are 24/96/40/24 bytes for header/node/resource/edge;
- native cardinality limits are 32 nodes, 64 resources, 64 edges.

Unknown or lossy architecture/ABI/bus/class/relation/resource/identity representations are rejected rather than guessed.

### Bus mapping

- Go `PCI` and `PCIE` -> native `SWYP_DEVICE_BUS_PCI` family.
- Go `USB` -> native `SWYP_DEVICE_BUS_USB`.
- Go `PLATFORM` -> native `SWYP_DEVICE_BUS_PLATFORM`.
- Bus parents are rejected because wire-v1 has no bus hierarchy field.
- Two distinct Go bus descriptors that collapse to the same native bus enum are rejected because wire-v1 cannot preserve their distinct bus-instance identity.
- Empty/unmapped device bus references are rejected.

### Device-class mapping

Supported exact seed classes: storage, network, display, input, audio, camera (`CAMERA_SENSOR` family), power, compute. `UNKNOWN` and future/unrecognized classes are rejected.

### Deterministic numeric node identity

Native node IDs are derived as:

```text
LE64(SHA-256(
  "swypik.nativegraph.node/v1" || 0x00 ||
  HardwareBindingHash          || 0x00 ||
  DeviceIdentity.StableID
)[0:8])
```

The existing hardware binding hash is ordering-stable. A semantic hardware-binding change rebinds native IDs; input slice reorder does not. Native ID zero is rejected. Any 64-bit truncation collision is rejected with no retry/salt fallback, so mapping cannot become order-dependent. `NodeMapping` exposes the exact logical/stable/native mapping used by resource and edge references.

`VendorID` and `ProductID` are optional canonical unsigned hexadecimal `uint32` values; `Revision` is optional canonical unsigned hexadecimal `uint8`. Plain hex and `0x` prefix are accepted. Surrounding whitespace, signs, malformed values, and overflow fail closed.

### Fields deliberately not guessed/copied

Wire-v1 fields without an exact typed source in the current Go model remain canonical zero/empty: node flags, PCI class/subclass/prog-if, interface count, IOMMU group, feature bits, firmware-version string, and model string.

The adapter does not scrape arbitrary `Properties`, serial digest, firmware digest, probe source/version, or other discovery metadata into native string/identity fields. Such semantic manifest data still participates in the existing `HardwareBindingHash`; tests prove that a property change rebinds native IDs without copying the raw property into wire.

## Resources, rights, and authority boundary

All seven existing Go resource kinds map one-to-one to current seed kinds: MMIO, PORT_IO, IRQ, DMA, CONFIG, DEVICE_CONTROL, SHARED_MEMORY.

The already validated resource `Flags`, `Start`, `Length`, and `Aux` values are preserved exactly and canonicalized only by ordering. Resource/node references use the deterministic numeric node mapping.

No rights are synthesized or widened. `devicesynth.DeviceResource` remains inventory, not authority; the adapter has no rights/grant field and never calls capability minting APIs. Existing kernel capability logic remains the authority boundary. `HardwareBindingHash` is returned as identity/evidence and is never promoted to authorization.

## Edge mapping

Only exact relations are accepted:

- `contains` -> `SWYP_DEVICE_EDGE_CONTAINS`
- `depends-on` -> `SWYP_DEVICE_EDGE_DEPENDS_ON`
- `interrupts` -> `SWYP_DEVICE_EDGE_INTERRUPTS`
- `clocked-by` -> `SWYP_DEVICE_EDGE_CLOCKED_BY`
- `powered-by` -> `SWYP_DEVICE_EDGE_POWERED_BY`

Unknown relations fail closed. Native `parent_id` remains zero because the Go model has no separate device-parent field; hierarchy is represented only through explicit `contains` edges.

## Deterministic ordering

- nodes: native numeric ID;
- resources: node ID, kind, flags, start, length, aux;
- edges: from ID, to ID, kind, flags.

Reordering buses/devices/resources/edges/firmware/properties in the validated manifest does not change `HardwareBindingHash`, output wire, or node mapping.

## Real C decoder conformance

`swypik-os/kernel/tests/nativegraph_wire_probe.c` is a userspace-only probe. It includes the native header and calls the existing `swyp_device_graph_decode`; it does not copy/reimplement the decoder or validator.

`scripts/verify-nativegraph-wire.py` creates only synthetic worker-owned temporary fixtures, asks Go to encode them, compiles the new probe together with the existing `kernel/src/core/device_graph.c` (and existing `capability.c` only to satisfy that translation unit's existing link dependency), invokes the real C decoder, and compares every decoded node/resource/edge field with the Go fixture expectation.

Compiler discovery uses only already-present tools: explicit `NATIVEGRAPH_CC`, workspace `.tools/zig-*`, PATH, then WSL. Missing compiler returns non-zero `status=UNAVAILABLE`; the harness never reports a missing proof as PASS.

### Actual C proof

Command:

```powershell
python scripts\verify-nativegraph-wire.py
```

Actual final result: exit 0:

```json
{"c_decoder":"PASS","comparison":"PASS","compiler":"E:\\nexus\\.tools\\zig-0.16.0\\zig.exe","edge_count":2,"go_fixture":"PASS","node_count":2,"resource_count":7,"status":"PASS","wire_bytes":544}
```

Existing compiler version probe: `E:\\nexus\\.tools\\zig-0.16.0\\zig.exe version` -> `0.16.0`.

The 544-byte fixture is exactly `24 + 2*96 + 7*40 + 2*24`. The C executable decoded the Go-produced bytes with the repository's real decoder and the harness matched all decoded fields.

No boot, device discovery, physical hardware access, admin/root action, driver install, permission change, or system mutation occurred.

## Synthetic acceptance coverage

Go fixtures cover:

- exact 24/96/40/24 byte layouts and reserved-zero bytes;
- exact 544-byte synthetic wire and header counts;
- all seven resource kinds with exact flags/start/length/aux preservation;
- deterministic reorder invariance;
- hardware-binding rebind from semantic data that is not copied raw into wire;
- >32 nodes, >64 resources, >64 edges fail closed;
- invalid resource and edge references fail through existing manifest validation;
- zero numeric ID and injected numeric-ID collision fail closed;
- unsupported architecture, endianness, ABI, bus, bus hierarchy, collapsed bus-instance identity, device class, edge relation, and resource kind;
- malformed/overflow/noncanonical vendor/product/revision identity;
- raw synthetic private property marker, serial digest, firmware digest, and probe metadata are absent from wire;
- exact resource/edge enum mapping.

## Verification evidence

Focused Go / Python:

- `gofmt -w internal/nativegraph/encode.go internal/nativegraph/identity.go internal/nativegraph/encode_test.go` — PASS.
- `go test -count=1 ./internal/nativegraph ./core/devicesynth` — PASS (`nativegraph` and existing semantic-validator package both passed).
- `go vet ./internal/nativegraph ./core/devicesynth` — PASS.
- `python -m py_compile scripts\\verify-nativegraph-wire.py` — PASS.
- `python scripts\\verify-nativegraph-wire.py` — PASS with real C decoder comparison described above.
- `GOOS=linux GOARCH=amd64 GOWORK=off go test -mod=readonly -c ... ./internal/nativegraph` using a worker-named file under `%TEMP%` — PASS; no global environment change.

Required SwypikOS product gates on the final working tree:

- `go vet ./...` — PASS.
- `go test -count=1 -timeout 180s ./...` — PASS: **52 packages OK, 0 failed**; includes `swypik-os/internal/nativegraph`.

Final hygiene:

- `git diff --check` from `E:\\nexus` — PASS. Git emitted only line-ending warnings for unrelated pre-existing tracked documentation files (`swypik-os/README.md`, `docs/UNIVERSAL_NATIVE.md`, `docs/WINDOWS_DESKTOP.md`).
- `gofmt -d internal/nativegraph/encode.go internal/nativegraph/identity.go internal/nativegraph/encode_test.go` — no output.
- Scoped `git status --short` showed exactly the seven Worker 4-R2 claimed files as untracked.

## Limitations / non-claims

- This is only a codec/mapping bridge for the current seed-v1 x86_64/little-endian subset.
- It does not support all devicesynth bus types, native bus hierarchy, multiple distinct bus instances that collapse to one seed bus enum, ARM64/RISC-V, or arbitrary future semantics.
- Native fields without an exact Go source stay zero rather than being inferred.
- The C proof is userspace encode/decode conformance on synthetic fixtures only.
- It does not prove kernel boot integration, hardware discovery, real-device access, driver correctness, installation, universal hardware support, or capability authorization.
- It creates no second authority/capability store and grants no ambient OS authority.

## Handoff

Worker 4-R2 releases the seven files listed above for coordinator/integrator review. The stable consumer entry point is `nativegraph.Encode`. Consumers must treat `HardwareBindingHash` and `NodeMapping` as identity/evidence only and must preserve the existing capability/rights authority path separately.
