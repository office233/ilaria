//go:build !windows && !linux

package resource

import "runtime"

func DetectHardwareFacts() (HardwareFacts, error) {
	return HardwareFacts{OS: runtime.GOOS, Arch: runtime.GOARCH, LogicalCPUs: runtime.NumCPU()}, nil
}

func sampleSystemSignals() (RuntimeSignals, error) {
	return RuntimeSignals{BatteryPercent: -1, MemoryLoadPercent: -1, ThermalCelsius: -1}, nil
}
