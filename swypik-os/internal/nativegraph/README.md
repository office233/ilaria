# nativegraph

`nativegraph` is a narrow adapter from the validated Go
`devicesynth.HardwareManifest` model to the native seed
`SwypDeviceGraph` wire-v1 format.

It is **not** a driver installer, capability store, discovery layer, or general
hardware serializer. It does not mint rights or grant OS authority.

## API

```go
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

`Encode` always calls the existing
`HardwareManifest.Validate()` first and then the existing
`devicesynth.HardwareBindingHash`. No second manifest validator,
capability database, trust store, or authorization mechanism is introduced.

## Seed-only contract

The current bridge intentionally supports only the native seed subset:

- architecture: `x86_64`;
- endianness: little endian;
- x86_64 ABI identity: `win64` or `sysv-amd64`;
- wire version: 1;
- header/node/resource/edge sizes: 24/96/40/24 bytes;
- cardinality limits: 32 nodes, 64 resources, 64 edges.

Everything outside that subset fails closed.

The ABI string is identity/binding metadata rather than a device-graph wire
field, but unknown ABI identities are still rejected instead of being silently
dropped.

### Bus mapping

The seed carries only a bus **kind** in each node, not a bus-instance ID or bus
hierarchy. Therefore:

| devicesynth | seed |
| --- | --- |
| `PCI` / `PCIE` | `SWYP_DEVICE_BUS_PCI` |
| `USB` | `SWYP_DEVICE_BUS_USB` |
| `PLATFORM` | `SWYP_DEVICE_BUS_PLATFORM` |

`PCIE` is treated as the seed PCI bus family. Bus parents are rejected.
Two distinct Go bus descriptors that collapse to the same seed bus kind are
also rejected because wire-v1 cannot preserve their distinct bus-instance
identity. All other Go bus kinds are unsupported by this seed adapter.

Every encoded device must reference one of the supported buses; an empty bus is
not silently rewritten to `UNKNOWN`.

### Device-class mapping

The adapter accepts exact seed-representable Go classes:

- storage, network, display, input, audio, camera, power, compute.

Camera maps to the seed's `CAMERA_SENSOR` family. Go
`UNKNOWN` and any future/unrecognized class are rejected rather than
encoded as native `UNKNOWN`.

### Numeric identity

Native wire-v1 requires a non-zero `uint64` node ID while the Go graph
uses textual logical IDs plus a privacy-safe stable identity.

The mapping is:

```text
LE64(SHA-256(
  "swypik.nativegraph.node/v1" || 0x00 ||
  HardwareBindingHash         || 0x00 ||
  DeviceIdentity.StableID
)[0:8])
```

The existing hardware binding hash is ordering-stable and excludes probe-source
metadata. Because the binding participates in the numeric ID, any semantic
hardware-binding change intentionally rebinds native IDs. Input slice reorder
does not.

ID zero is rejected. Any 64-bit truncation collision is rejected; there is no
retry/salt scheme that could make mapping order-dependent. The returned
`NodeMapping` is the exact map used by resources and edges.

Optional `VendorID` and `ProductID` are parsed as unsigned
hexadecimal into native `uint32` fields; `Revision` is
unsigned hexadecimal `uint8`. Both plain hexadecimal and `0x`
prefix forms are accepted. Values must be canonical: surrounding whitespace
and signs are rejected. Empty optional values stay zero. Overflow or
non-hexadecimal content fails closed.

No arbitrary property is interpreted as a native identity field.

### Native node fields deliberately left zero

The current Go model has no exact typed source for these seed fields:

- node flags;
- PCI class/subclass/prog-if;
- interface count;
- IOMMU group;
- feature bits;
- firmware-version string;
- model string.

They remain canonical zero/empty. The adapter does **not** scrape
`Properties`, firmware digests, probe metadata, or serial material to
guess these fields. This prevents private discovery data from being copied into
wire/log output and avoids inventing semantics.

### Resources and rights

All seven existing Go resource kinds map one-to-one to the current seed kinds:

`MMIO`, `PORT_IO`, `IRQ`, `DMA`,
`CONFIG`, `DEVICE_CONTROL`, and `SHARED_MEMORY`.

The already validated `Flags`, `Start`, `Length`,
and `Aux` values are preserved exactly. Resource ordering is canonical.

There is intentionally no rights field in the adapter result or wire mapping.
The Go `DeviceResource` is inventory, not a grant. The existing kernel
capability path remains the authority boundary. The adapter never calls a
capability minting API and never promotes `HardwareBindingHash` to an
authorization token.

### Edge mapping

Only these exact relation strings are supported:

| Go relation | seed |
| --- | --- |
| `contains` | `SWYP_DEVICE_EDGE_CONTAINS` |
| `depends-on` | `SWYP_DEVICE_EDGE_DEPENDS_ON` |
| `interrupts` | `SWYP_DEVICE_EDGE_INTERRUPTS` |
| `clocked-by` | `SWYP_DEVICE_EDGE_CLOCKED_BY` |
| `powered-by` | `SWYP_DEVICE_EDGE_POWERED_BY` |

Unknown relations fail closed. Native `parent_id` stays zero because
the Go model has no separate device-parent field; hierarchy is represented only
by explicit `contains` edges.

## Determinism

After existing semantic validation and numeric-ID derivation:

- nodes are ordered by native numeric ID;
- resources are ordered by node ID, kind, flags, start, length, aux;
- edges are ordered by from ID, to ID, kind, flags.

Consequently reordering manifest slices does not change the wire or returned
mapping.

## Real C-decoder conformance

From the repository root:

```powershell
python scripts\verify-nativegraph-wire.py
```

The harness creates only synthetic data in a private temporary directory. It:

1. runs the Go package tests;
2. asks a Go test fixture to write a wire-v1 blob and expected decoded fields;
3. locates an already-existing C compiler, preferring the workspace
   `.tools/zig-*` compiler and otherwise checking PATH/WSL;
4. compiles `kernel/tests/nativegraph_wire_probe.c` together with the
   existing `kernel/src/core/device_graph.c` decoder and its existing
   capability source dependency;
5. invokes `swyp_device_graph_decode` in userspace;
6. compares every decoded fixture field to the Go expectation.

The probe does not copy the decoder or validator. If no existing C compiler is
available, the harness exits non-zero with `status=UNAVAILABLE` rather
than treating the missing proof as PASS.

This is a wire-codec/conformance test only. It proves neither device discovery,
boot integration, driver operation, installation, nor universal hardware
support.
