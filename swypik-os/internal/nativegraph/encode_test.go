package nativegraph

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"swypik-os/core/devicesynth"
)

func fixtureManifest() devicesynth.HardwareManifest {
	nic := devicesynth.DeviceNode{
		ID:    "nic0",
		Kind:  devicesynth.DeviceNetwork,
		BusID: "pcie0",
		Identity: devicesynth.DeviceIdentity{
			StableID:     devicesynth.PrivacySafeDeviceID("pcie", "fixture-nic", "1234", "5678"),
			VendorID:     "1234",
			ProductID:    "5678",
			Revision:     "0a",
			SerialDigest: devicesynth.HashPrivateIdentifier("synthetic-private-serial"),
		},
		FirmwareDigest: devicesynth.HashBytes([]byte("synthetic-firmware")),
		Properties: []devicesynth.Property{
			{Name: "private-discovery-marker", Value: "DO-NOT-COPY-SYNTHETIC-PRIVATE-DATA"},
			{Name: "protocol", Value: "synthetic"},
		},
	}
	input := devicesynth.DeviceNode{
		ID:    "input0",
		Kind:  devicesynth.DeviceInput,
		BusID: "usb0",
		Identity: devicesynth.DeviceIdentity{
			StableID:  devicesynth.PrivacySafeDeviceID("usb", "fixture-input"),
			VendorID:  "0x00ab",
			ProductID: "00cd",
			Revision:  "01",
		},
	}
	return devicesynth.HardwareManifest{
		SchemaVersion: devicesynth.HardwareManifestSchemaV1,
		DeviceClass:   devicesynth.PlatformWorkstation,
		Architecture:  devicesynth.ArchX8664,
		ABI:           "win64",
		Endianness:    devicesynth.EndianLittle,
		Firmware: []devicesynth.FirmwareDescriptor{
			{Kind: devicesynth.FirmwareUEFI, Version: "2.0", Digest: devicesynth.HashBytes([]byte("uefi"))},
			{Kind: devicesynth.FirmwareACPI, Version: "6.5", Digest: devicesynth.HashBytes([]byte("acpi"))},
		},
		Graph: devicesynth.DeviceGraph{
			SchemaVersion: devicesynth.DeviceGraphSchemaV1,
			Buses: []devicesynth.BusDescriptor{
				{ID: "pcie0", Kind: devicesynth.BusPCIe},
				{ID: "usb0", Kind: devicesynth.BusUSB},
			},
			Devices: []devicesynth.DeviceNode{nic, input},
			Resources: []devicesynth.DeviceResource{
				{DeviceID: nic.ID, Kind: devicesynth.ResourceMMIO, Flags: 1, Start: 0xfebf0000, Length: 0x1000, Aux: 0x11},
				{DeviceID: nic.ID, Kind: devicesynth.ResourcePortIO, Flags: 2, Start: 0x3f8, Length: 8, Aux: 0x22},
				{DeviceID: nic.ID, Kind: devicesynth.ResourceIRQ, Flags: 3, Start: 17, Length: 1, Aux: 0x33},
				{DeviceID: nic.ID, Kind: devicesynth.ResourceDMA, Flags: 4, Start: 0x20000000, Length: 0x2000, Aux: 0x44},
				{DeviceID: nic.ID, Kind: devicesynth.ResourceConfig, Flags: 5, Start: 0, Length: 0x100, Aux: 0x55},
				{DeviceID: nic.ID, Kind: devicesynth.ResourceDeviceControl, Flags: 6, Start: 1, Length: 1, Aux: 0x66},
				{DeviceID: nic.ID, Kind: devicesynth.ResourceSharedMemory, Flags: 7, Start: 0x30000000, Length: 0x4000, Aux: 0x77},
			},
			Edges: []devicesynth.DeviceEdge{
				{From: nic.ID, To: input.ID, Relation: "depends-on"},
				{From: nic.ID, To: input.ID, Relation: "contains"},
			},
		},
		ProbeSource:  "synthetic-test",
		ProbeVersion: "1",
	}
}

func mappingByDevice(result Result) map[string]uint64 {
	out := make(map[string]uint64, len(result.Nodes))
	for _, mapping := range result.Nodes {
		out[mapping.DeviceID] = mapping.NativeID
	}
	return out
}

func TestEncodeExactSeedWireLayout(t *testing.T) {
	manifest := fixtureManifest()
	result, err := Encode(manifest)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := devicesynth.HardwareBindingHash(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if result.HardwareBindingHash != binding {
		t.Fatalf("binding=%q want %q", result.HardwareBindingHash, binding)
	}

	wantSize := WireHeaderBytes +
		len(manifest.Graph.Devices)*WireNodeBytes +
		len(manifest.Graph.Resources)*WireResourceBytes +
		len(manifest.Graph.Edges)*WireEdgeBytes
	if len(result.Wire) != wantSize || wantSize != 544 {
		t.Fatalf("wire size=%d want=%d (fixture exact=544)", len(result.Wire), wantSize)
	}
	if binary.LittleEndian.Uint32(result.Wire[0:4]) != WireMagic ||
		binary.LittleEndian.Uint16(result.Wire[4:6]) != WireVersion ||
		binary.LittleEndian.Uint16(result.Wire[6:8]) != WireHeaderBytes ||
		binary.LittleEndian.Uint32(result.Wire[8:12]) != uint32(wantSize) ||
		binary.LittleEndian.Uint16(result.Wire[12:14]) != 2 ||
		binary.LittleEndian.Uint16(result.Wire[14:16]) != 7 ||
		binary.LittleEndian.Uint16(result.Wire[16:18]) != 2 {
		t.Fatalf("invalid wire header: %x", result.Wire[:WireHeaderBytes])
	}
	if !allZero(result.Wire[18:24]) {
		t.Fatalf("header reserved bytes are non-zero: %x", result.Wire[18:24])
	}

	devices := make(map[string]devicesynth.DeviceNode, len(manifest.Graph.Devices))
	for _, device := range manifest.Graph.Devices {
		devices[device.ID] = device
	}
	for index, mapping := range result.Nodes {
		device := devices[mapping.DeviceID]
		offset := WireHeaderBytes + index*WireNodeBytes
		node := result.Wire[offset : offset+WireNodeBytes]
		class, _ := nativeDeviceClass(device.Kind)
		bus := nativeBusPCI
		if device.BusID == "usb0" {
			bus = nativeBusUSB
		}
		vendor, _ := parseOptionalHex(device.Identity.VendorID, "vendor_id", 32)
		product, _ := parseOptionalHex(device.Identity.ProductID, "product_id", 32)
		revision, _ := parseOptionalHex(device.Identity.Revision, "revision", 8)
		if binary.LittleEndian.Uint64(node[0:8]) != mapping.NativeID ||
			binary.LittleEndian.Uint64(node[8:16]) != 0 ||
			binary.LittleEndian.Uint16(node[16:18]) != class ||
			binary.LittleEndian.Uint16(node[18:20]) != bus ||
			binary.LittleEndian.Uint32(node[20:24]) != 0 ||
			binary.LittleEndian.Uint32(node[24:28]) != uint32(vendor) ||
			binary.LittleEndian.Uint32(node[28:32]) != uint32(product) ||
			node[32] != 0 || node[33] != 0 || node[34] != 0 || node[35] != uint8(revision) ||
			binary.LittleEndian.Uint16(node[36:38]) != 0 ||
			!allZero(node[38:56]) ||
			!allZero(node[56:96]) {
			t.Fatalf("node %q wire mismatch: %x", mapping.DeviceID, node)
		}
	}

	privateMarkers := [][]byte{
		[]byte("DO-NOT-COPY-SYNTHETIC-PRIVATE-DATA"),
		[]byte(manifest.Graph.Devices[0].Identity.SerialDigest),
		[]byte(manifest.Graph.Devices[0].FirmwareDigest),
		[]byte(manifest.ProbeSource),
	}
	for _, marker := range privateMarkers {
		if bytes.Contains(result.Wire, marker) {
			t.Fatalf("wire copied private/probe metadata %q", marker)
		}
	}

	ids := mappingByDevice(result)
	offset := WireHeaderBytes + 2*WireNodeBytes
	type expectedResource struct {
		node, start, length, aux uint64
		kind, flags              uint16
	}
	expectedResources := make([]expectedResource, 0, len(manifest.Graph.Resources))
	for _, resource := range manifest.Graph.Resources {
		kind, _ := nativeResourceKind(resource.Kind)
		expectedResources = append(expectedResources, expectedResource{
			node: ids[resource.DeviceID], kind: kind, flags: resource.Flags,
			start: resource.Start, length: resource.Length, aux: resource.Aux,
		})
	}
	sort.Slice(expectedResources, func(i, j int) bool {
		a, b := expectedResources[i], expectedResources[j]
		if a.node != b.node {
			return a.node < b.node
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
	for i, want := range expectedResources {
		record := result.Wire[offset+i*WireResourceBytes : offset+(i+1)*WireResourceBytes]
		if binary.LittleEndian.Uint64(record[0:8]) != want.node ||
			binary.LittleEndian.Uint16(record[8:10]) != want.kind ||
			binary.LittleEndian.Uint16(record[10:12]) != want.flags ||
			!allZero(record[12:16]) ||
			binary.LittleEndian.Uint64(record[16:24]) != want.start ||
			binary.LittleEndian.Uint64(record[24:32]) != want.length ||
			binary.LittleEndian.Uint64(record[32:40]) != want.aux {
			t.Fatalf("resource %d mismatch: %x", i, record)
		}
	}

	edgeOffset := offset + len(expectedResources)*WireResourceBytes
	type expectedEdge struct {
		from, to uint64
		kind     uint16
	}
	expectedEdges := make([]expectedEdge, 0, len(manifest.Graph.Edges))
	for _, edge := range manifest.Graph.Edges {
		kind, _ := nativeEdgeKind(edge.Relation)
		expectedEdges = append(expectedEdges, expectedEdge{from: ids[edge.From], to: ids[edge.To], kind: kind})
	}
	sort.Slice(expectedEdges, func(i, j int) bool {
		a, b := expectedEdges[i], expectedEdges[j]
		if a.from != b.from {
			return a.from < b.from
		}
		if a.to != b.to {
			return a.to < b.to
		}
		return a.kind < b.kind
	})
	for i, want := range expectedEdges {
		record := result.Wire[edgeOffset+i*WireEdgeBytes : edgeOffset+(i+1)*WireEdgeBytes]
		if binary.LittleEndian.Uint64(record[0:8]) != want.from ||
			binary.LittleEndian.Uint64(record[8:16]) != want.to ||
			binary.LittleEndian.Uint16(record[16:18]) != want.kind ||
			binary.LittleEndian.Uint16(record[18:20]) != 0 ||
			!allZero(record[20:24]) {
			t.Fatalf("edge %d mismatch: %x", i, record)
		}
	}
}

func TestEncodeIsDeterministicAcrossInputReorder(t *testing.T) {
	original := fixtureManifest()
	reordered := fixtureManifest()
	reverseBuses(reordered.Graph.Buses)
	reverseDevices(reordered.Graph.Devices)
	reverseResources(reordered.Graph.Resources)
	reverseEdges(reordered.Graph.Edges)
	reverseFirmware(reordered.Firmware)
	for i := range reordered.Graph.Devices {
		reverseProperties(reordered.Graph.Devices[i].Properties)
	}

	a, err := Encode(original)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Encode(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if a.HardwareBindingHash != b.HardwareBindingHash {
		t.Fatalf("binding changed after reorder: %q != %q", a.HardwareBindingHash, b.HardwareBindingHash)
	}
	if !bytes.Equal(a.Wire, b.Wire) {
		t.Fatalf("wire changed after reorder")
	}
	if fmt.Sprint(a.Nodes) != fmt.Sprint(b.Nodes) {
		t.Fatalf("node mapping changed after reorder: %#v != %#v", a.Nodes, b.Nodes)
	}
}

func TestNativeIDsAreBoundToHardwareBindingWithoutCopyingProperties(t *testing.T) {
	original := fixtureManifest()
	changed := fixtureManifest()
	changed.Graph.Devices[0].Properties[0].Value = "DIFFERENT-SYNTHETIC-PRIVATE-DATA"

	a, err := Encode(original)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Encode(changed)
	if err != nil {
		t.Fatal(err)
	}
	if a.HardwareBindingHash == b.HardwareBindingHash {
		t.Fatal("semantic property change did not change HardwareBindingHash")
	}
	aIDs := mappingByDevice(a)
	bIDs := mappingByDevice(b)
	if aIDs["nic0"] == bIDs["nic0"] {
		t.Fatal("native node id did not rebind after HardwareBindingHash changed")
	}
	if bytes.Equal(a.Wire, b.Wire) {
		t.Fatal("wire remained identical after hardware binding changed")
	}
	if bytes.Contains(b.Wire, []byte("DIFFERENT-SYNTHETIC-PRIVATE-DATA")) {
		t.Fatal("raw property data was copied into native wire")
	}
}

func TestEncodeFailClosedLimitsAndReferences(t *testing.T) {
	t.Run("nodes", func(t *testing.T) {
		manifest := minimalManifest()
		for i := 0; i < MaxNodes+1; i++ {
			manifest.Graph.Devices = append(manifest.Graph.Devices, testDevice(fmt.Sprintf("d%02d", i), "pcie0"))
		}
		mustEncodeFail(t, manifest, "device count")
	})
	t.Run("resources", func(t *testing.T) {
		manifest := minimalManifest()
		manifest.Graph.Devices = []devicesynth.DeviceNode{testDevice("d0", "pcie0")}
		for i := 0; i < MaxResources+1; i++ {
			manifest.Graph.Resources = append(manifest.Graph.Resources, devicesynth.DeviceResource{
				DeviceID: "d0", Kind: devicesynth.ResourceIRQ, Start: uint64(i), Length: 1,
			})
		}
		mustEncodeFail(t, manifest, "resource count")
	})
	t.Run("edges", func(t *testing.T) {
		manifest := minimalManifest()
		for i := 0; i < 12; i++ {
			manifest.Graph.Devices = append(manifest.Graph.Devices, testDevice(fmt.Sprintf("d%02d", i), "pcie0"))
		}
		for from := 0; from < 12 && len(manifest.Graph.Edges) < MaxEdges+1; from++ {
			for to := from + 1; to < 12 && len(manifest.Graph.Edges) < MaxEdges+1; to++ {
				manifest.Graph.Edges = append(manifest.Graph.Edges, devicesynth.DeviceEdge{
					From: fmt.Sprintf("d%02d", from), To: fmt.Sprintf("d%02d", to), Relation: "depends-on",
				})
			}
		}
		mustEncodeFail(t, manifest, "edge count")
	})
	t.Run("resource missing ref", func(t *testing.T) {
		manifest := minimalManifest()
		manifest.Graph.Devices = []devicesynth.DeviceNode{testDevice("d0", "pcie0")}
		manifest.Graph.Resources = []devicesynth.DeviceResource{{DeviceID: "missing", Kind: devicesynth.ResourceIRQ, Start: 1, Length: 1}}
		mustEncodeFail(t, manifest, "invalid hardware manifest")
	})
	t.Run("edge missing ref", func(t *testing.T) {
		manifest := minimalManifest()
		manifest.Graph.Devices = []devicesynth.DeviceNode{testDevice("d0", "pcie0")}
		manifest.Graph.Edges = []devicesynth.DeviceEdge{{From: "d0", To: "missing", Relation: "depends-on"}}
		mustEncodeFail(t, manifest, "invalid hardware manifest")
	})
}

func TestEncodeFailClosedUnknownOrLossySemantics(t *testing.T) {
	tests := map[string]func(*devicesynth.HardwareManifest){
		"architecture": func(m *devicesynth.HardwareManifest) { m.Architecture = devicesynth.ArchARM64 },
		"endianness":   func(m *devicesynth.HardwareManifest) { m.Endianness = devicesynth.EndianBig },
		"unknown ABI":  func(m *devicesynth.HardwareManifest) { m.ABI = "mystery-x64" },
		"unknown bus":  func(m *devicesynth.HardwareManifest) { m.Graph.Buses[0].Kind = devicesynth.BusKind("SCSI") },
		"bus parent": func(m *devicesynth.HardwareManifest) {
			m.Graph.Buses = append(m.Graph.Buses, devicesynth.BusDescriptor{ID: "usb0", Kind: devicesynth.BusUSB})
			m.Graph.Buses[0].ParentID = "usb0"
		},
		"collapsed bus identity": func(m *devicesynth.HardwareManifest) {
			m.Graph.Buses = append(m.Graph.Buses, devicesynth.BusDescriptor{ID: "pci1", Kind: devicesynth.BusPCI})
		},
		"unknown class": func(m *devicesynth.HardwareManifest) { m.Graph.Devices[0].Kind = devicesynth.DeviceUnknown },
		"unknown relation": func(m *devicesynth.HardwareManifest) {
			m.Graph.Devices = append(m.Graph.Devices, testDevice("d1", "pcie0"))
			m.Graph.Edges = []devicesynth.DeviceEdge{{From: "d0", To: "d1", Relation: "teleports"}}
		},
		"vendor identity": func(m *devicesynth.HardwareManifest) { m.Graph.Devices[0].Identity.VendorID = "not-hex" },
		"vendor whitespace": func(m *devicesynth.HardwareManifest) {
			m.Graph.Devices[0].Identity.VendorID = " 1234 "
		},
		"product overflow":  func(m *devicesynth.HardwareManifest) { m.Graph.Devices[0].Identity.ProductID = "100000000" },
		"revision overflow": func(m *devicesynth.HardwareManifest) { m.Graph.Devices[0].Identity.Revision = "100" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			manifest := minimalManifest()
			manifest.Graph.Devices = []devicesynth.DeviceNode{testDevice("d0", "pcie0")}
			mutate(&manifest)
			if _, err := Encode(manifest); err == nil {
				t.Fatal("Encode unexpectedly accepted unsupported/lossy semantics")
			}
		})
	}

	t.Run("unknown resource", func(t *testing.T) {
		manifest := minimalManifest()
		manifest.Graph.Devices = []devicesynth.DeviceNode{testDevice("d0", "pcie0")}
		manifest.Graph.Resources = []devicesynth.DeviceResource{{DeviceID: "d0", Kind: devicesynth.DeviceResourceKind("MAGIC"), Start: 1, Length: 1}}
		mustEncodeFail(t, manifest, "invalid hardware manifest")
	})
}

func TestEncodeRejectsZeroAndCollidingNativeIDs(t *testing.T) {
	manifest := minimalManifest()
	manifest.Graph.Devices = []devicesynth.DeviceNode{testDevice("a", "pcie0"), testDevice("b", "pcie0")}
	if _, err := encodeWithNodeID(manifest, func(string, string) uint64 { return 0 }); err == nil || !strings.Contains(err.Error(), "forbidden native node id 0") {
		t.Fatalf("zero id error=%v", err)
	}
	if _, err := encodeWithNodeID(manifest, func(string, string) uint64 { return 7 }); err == nil || !strings.Contains(err.Error(), "collision") {
		t.Fatalf("collision error=%v", err)
	}
}

func TestSeedMappingsAreExactAndBounded(t *testing.T) {
	edgeCases := map[string]uint16{
		"contains": nativeEdgeContains, "depends-on": nativeEdgeDependsOn, "interrupts": nativeEdgeInterrupts,
		"clocked-by": nativeEdgeClockedBy, "powered-by": nativeEdgePoweredBy,
	}
	for relation, want := range edgeCases {
		got, err := nativeEdgeKind(relation)
		if err != nil || got != want {
			t.Fatalf("edge %q=(%d,%v) want %d", relation, got, err, want)
		}
	}
	resourceCases := map[devicesynth.DeviceResourceKind]uint16{
		devicesynth.ResourceMMIO: nativeResourceMMIO, devicesynth.ResourcePortIO: nativeResourcePortIO,
		devicesynth.ResourceIRQ: nativeResourceIRQ, devicesynth.ResourceDMA: nativeResourceDMA,
		devicesynth.ResourceConfig: nativeResourceConfig, devicesynth.ResourceDeviceControl: nativeResourceDeviceControl,
		devicesynth.ResourceSharedMemory: nativeResourceSharedMemory,
	}
	for kind, want := range resourceCases {
		got, err := nativeResourceKind(kind)
		if err != nil || got != want {
			t.Fatalf("resource %q=(%d,%v) want %d", kind, got, err, want)
		}
	}
	if got, _ := nativeBusKind(devicesynth.BusPCIe); got != nativeBusPCI {
		t.Fatalf("PCIE bus maps to %d want seed PCI family %d", got, nativeBusPCI)
	}
}

func minimalManifest() devicesynth.HardwareManifest {
	return devicesynth.HardwareManifest{
		SchemaVersion: devicesynth.HardwareManifestSchemaV1,
		Architecture:  devicesynth.ArchX8664,
		ABI:           "sysv-amd64",
		Endianness:    devicesynth.EndianLittle,
		Graph: devicesynth.DeviceGraph{
			SchemaVersion: devicesynth.DeviceGraphSchemaV1,
			Buses:         []devicesynth.BusDescriptor{{ID: "pcie0", Kind: devicesynth.BusPCIe}},
		},
	}
}

func testDevice(id, busID string) devicesynth.DeviceNode {
	return devicesynth.DeviceNode{
		ID: id, Kind: devicesynth.DeviceCompute, BusID: busID,
		Identity: devicesynth.DeviceIdentity{StableID: devicesynth.PrivacySafeDeviceID("nativegraph-test", id)},
	}
}

func mustEncodeFail(t *testing.T, manifest devicesynth.HardwareManifest, contains string) {
	t.Helper()
	_, err := Encode(manifest)
	if err == nil || !strings.Contains(err.Error(), contains) {
		t.Fatalf("Encode error=%v; want substring %q", err, contains)
	}
}

func allZero(data []byte) bool {
	for _, value := range data {
		if value != 0 {
			return false
		}
	}
	return true
}

func reverseBuses(values []devicesynth.BusDescriptor) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

func reverseDevices(values []devicesynth.DeviceNode) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

func reverseResources(values []devicesynth.DeviceResource) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

func reverseEdges(values []devicesynth.DeviceEdge) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

func reverseFirmware(values []devicesynth.FirmwareDescriptor) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

func reverseProperties(values []devicesynth.Property) {
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
}

type probeNode struct {
	ID, ParentID                uint64
	DeviceClass, Bus            uint16
	Flags, VendorID, DeviceID   uint32
	ClassCode, Subclass, ProgIF uint8
	Revision                    uint8
	InterfaceCount              uint16
	IOMMUGroup                  uint32
	FeatureBits                 uint64
	FirmwareVersion, Model      string
}

type probeResource struct {
	NodeID             uint64
	Kind, Flags        uint16
	Start, Length, Aux uint64
}

type probeEdge struct {
	FromNodeID, ToNodeID uint64
	Kind, Flags          uint16
}

type probeGraph struct {
	NodeCount, ResourceCount, EdgeCount uint16
	Nodes                               []probeNode
	Resources                           []probeResource
	Edges                               []probeEdge
}

func TestWriteCProbeFixture(t *testing.T) {
	wirePath := os.Getenv("NATIVEGRAPH_FIXTURE_WIRE")
	expectedPath := os.Getenv("NATIVEGRAPH_FIXTURE_EXPECTED")
	if wirePath == "" && expectedPath == "" {
		t.Skip("C probe fixture output not requested")
	}
	if wirePath == "" || expectedPath == "" {
		t.Fatal("both NATIVEGRAPH_FIXTURE_WIRE and NATIVEGRAPH_FIXTURE_EXPECTED are required")
	}

	manifest := fixtureManifest()
	result, err := Encode(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wirePath, result.Wire, 0o600); err != nil {
		t.Fatal(err)
	}
	expected := expectedProbeGraph(t, manifest, result)
	data, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(expectedPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func expectedProbeGraph(t *testing.T, manifest devicesynth.HardwareManifest, result Result) probeGraph {
	t.Helper()
	deviceByID := make(map[string]devicesynth.DeviceNode, len(manifest.Graph.Devices))
	busByID := make(map[string]devicesynth.BusKind, len(manifest.Graph.Buses))
	nativeID := mappingByDevice(result)
	for _, bus := range manifest.Graph.Buses {
		busByID[bus.ID] = bus.Kind
	}
	for _, device := range manifest.Graph.Devices {
		deviceByID[device.ID] = device
	}

	expected := probeGraph{
		NodeCount: uint16(len(manifest.Graph.Devices)), ResourceCount: uint16(len(manifest.Graph.Resources)), EdgeCount: uint16(len(manifest.Graph.Edges)),
	}
	for _, mapping := range result.Nodes {
		device := deviceByID[mapping.DeviceID]
		class, _ := nativeDeviceClass(device.Kind)
		bus, _ := nativeBusKind(busByID[device.BusID])
		vendor, _ := parseOptionalHex(device.Identity.VendorID, "vendor_id", 32)
		product, _ := parseOptionalHex(device.Identity.ProductID, "product_id", 32)
		revision, _ := parseOptionalHex(device.Identity.Revision, "revision", 8)
		expected.Nodes = append(expected.Nodes, probeNode{
			ID: mapping.NativeID, DeviceClass: class, Bus: bus, VendorID: uint32(vendor),
			DeviceID: uint32(product), Revision: uint8(revision),
		})
	}
	for _, resource := range manifest.Graph.Resources {
		kind, _ := nativeResourceKind(resource.Kind)
		expected.Resources = append(expected.Resources, probeResource{
			NodeID: nativeID[resource.DeviceID], Kind: kind, Flags: resource.Flags,
			Start: resource.Start, Length: resource.Length, Aux: resource.Aux,
		})
	}
	sort.Slice(expected.Resources, func(i, j int) bool {
		a, b := expected.Resources[i], expected.Resources[j]
		if a.NodeID != b.NodeID {
			return a.NodeID < b.NodeID
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Flags != b.Flags {
			return a.Flags < b.Flags
		}
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if a.Length != b.Length {
			return a.Length < b.Length
		}
		return a.Aux < b.Aux
	})
	for _, edge := range manifest.Graph.Edges {
		kind, _ := nativeEdgeKind(edge.Relation)
		expected.Edges = append(expected.Edges, probeEdge{FromNodeID: nativeID[edge.From], ToNodeID: nativeID[edge.To], Kind: kind})
	}
	sort.Slice(expected.Edges, func(i, j int) bool {
		a, b := expected.Edges[i], expected.Edges[j]
		if a.FromNodeID != b.FromNodeID {
			return a.FromNodeID < b.FromNodeID
		}
		if a.ToNodeID != b.ToNodeID {
			return a.ToNodeID < b.ToNodeID
		}
		return a.Kind < b.Kind
	})
	return expected
}
