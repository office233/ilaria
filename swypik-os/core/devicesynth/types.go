package devicesynth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	HardwareManifestSchemaV1 = "swypik.hardware/v1"
	DeviceGraphSchemaV1      = "swypik.device-graph/v1"
)

type Architecture string

const (
	ArchX8664   Architecture = "x86_64"
	ArchARM64   Architecture = "arm64"
	ArchRISCV64 Architecture = "riscv64"
)

func NormalizeArchitecture(raw string) Architecture {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "amd64", "x86_64", "x64":
		return ArchX8664
	case "arm64", "aarch64":
		return ArchARM64
	case "riscv64", "risc-v64", "riscv-64":
		return ArchRISCV64
	default:
		return Architecture(strings.ToLower(strings.TrimSpace(raw)))
	}
}

type Endianness string

const (
	EndianLittle Endianness = "little"
	EndianBig    Endianness = "big"
)

type FirmwareKind string

const (
	FirmwareUEFI       FirmwareKind = "UEFI"
	FirmwareACPI       FirmwareKind = "ACPI"
	FirmwareDeviceTree FirmwareKind = "DEVICE_TREE"
)

type BusKind string

const (
	BusPCI      BusKind = "PCI"
	BusPCIe     BusKind = "PCIE"
	BusUSB      BusKind = "USB"
	BusPlatform BusKind = "PLATFORM"
	BusStorage  BusKind = "STORAGE"
	BusCAN      BusKind = "CAN"
	BusUART     BusKind = "UART"
	BusI2C      BusKind = "I2C"
	BusSPI      BusKind = "SPI"
	BusGPIO     BusKind = "GPIO"
	BusModbus   BusKind = "MODBUS"
	BusEthernet BusKind = "ETHERNET"
	BusBLE      BusKind = "BLUETOOTH_LE"
)

type DeviceKind string

const (
	DeviceUnknown DeviceKind = "UNKNOWN"
	DeviceStorage DeviceKind = "STORAGE"
	DeviceDisplay DeviceKind = "DISPLAY"
	DeviceNetwork DeviceKind = "NETWORK"
	DeviceInput   DeviceKind = "INPUT"
	DeviceAudio   DeviceKind = "AUDIO"
	DeviceCamera  DeviceKind = "CAMERA"
	DevicePower   DeviceKind = "POWER"
	DeviceCompute DeviceKind = "COMPUTE"
)

type DeviceResourceKind string

const (
	ResourceMMIO          DeviceResourceKind = "MMIO"
	ResourcePortIO        DeviceResourceKind = "PORT_IO"
	ResourceIRQ           DeviceResourceKind = "IRQ"
	ResourceDMA           DeviceResourceKind = "DMA"
	ResourceConfig        DeviceResourceKind = "CONFIG"
	ResourceDeviceControl DeviceResourceKind = "DEVICE_CONTROL"
	ResourceSharedMemory  DeviceResourceKind = "SHARED_MEMORY"
)

// PlatformClass describes the operational device class of the host. It is
// deliberately coarse and carries no model/serial identity. Automotive means
// infotainment/compute-domain policy only; it never grants actuator authority.
type PlatformClass string

const (
	PlatformUnknown     PlatformClass = "unknown"
	PlatformWorkstation PlatformClass = "workstation"
	PlatformMobile      PlatformClass = "mobile"
	PlatformAutomotive  PlatformClass = "automotive"
	PlatformRobot       PlatformClass = "robot"
	PlatformAppliance   PlatformClass = "appliance"
	PlatformEmbedded    PlatformClass = "embedded"
)

func validPlatformClass(class PlatformClass) bool {
	switch class {
	case "", PlatformUnknown, PlatformWorkstation, PlatformMobile, PlatformAutomotive, PlatformRobot, PlatformAppliance, PlatformEmbedded:
		return true
	default:
		return false
	}
}

type FirmwareDescriptor struct {
	Kind    FirmwareKind `json:"kind"`
	Name    string       `json:"name,omitempty"`
	Version string       `json:"version,omitempty"`
	Digest  string       `json:"digest,omitempty"`
}

type BusDescriptor struct {
	ID       string  `json:"id"`
	Kind     BusKind `json:"kind"`
	ParentID string  `json:"parent_id,omitempty"`
}

// DeviceIdentity intentionally has no raw serial-number field. Callers that have
// a serial and are authorized to retain a correlation token may store only a
// one-way digest in SerialDigest.
type DeviceIdentity struct {
	StableID     string `json:"stable_id"`
	VendorID     string `json:"vendor_id,omitempty"`
	ProductID    string `json:"product_id,omitempty"`
	Revision     string `json:"revision,omitempty"`
	SerialDigest string `json:"serial_digest,omitempty"`
}

type Property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type DeviceNode struct {
	ID             string         `json:"id"`
	Kind           DeviceKind     `json:"kind"`
	BusID          string         `json:"bus_id,omitempty"`
	Identity       DeviceIdentity `json:"identity"`
	FirmwareDigest string         `json:"firmware_digest,omitempty"`
	Properties     []Property     `json:"properties,omitempty"`
}

type DeviceEdge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Relation string `json:"relation"`
}

// DeviceResource is one concrete hardware authority described by the probe.
// Rights are deliberately not stored here: this is inventory, not authority.
// A verified driver-domain policy later selects exact resources and a rights
// subset before the kernel mints capability handles.
type DeviceResource struct {
	DeviceID string             `json:"device_id"`
	Kind     DeviceResourceKind `json:"kind"`
	Flags    uint16             `json:"flags,omitempty"`
	Start    uint64             `json:"start"`
	Length   uint64             `json:"length"`
	Aux      uint64             `json:"aux,omitempty"`
}

type DeviceGraph struct {
	SchemaVersion string           `json:"schema_version"`
	Buses         []BusDescriptor  `json:"buses,omitempty"`
	Devices       []DeviceNode     `json:"devices"`
	Resources     []DeviceResource `json:"resources,omitempty"`
	Edges         []DeviceEdge     `json:"edges,omitempty"`
}

type HardwareManifest struct {
	SchemaVersion string               `json:"schema_version"`
	DeviceClass   PlatformClass        `json:"device_class,omitempty"`
	Architecture  Architecture         `json:"architecture"`
	ABI           string               `json:"abi"`
	Endianness    Endianness           `json:"endianness"`
	Firmware      []FirmwareDescriptor `json:"firmware,omitempty"`
	Graph         DeviceGraph          `json:"device_graph"`
	ProbeSource   string               `json:"probe_source,omitempty"`
	ProbeVersion  string               `json:"probe_version,omitempty"`
}

func PrivacySafeDeviceID(namespace string, parts ...string) string {
	h := sha256.New()
	h.Write([]byte(strings.TrimSpace(namespace)))
	for _, part := range parts {
		h.Write([]byte{0})
		h.Write([]byte(strings.TrimSpace(part)))
	}
	sum := h.Sum(nil)
	return "dev_" + hex.EncodeToString(sum[:12])
}

func HashPrivateIdentifier(raw string) string {
	if raw == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(raw))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (m HardwareManifest) Validate() error {
	if m.SchemaVersion != HardwareManifestSchemaV1 {
		return fmt.Errorf("unsupported hardware manifest schema %q", m.SchemaVersion)
	}
	if strings.TrimSpace(string(m.Architecture)) == "" {
		return errors.New("hardware architecture is required")
	}
	if !validPlatformClass(m.DeviceClass) {
		return fmt.Errorf("unsupported hardware device class %q", m.DeviceClass)
	}
	if strings.TrimSpace(m.ABI) == "" {
		return errors.New("hardware ABI is required")
	}
	if m.Endianness == "" {
		return errors.New("endianness is required")
	}
	if m.Graph.SchemaVersion != DeviceGraphSchemaV1 {
		return fmt.Errorf("unsupported device graph schema %q", m.Graph.SchemaVersion)
	}

	busIDs := make(map[string]struct{}, len(m.Graph.Buses))
	busParents := make(map[string]string, len(m.Graph.Buses))
	for _, bus := range m.Graph.Buses {
		if strings.TrimSpace(bus.ID) == "" || strings.TrimSpace(string(bus.Kind)) == "" {
			return errors.New("every bus requires an id and kind")
		}
		if _, exists := busIDs[bus.ID]; exists {
			return fmt.Errorf("duplicate bus id %q", bus.ID)
		}
		busIDs[bus.ID] = struct{}{}
		busParents[bus.ID] = bus.ParentID
	}
	for id, parentID := range busParents {
		if parentID == "" {
			continue
		}
		if id == parentID {
			return fmt.Errorf("bus %q cannot parent itself", id)
		}
		if _, exists := busIDs[parentID]; !exists {
			return fmt.Errorf("bus %q references unknown parent %q", id, parentID)
		}
	}
	if cycle := directedParentCycle(busParents); cycle != "" {
		return fmt.Errorf("bus parent cycle detected at %q", cycle)
	}

	deviceIDs := make(map[string]struct{}, len(m.Graph.Devices))
	for _, dev := range m.Graph.Devices {
		if strings.TrimSpace(dev.ID) == "" || strings.TrimSpace(dev.Identity.StableID) == "" {
			return errors.New("every device requires an id and privacy-safe stable id")
		}
		if _, exists := deviceIDs[dev.ID]; exists {
			return fmt.Errorf("duplicate device id %q", dev.ID)
		}
		deviceIDs[dev.ID] = struct{}{}
		if dev.BusID != "" {
			if _, exists := busIDs[dev.BusID]; !exists {
				return fmt.Errorf("device %q references unknown bus %q", dev.ID, dev.BusID)
			}
		}
	}
	for i, resource := range m.Graph.Resources {
		if _, exists := deviceIDs[resource.DeviceID]; !exists {
			return fmt.Errorf("resource %d references unknown device %q", i, resource.DeviceID)
		}
		if !validDeviceResource(resource) {
			return fmt.Errorf("resource %d has invalid %s range", i, resource.Kind)
		}
		for j := 0; j < i; j++ {
			if deviceResourcesConflict(m.Graph.Resources[j], resource) {
				return fmt.Errorf("resource %d overlaps or duplicates resource %d", i, j)
			}
		}
	}
	edgeKeys := make(map[string]struct{}, len(m.Graph.Edges))
	deviceAdjacency := make(map[string][]string, len(deviceIDs))
	for _, edge := range m.Graph.Edges {
		if _, ok := deviceIDs[edge.From]; !ok {
			return fmt.Errorf("edge references unknown source device %q", edge.From)
		}
		if _, ok := deviceIDs[edge.To]; !ok {
			return fmt.Errorf("edge references unknown target device %q", edge.To)
		}
		if strings.TrimSpace(edge.Relation) == "" {
			return errors.New("device edge relation is required")
		}
		if edge.From == edge.To {
			return fmt.Errorf("device edge %q cannot reference itself", edge.From)
		}
		key := edge.From + "\x00" + edge.To + "\x00" + edge.Relation
		if _, exists := edgeKeys[key]; exists {
			return fmt.Errorf("duplicate device edge %q -> %q (%s)", edge.From, edge.To, edge.Relation)
		}
		edgeKeys[key] = struct{}{}
		deviceAdjacency[edge.From] = append(deviceAdjacency[edge.From], edge.To)
	}
	if cycle := directedGraphCycle(deviceIDs, deviceAdjacency); cycle != "" {
		return fmt.Errorf("device dependency cycle detected at %q", cycle)
	}
	return nil
}

func validDeviceResource(resource DeviceResource) bool {
	if strings.TrimSpace(resource.DeviceID) == "" || resource.Length == 0 {
		return false
	}
	switch resource.Kind {
	case ResourceMMIO:
		return resource.Length <= ^uint64(0)-resource.Start
	case ResourceDMA, ResourceSharedMemory:
		return resource.Start%4096 == 0 && resource.Length%4096 == 0 &&
			resource.Length <= ^uint64(0)-resource.Start
	case ResourcePortIO:
		return resource.Start <= 0xffff && resource.Length <= 0x10000-resource.Start
	case ResourceIRQ:
		return resource.Length == 1 && resource.Start <= uint64(^uint32(0))
	case ResourceConfig:
		return resource.Start < 4096 && resource.Length <= 4096-resource.Start
	case ResourceDeviceControl:
		return resource.Length == 1
	default:
		return false
	}
}

func resourceRangesOverlap(left, right DeviceResource) bool {
	leftEnd := left.Start + left.Length
	rightEnd := right.Start + right.Length
	return left.Start < rightEnd && right.Start < leftEnd
}

func deviceResourcesConflict(left, right DeviceResource) bool {
	if left.Kind != right.Kind {
		return false
	}
	switch left.Kind {
	case ResourceMMIO, ResourcePortIO, ResourceDMA, ResourceSharedMemory:
		return resourceRangesOverlap(left, right)
	case ResourceConfig:
		return left.DeviceID == right.DeviceID && resourceRangesOverlap(left, right)
	case ResourceIRQ, ResourceDeviceControl:
		return left.DeviceID == right.DeviceID && left.Start == right.Start
	default:
		return false
	}
}

func directedParentCycle(parents map[string]string) string {
	const (
		unseen = iota
		visiting
		done
	)
	state := make(map[string]int, len(parents))
	var visit func(string) string
	visit = func(id string) string {
		switch state[id] {
		case visiting:
			return id
		case done:
			return ""
		}
		state[id] = visiting
		if parent := parents[id]; parent != "" {
			if cycle := visit(parent); cycle != "" {
				return cycle
			}
		}
		state[id] = done
		return ""
	}
	for id := range parents {
		if cycle := visit(id); cycle != "" {
			return cycle
		}
	}
	return ""
}

func directedGraphCycle(nodes map[string]struct{}, adjacency map[string][]string) string {
	const (
		unseen = iota
		visiting
		done
	)
	state := make(map[string]int, len(nodes))
	var visit func(string) string
	visit = func(id string) string {
		switch state[id] {
		case visiting:
			return id
		case done:
			return ""
		}
		state[id] = visiting
		for _, next := range adjacency[id] {
			if cycle := visit(next); cycle != "" {
				return cycle
			}
		}
		state[id] = done
		return ""
	}
	for id := range nodes {
		if cycle := visit(id); cycle != "" {
			return cycle
		}
	}
	return ""
}

// HardwareBindingHash is stable across probe ordering and excludes probe-source
// metadata. It binds generated artifacts to the exact architecture, firmware,
// buses, device identities, firmware digests and graph relationships observed.
func HardwareBindingHash(m HardwareManifest) (string, error) {
	if err := m.Validate(); err != nil {
		return "", err
	}

	clone := m
	clone.ProbeSource = ""
	clone.ProbeVersion = ""
	clone.Firmware = append([]FirmwareDescriptor(nil), m.Firmware...)
	clone.Graph.Buses = append([]BusDescriptor(nil), m.Graph.Buses...)
	clone.Graph.Devices = append([]DeviceNode(nil), m.Graph.Devices...)
	clone.Graph.Resources = append([]DeviceResource(nil), m.Graph.Resources...)
	clone.Graph.Edges = append([]DeviceEdge(nil), m.Graph.Edges...)

	sort.Slice(clone.Firmware, func(i, j int) bool {
		a, b := clone.Firmware[i], clone.Firmware[j]
		return string(a.Kind)+"\x00"+a.Name+"\x00"+a.Version+"\x00"+a.Digest < string(b.Kind)+"\x00"+b.Name+"\x00"+b.Version+"\x00"+b.Digest
	})
	sort.Slice(clone.Graph.Buses, func(i, j int) bool { return clone.Graph.Buses[i].ID < clone.Graph.Buses[j].ID })
	for i := range clone.Graph.Devices {
		clone.Graph.Devices[i].Properties = append([]Property(nil), clone.Graph.Devices[i].Properties...)
		sort.Slice(clone.Graph.Devices[i].Properties, func(a, b int) bool {
			pa, pb := clone.Graph.Devices[i].Properties[a], clone.Graph.Devices[i].Properties[b]
			return pa.Name+"\x00"+pa.Value < pb.Name+"\x00"+pb.Value
		})
	}
	sort.Slice(clone.Graph.Devices, func(i, j int) bool { return clone.Graph.Devices[i].ID < clone.Graph.Devices[j].ID })
	sort.Slice(clone.Graph.Resources, func(i, j int) bool {
		a, b := clone.Graph.Resources[i], clone.Graph.Resources[j]
		if a.DeviceID != b.DeviceID {
			return a.DeviceID < b.DeviceID
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if a.Length != b.Length {
			return a.Length < b.Length
		}
		if a.Aux != b.Aux {
			return a.Aux < b.Aux
		}
		return a.Flags < b.Flags
	})
	sort.Slice(clone.Graph.Edges, func(i, j int) bool {
		a, b := clone.Graph.Edges[i], clone.Graph.Edges[j]
		return a.From+"\x00"+a.To+"\x00"+a.Relation < b.From+"\x00"+b.To+"\x00"+b.Relation
	})

	return CanonicalHash(clone)
}

func CanonicalHash(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}
