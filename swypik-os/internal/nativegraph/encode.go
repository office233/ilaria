// Package nativegraph encodes the supported devicesynth manifest subset into
// the native seed device-graph wire format. It is inventory translation only;
// it does not mint capabilities, rights, leases, or any other authority.
package nativegraph

import (
	"encoding/binary"
	"fmt"
	"sort"

	"swypik-os/core/devicesynth"
)

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

const (
	nativeClassStorage uint16 = 1
	nativeClassNetwork uint16 = 2
	nativeClassDisplay uint16 = 3
	nativeClassInput   uint16 = 4
	nativeClassAudio   uint16 = 5
	nativeClassCamera  uint16 = 6
	nativeClassPower   uint16 = 7
	nativeClassCompute uint16 = 9
)

const (
	nativeBusPCI      uint16 = 1
	nativeBusUSB      uint16 = 2
	nativeBusPlatform uint16 = 6
)

const (
	nativeResourceMMIO          uint16 = 1
	nativeResourcePortIO        uint16 = 2
	nativeResourceIRQ           uint16 = 3
	nativeResourceDMA           uint16 = 4
	nativeResourceConfig        uint16 = 5
	nativeResourceDeviceControl uint16 = 6
	nativeResourceSharedMemory  uint16 = 7
)

const (
	nativeEdgeContains   uint16 = 1
	nativeEdgeDependsOn  uint16 = 2
	nativeEdgeInterrupts uint16 = 3
	nativeEdgeClockedBy  uint16 = 4
	nativeEdgePoweredBy  uint16 = 5
)

// NodeMapping records the exact logical-to-native identifier mapping used by
// node, resource, and edge records. StableID is already the privacy-safe stable
// identifier required by HardwareManifest.Validate; no probe properties or raw
// serial data are added here.
type NodeMapping struct {
	DeviceID string
	StableID string
	NativeID uint64
}

// Result contains seed-v1 wire bytes plus the existing devicesynth hardware
// binding that the deterministic numeric identifiers are derived from.
// HardwareBindingHash is evidence/identity, not authorization.
type Result struct {
	Wire                []byte
	HardwareBindingHash string
	Nodes               []NodeMapping
}

type nativeNode struct {
	id        uint64
	class     uint16
	bus       uint16
	vendorID  uint32
	deviceID  uint32
	revision  uint8
	logicalID string
	stableID  string
}

type nativeResource struct {
	nodeID uint64
	kind   uint16
	flags  uint16
	start  uint64
	length uint64
	aux    uint64
}

type nativeEdge struct {
	fromID uint64
	toID   uint64
	kind   uint16
	flags  uint16
}

// Encode validates the existing manifest semantics, narrows them to the exact
// x86_64/little-endian seed subset, and emits deterministic native wire v1.
func Encode(manifest devicesynth.HardwareManifest) (Result, error) {
	return encodeWithNodeID(manifest, deriveNativeNodeID)
}

func encodeWithNodeID(manifest devicesynth.HardwareManifest, idFor nodeIDFunc) (Result, error) {
	if idFor == nil {
		return Result{}, fmt.Errorf("nativegraph: nil node id mapper")
	}
	if err := manifest.Validate(); err != nil {
		return Result{}, fmt.Errorf("nativegraph: invalid hardware manifest: %w", err)
	}
	if manifest.Architecture != devicesynth.ArchX8664 {
		return Result{}, fmt.Errorf("nativegraph: seed wire supports architecture %q only, got %q", devicesynth.ArchX8664, manifest.Architecture)
	}
	if manifest.Endianness != devicesynth.EndianLittle {
		return Result{}, fmt.Errorf("nativegraph: seed wire supports little-endian manifests only, got %q", manifest.Endianness)
	}
	if !supportedSeedABI(manifest.ABI) {
		return Result{}, fmt.Errorf("nativegraph: seed wire does not support x86_64 ABI %q", manifest.ABI)
	}
	if len(manifest.Graph.Devices) > MaxNodes {
		return Result{}, fmt.Errorf("nativegraph: device count %d exceeds seed limit %d", len(manifest.Graph.Devices), MaxNodes)
	}
	if len(manifest.Graph.Resources) > MaxResources {
		return Result{}, fmt.Errorf("nativegraph: resource count %d exceeds seed limit %d", len(manifest.Graph.Resources), MaxResources)
	}
	if len(manifest.Graph.Edges) > MaxEdges {
		return Result{}, fmt.Errorf("nativegraph: edge count %d exceeds seed limit %d", len(manifest.Graph.Edges), MaxEdges)
	}

	bindingHash, err := devicesynth.HardwareBindingHash(manifest)
	if err != nil {
		return Result{}, fmt.Errorf("nativegraph: hardware binding hash: %w", err)
	}
	busByID, err := nativeBuses(manifest.Graph.Buses)
	if err != nil {
		return Result{}, err
	}

	nodes := make([]nativeNode, 0, len(manifest.Graph.Devices))
	nativeIDByLogical := make(map[string]uint64, len(manifest.Graph.Devices))
	logicalByNativeID := make(map[uint64]string, len(manifest.Graph.Devices))
	for _, device := range manifest.Graph.Devices {
		class, err := nativeDeviceClass(device.Kind)
		if err != nil {
			return Result{}, fmt.Errorf("nativegraph: device %q: %w", device.ID, err)
		}
		bus, ok := busByID[device.BusID]
		if device.BusID == "" || !ok {
			return Result{}, fmt.Errorf("nativegraph: device %q has missing or unrepresentable bus %q", device.ID, device.BusID)
		}
		vendor, err := parseOptionalHex(device.Identity.VendorID, "vendor_id", 32)
		if err != nil {
			return Result{}, fmt.Errorf("nativegraph: device %q: %w", device.ID, err)
		}
		product, err := parseOptionalHex(device.Identity.ProductID, "product_id", 32)
		if err != nil {
			return Result{}, fmt.Errorf("nativegraph: device %q: %w", device.ID, err)
		}
		revision, err := parseOptionalHex(device.Identity.Revision, "revision", 8)
		if err != nil {
			return Result{}, fmt.Errorf("nativegraph: device %q: %w", device.ID, err)
		}

		nativeID := idFor(bindingHash, device.Identity.StableID)
		if nativeID == 0 {
			return Result{}, fmt.Errorf("nativegraph: device %q mapped to forbidden native node id 0", device.ID)
		}
		if previous, exists := logicalByNativeID[nativeID]; exists {
			return Result{}, fmt.Errorf("nativegraph: native node id collision %#x between %q and %q", nativeID, previous, device.ID)
		}
		logicalByNativeID[nativeID] = device.ID
		nativeIDByLogical[device.ID] = nativeID
		nodes = append(nodes, nativeNode{
			id:        nativeID,
			class:     class,
			bus:       bus,
			vendorID:  uint32(vendor),
			deviceID:  uint32(product),
			revision:  uint8(revision),
			logicalID: device.ID,
			stableID:  device.Identity.StableID,
		})
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].id < nodes[j].id })

	resources := make([]nativeResource, 0, len(manifest.Graph.Resources))
	for index, resource := range manifest.Graph.Resources {
		nodeID, ok := nativeIDByLogical[resource.DeviceID]
		if !ok {
			return Result{}, fmt.Errorf("nativegraph: resource %d references unmapped device %q", index, resource.DeviceID)
		}
		kind, err := nativeResourceKind(resource.Kind)
		if err != nil {
			return Result{}, fmt.Errorf("nativegraph: resource %d: %w", index, err)
		}
		resources = append(resources, nativeResource{
			nodeID: nodeID,
			kind:   kind,
			flags:  resource.Flags,
			start:  resource.Start,
			length: resource.Length,
			aux:    resource.Aux,
		})
	}
	sort.Slice(resources, func(i, j int) bool {
		a, b := resources[i], resources[j]
		if a.nodeID != b.nodeID {
			return a.nodeID < b.nodeID
		}
		if a.kind != b.kind {
			return a.kind < b.kind
		}
		if a.flags != b.flags {
			return a.flags < b.flags
		}
		if a.start != b.start {
			return a.start < b.start
		}
		if a.length != b.length {
			return a.length < b.length
		}
		return a.aux < b.aux
	})

	edges := make([]nativeEdge, 0, len(manifest.Graph.Edges))
	for index, edge := range manifest.Graph.Edges {
		fromID, fromOK := nativeIDByLogical[edge.From]
		toID, toOK := nativeIDByLogical[edge.To]
		if !fromOK || !toOK {
			return Result{}, fmt.Errorf("nativegraph: edge %d references unmapped devices %q -> %q", index, edge.From, edge.To)
		}
		kind, err := nativeEdgeKind(edge.Relation)
		if err != nil {
			return Result{}, fmt.Errorf("nativegraph: edge %d: %w", index, err)
		}
		edges = append(edges, nativeEdge{fromID: fromID, toID: toID, kind: kind})
	}
	sort.Slice(edges, func(i, j int) bool {
		a, b := edges[i], edges[j]
		if a.fromID != b.fromID {
			return a.fromID < b.fromID
		}
		if a.toID != b.toID {
			return a.toID < b.toID
		}
		if a.kind != b.kind {
			return a.kind < b.kind
		}
		return a.flags < b.flags
	})

	wire := encodeWire(nodes, resources, edges)
	mappings := make([]NodeMapping, len(nodes))
	for i, node := range nodes {
		mappings[i] = NodeMapping{DeviceID: node.logicalID, StableID: node.stableID, NativeID: node.id}
	}
	return Result{Wire: wire, HardwareBindingHash: bindingHash, Nodes: mappings}, nil
}

func supportedSeedABI(abi string) bool {
	switch abi {
	case "win64", "sysv-amd64":
		return true
	default:
		return false
	}
}

func nativeBuses(buses []devicesynth.BusDescriptor) (map[string]uint16, error) {
	byID := make(map[string]uint16, len(buses))
	ownerByNativeKind := make(map[uint16]string, len(buses))
	for _, bus := range buses {
		if bus.ParentID != "" {
			return nil, fmt.Errorf("nativegraph: bus %q parent %q is not representable by seed wire v1", bus.ID, bus.ParentID)
		}
		kind, err := nativeBusKind(bus.Kind)
		if err != nil {
			return nil, fmt.Errorf("nativegraph: bus %q: %w", bus.ID, err)
		}
		if previous, exists := ownerByNativeKind[kind]; exists {
			return nil, fmt.Errorf("nativegraph: buses %q and %q collapse to the same seed bus kind %d", previous, bus.ID, kind)
		}
		ownerByNativeKind[kind] = bus.ID
		byID[bus.ID] = kind
	}
	return byID, nil
}

func nativeBusKind(kind devicesynth.BusKind) (uint16, error) {
	switch kind {
	case devicesynth.BusPCI, devicesynth.BusPCIe:
		return nativeBusPCI, nil
	case devicesynth.BusUSB:
		return nativeBusUSB, nil
	case devicesynth.BusPlatform:
		return nativeBusPlatform, nil
	default:
		return 0, fmt.Errorf("bus kind %q is not representable by seed wire v1", kind)
	}
}

func nativeDeviceClass(kind devicesynth.DeviceKind) (uint16, error) {
	switch kind {
	case devicesynth.DeviceStorage:
		return nativeClassStorage, nil
	case devicesynth.DeviceNetwork:
		return nativeClassNetwork, nil
	case devicesynth.DeviceDisplay:
		return nativeClassDisplay, nil
	case devicesynth.DeviceInput:
		return nativeClassInput, nil
	case devicesynth.DeviceAudio:
		return nativeClassAudio, nil
	case devicesynth.DeviceCamera:
		return nativeClassCamera, nil
	case devicesynth.DevicePower:
		return nativeClassPower, nil
	case devicesynth.DeviceCompute:
		return nativeClassCompute, nil
	default:
		return 0, fmt.Errorf("device class %q is not representable by seed wire v1", kind)
	}
}

func nativeResourceKind(kind devicesynth.DeviceResourceKind) (uint16, error) {
	switch kind {
	case devicesynth.ResourceMMIO:
		return nativeResourceMMIO, nil
	case devicesynth.ResourcePortIO:
		return nativeResourcePortIO, nil
	case devicesynth.ResourceIRQ:
		return nativeResourceIRQ, nil
	case devicesynth.ResourceDMA:
		return nativeResourceDMA, nil
	case devicesynth.ResourceConfig:
		return nativeResourceConfig, nil
	case devicesynth.ResourceDeviceControl:
		return nativeResourceDeviceControl, nil
	case devicesynth.ResourceSharedMemory:
		return nativeResourceSharedMemory, nil
	default:
		return 0, fmt.Errorf("resource kind %q is not representable by seed wire v1", kind)
	}
}

func nativeEdgeKind(relation string) (uint16, error) {
	switch relation {
	case "contains":
		return nativeEdgeContains, nil
	case "depends-on":
		return nativeEdgeDependsOn, nil
	case "interrupts":
		return nativeEdgeInterrupts, nil
	case "clocked-by":
		return nativeEdgeClockedBy, nil
	case "powered-by":
		return nativeEdgePoweredBy, nil
	default:
		return 0, fmt.Errorf("edge relation %q is not representable by seed wire v1", relation)
	}
}

func encodeWire(nodes []nativeNode, resources []nativeResource, edges []nativeEdge) []byte {
	total := WireHeaderBytes + len(nodes)*WireNodeBytes + len(resources)*WireResourceBytes + len(edges)*WireEdgeBytes
	wire := make([]byte, total)
	binary.LittleEndian.PutUint32(wire[0:4], WireMagic)
	binary.LittleEndian.PutUint16(wire[4:6], WireVersion)
	binary.LittleEndian.PutUint16(wire[6:8], WireHeaderBytes)
	binary.LittleEndian.PutUint32(wire[8:12], uint32(total))
	binary.LittleEndian.PutUint16(wire[12:14], uint16(len(nodes)))
	binary.LittleEndian.PutUint16(wire[14:16], uint16(len(resources)))
	binary.LittleEndian.PutUint16(wire[16:18], uint16(len(edges)))

	offset := WireHeaderBytes
	for _, node := range nodes {
		binary.LittleEndian.PutUint64(wire[offset+0:offset+8], node.id)
		// parent_id is intentionally zero: devicesynth has no exact node-parent
		// field; hierarchy is represented only by explicit "contains" edges.
		binary.LittleEndian.PutUint16(wire[offset+16:offset+18], node.class)
		binary.LittleEndian.PutUint16(wire[offset+18:offset+20], node.bus)
		binary.LittleEndian.PutUint32(wire[offset+24:offset+28], node.vendorID)
		binary.LittleEndian.PutUint32(wire[offset+28:offset+32], node.deviceID)
		wire[offset+35] = node.revision
		// All other native node fields remain canonical zero. There is no exact
		// devicesynth source for them and arbitrary properties/private discovery
		// data must not be copied into the native wire.
		offset += WireNodeBytes
	}
	for _, resource := range resources {
		binary.LittleEndian.PutUint64(wire[offset+0:offset+8], resource.nodeID)
		binary.LittleEndian.PutUint16(wire[offset+8:offset+10], resource.kind)
		binary.LittleEndian.PutUint16(wire[offset+10:offset+12], resource.flags)
		binary.LittleEndian.PutUint64(wire[offset+16:offset+24], resource.start)
		binary.LittleEndian.PutUint64(wire[offset+24:offset+32], resource.length)
		binary.LittleEndian.PutUint64(wire[offset+32:offset+40], resource.aux)
		offset += WireResourceBytes
	}
	for _, edge := range edges {
		binary.LittleEndian.PutUint64(wire[offset+0:offset+8], edge.fromID)
		binary.LittleEndian.PutUint64(wire[offset+8:offset+16], edge.toID)
		binary.LittleEndian.PutUint16(wire[offset+16:offset+18], edge.kind)
		binary.LittleEndian.PutUint16(wire[offset+18:offset+20], edge.flags)
		offset += WireEdgeBytes
	}
	return wire
}
