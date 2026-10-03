//go:build windows

package resource

import (
	"fmt"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32Resource         = syscall.NewLazyDLL("kernel32.dll")
	user32Resource           = syscall.NewLazyDLL("user32.dll")
	procGlobalMemoryStatusEx = kernel32Resource.NewProc("GlobalMemoryStatusEx")
	procGetSystemPowerStatus = kernel32Resource.NewProc("GetSystemPowerStatus")
	procGetTickCount         = kernel32Resource.NewProc("GetTickCount")
	procGetLastInputInfo     = user32Resource.NewProc("GetLastInputInfo")
)

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

type lastInputInfo struct {
	Size uint32
	Time uint32
}

func readMemoryStatus() (memoryStatusEx, error) {
	status := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	r1, _, callErr := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if r1 == 0 {
		return memoryStatusEx{}, fmt.Errorf("GlobalMemoryStatusEx: %v", callErr)
	}
	return status, nil
}

func readPowerStatus() (systemPowerStatus, error) {
	var status systemPowerStatus
	r1, _, callErr := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&status)))
	if r1 == 0 {
		return systemPowerStatus{}, fmt.Errorf("GetSystemPowerStatus: %v", callErr)
	}
	return status, nil
}

func windowsHasBattery(status systemPowerStatus) bool {
	return status.BatteryFlag != 0xff && status.BatteryFlag&0x80 == 0
}

func DetectHardwareFacts() (HardwareFacts, error) {
	memory, err := readMemoryStatus()
	if err != nil {
		return HardwareFacts{}, err
	}
	power, powerErr := readPowerStatus()
	return HardwareFacts{
		OS:               runtime.GOOS,
		Arch:             runtime.GOARCH,
		LogicalCPUs:      runtime.NumCPU(),
		TotalMemoryBytes: memory.TotalPhys,
		HasBattery:       powerErr == nil && windowsHasBattery(power),
	}, nil
}

func sampleSystemSignals() (RuntimeSignals, error) {
	memory, err := readMemoryStatus()
	if err != nil {
		return RuntimeSignals{}, err
	}
	signals := RuntimeSignals{
		BatteryPercent:       -1,
		MemoryLoadPercent:    int(memory.MemoryLoad),
		AvailableMemoryBytes: memory.AvailPhys,
		ThermalCelsius:       -1,
	}
	if power, powerErr := readPowerStatus(); powerErr == nil {
		signals.OnBattery = windowsHasBattery(power) && power.ACLineStatus == 0
		if power.BatteryLifePercent != 0xff {
			signals.BatteryPercent = int(power.BatteryLifePercent)
		}
	}
	info := lastInputInfo{Size: uint32(unsafe.Sizeof(lastInputInfo{}))}
	if r1, _, _ := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info))); r1 != 0 {
		now, _, _ := procGetTickCount.Call()
		idleMS := uint32(now) - info.Time // uint32 subtraction is wrap-safe.
		signals.UserActive = idleMS < uint32(userActiveWindow/time.Millisecond)
	}
	return signals, nil
}
