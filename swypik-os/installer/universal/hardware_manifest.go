package universal

import (
	"fmt"
	"runtime"
	"sort"
	"strings"

	"swypik-os/core/devicesynth"
	"swypik-os/core/hal"
)

func platformClassFromHAL(host hal.HostType) devicesynth.PlatformClass {
	switch host {
	case hal.HostVehicle:
		return devicesynth.PlatformAutomotive
	case hal.HostRobot:
		return devicesynth.PlatformRobot
	case hal.HostAppliance:
		return devicesynth.PlatformAppliance
	case hal.HostMobile:
		return devicesynth.PlatformMobile
	case hal.HostPC:
		return devicesynth.PlatformWorkstation
	default:
		return devicesynth.PlatformUnknown
	}
}

func manifestBusKind(bus hal.BusType) (devicesynth.BusKind, bool) {
	switch bus {
	case hal.BusPCIe:
		return devicesynth.BusPCIe, true
	case hal.BusUSB:
		return devicesynth.BusUSB, true
	case hal.BusCAN:
		return devicesynth.BusCAN, true
	case hal.BusUART:
		return devicesynth.BusUART, true
	case hal.BusI2C:
		return devicesynth.BusI2C, true
	case hal.BusSPI:
		return devicesynth.BusSPI, true
	case hal.BusGPIO:
		return devicesynth.BusGPIO, true
	case hal.BusModbus:
		return devicesynth.BusModbus, true
	case hal.BusEthernet:
		return devicesynth.BusEthernet, true
	case hal.BusBLE:
		return devicesynth.BusBLE, true
	default:
		return "", false
	}
}

func manifestDeviceKind(class hal.DeviceClass) devicesynth.DeviceKind {
	switch class {
	case hal.ClassCompute:
		return devicesynth.DeviceCompute
	case hal.ClassNetwork:
		return devicesynth.DeviceNetwork
	default:
		return devicesynth.DeviceUnknown
	}
}

func manifestResourceKind(kind hal.ResourceKind) (devicesynth.DeviceResourceKind, bool) {
	switch kind {
	case hal.ResourceMMIO:
		return devicesynth.ResourceMMIO, true
	case hal.ResourcePortIO:
		return devicesynth.ResourcePortIO, true
	case hal.ResourceIRQ:
		return devicesynth.ResourceIRQ, true
	case hal.ResourceDMA:
		return devicesynth.ResourceDMA, true
	case hal.ResourceConfig:
		return devicesynth.ResourceConfig, true
	case hal.ResourceDeviceControl:
		return devicesynth.ResourceDeviceControl, true
	case hal.ResourceSharedMemory:
		return devicesynth.ResourceSharedMemory, true
	default:
		return "", false
	}
}

func manifestABI(goos, goarch string) (devicesynth.Architecture, string, devicesynth.Endianness, error) {
	arch := devicesynth.NormalizeArchitecture(goarch)
	switch arch {
	case devicesynth.ArchX8664:
		if goos == "windows" {
			return arch, "win64", devicesynth.EndianLittle, nil
		}
		return arch, "sysv-amd64", devicesynth.EndianLittle, nil
	case devicesynth.ArchARM64:
		return arch, "aapcs64", devicesynth.EndianLittle, nil
	case devicesynth.ArchRISCV64:
		return arch, "riscv64-lp64", devicesynth.EndianLittle, nil
	default:
		return "", "", "", fmt.Errorf("unsupported architecture %q", goarch)
	}
}

func hardwareManifestFromHAL(profile *hal.HardwareProfile) (devicesynth.HardwareManifest, error) {
	if profile == nil {
		return devicesynth.HardwareManifest{}, fmt.Errorf("nil HAL profile")
	}
	goos := strings.TrimSpace(profile.OS)
	if goos == "" {
		goos = runtime.GOOS
	}
	archRaw := strings.TrimSpace(profile.Arch)
	if archRaw == "" {
		archRaw = runtime.GOARCH
	}
	arch, abi, endian, err := manifestABI(goos, archRaw)
	if err != nil {
		return devicesynth.HardwareManifest{}, err
	}

	busMap := make(map[hal.BusType]string)
	buses := make([]devicesynth.BusDescriptor, 0, len(profile.Buses))
	for _, bus := range profile.Buses {
		kind, ok := manifestBusKind(bus)
		if !ok {
			continue
		}
		id := "bus_" + strings.ToLower(strings.ReplaceAll(string(bus), "_", "-"))
		busMap[bus] = id
		buses = append(buses, devicesynth.BusDescriptor{ID: id, Kind: kind})
	}
	sort.Slice(buses, func(i, j int) bool { return buses[i].ID < buses[j].ID })

	devices := make([]devicesynth.DeviceNode, 0, len(profile.Devices))
	resources := make([]devicesynth.DeviceResource, 0)
	for _, dev := range profile.Devices {
		if dev == nil || strings.TrimSpace(dev.ID) == "" {
			continue
		}
		properties := []devicesynth.Property{
			{Name: "protocol", Value: dev.Protocol},
			{Name: "driver_status", Value: string(dev.DriverStatus)},
			{Name: "hal_class", Value: string(dev.Class)},
		}
		node := devicesynth.DeviceNode{
			ID:   dev.ID,
			Kind: manifestDeviceKind(dev.Class),
			Identity: devicesynth.DeviceIdentity{
				StableID:  devicesynth.PrivacySafeDeviceID("hal", dev.ID, dev.VendorID, dev.ProductID),
				VendorID:  dev.VendorID,
				ProductID: dev.ProductID,
			},
			Properties: properties,
		}
		if busID, ok := busMap[dev.Bus]; ok {
			node.BusID = busID
		}
		devices = append(devices, node)
		for _, resource := range dev.Resources {
			kind, ok := manifestResourceKind(resource.Kind)
			if !ok {
				continue
			}
			resources = append(resources, devicesynth.DeviceResource{
				DeviceID: dev.ID,
				Kind:     kind,
				Flags:    resource.Flags,
				Start:    resource.Start,
				Length:   resource.Length,
				Aux:      resource.Aux,
			})
		}
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	sort.Slice(resources, func(i, j int) bool {
		a, b := resources[i], resources[j]
		if a.DeviceID != b.DeviceID {
			return a.DeviceID < b.DeviceID
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		return a.Length < b.Length
	})

	manifest := devicesynth.HardwareManifest{
		SchemaVersion: devicesynth.HardwareManifestSchemaV1,
		DeviceClass:   platformClassFromHAL(profile.HostType),
		Architecture:  arch,
		ABI:           abi,
		Endianness:    endian,
		Graph: devicesynth.DeviceGraph{
			SchemaVersion: devicesynth.DeviceGraphSchemaV1,
			Buses:         buses,
			Devices:       devices,
			Resources:     resources,
		},
		ProbeSource:  "legacy-hal",
		ProbeVersion: "1",
	}
	if err := manifest.Validate(); err != nil {
		return devicesynth.HardwareManifest{}, err
	}
	return manifest, nil
}
