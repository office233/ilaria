//go:build windows

package resource

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

var procGetProcessMemoryInfo = syscall.NewLazyDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

type processMemoryCounters struct {
	Size                  uint32
	PageFaultCount        uint32
	PeakWorkingSetSize    uintptr
	WorkingSetSize        uintptr
	QuotaPeakPagedPool    uintptr
	QuotaPagedPool        uintptr
	QuotaPeakNonPagedPool uintptr
	QuotaNonPagedPool     uintptr
	PagefileUsage         uintptr
	PeakPagefileUsage     uintptr
}

type processSampler struct{ handle syscall.Handle }

func openProcessSampler(pid int) (processSampler, error) {
	if pid <= 0 || uint64(pid) > uint64(^uint32(0)) {
		return processSampler{}, fmt.Errorf("process pid must be positive")
	}
	handle, err := syscall.OpenProcess(0x1000, false, uint32(pid)) // PROCESS_QUERY_LIMITED_INFORMATION
	return processSampler{handle: handle}, err
}

func (s processSampler) sample() (ProcessUsage, error) {
	var created, exited, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(s.handle, &created, &exited, &kernel, &user); err != nil {
		return ProcessUsage{}, err
	}
	ticks := func(v syscall.Filetime) uint64 { return uint64(v.HighDateTime)<<32 | uint64(v.LowDateTime) }
	u, k := ticks(user), ticks(kernel)
	if u > uint64(^uint64(0)>>1)/100 || k > uint64(^uint64(0)>>1)/100-u {
		return ProcessUsage{}, fmt.Errorf("process CPU counter overflows duration")
	}
	memory := processMemoryCounters{Size: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	result, _, err := procGetProcessMemoryInfo.Call(uintptr(s.handle), uintptr(unsafe.Pointer(&memory)), uintptr(memory.Size))
	if result == 0 {
		return ProcessUsage{}, fmt.Errorf("GetProcessMemoryInfo: %v", err)
	}
	return ProcessUsage{CPUTime: time.Duration((u + k) * 100), RSSBytes: uint64(memory.WorkingSetSize), PeakRSSBytes: uint64(memory.PeakWorkingSetSize)}, nil
}

func (s processSampler) close() error { return syscall.CloseHandle(s.handle) }
