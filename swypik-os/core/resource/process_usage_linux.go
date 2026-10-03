//go:build linux

package resource

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var clockTickOnce sync.Once
var clockTickHz uint64
var clockTickErr error

type processSampler struct {
	pid       int
	startTime string
	hz        uint64
}

func clockTicks() (uint64, error) {
	clockTickOnce.Do(func() {
		raw, err := os.ReadFile("/proc/self/auxv")
		if err != nil {
			clockTickErr = err
			return
		}
		word := strconv.IntSize / 8
		for i := 0; i+2*word <= len(raw); i += 2 * word {
			read := func(offset int) uint64 {
				if word == 8 {
					return binary.NativeEndian.Uint64(raw[offset : offset+8])
				}
				return uint64(binary.NativeEndian.Uint32(raw[offset : offset+4]))
			}
			tag := read(i)
			if tag == 0 {
				break
			}
			if tag == 17 { // Linux UAPI AT_CLKTCK, not a guessed host tick frequency.
				clockTickHz = read(i + word)
				break
			}
		}
		if clockTickHz == 0 || clockTickHz > 1e9 {
			clockTickErr = fmt.Errorf("Linux clock tick frequency unavailable")
		}
	})
	return clockTickHz, clockTickErr
}

func statFields(pid int) ([]string, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return nil, err
	}
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return nil, fmt.Errorf("invalid process stat")
	}
	fields := strings.Fields(string(raw[end+1:]))
	if len(fields) < 20 {
		return nil, fmt.Errorf("truncated process stat")
	}
	return fields, nil
}

func openProcessSampler(pid int) (processSampler, error) {
	if pid <= 0 {
		return processSampler{}, fmt.Errorf("process pid must be positive")
	}
	hz, err := clockTicks()
	if err != nil {
		return processSampler{}, err
	}
	fields, err := statFields(pid)
	if err != nil {
		return processSampler{}, err
	}
	return processSampler{pid: pid, startTime: fields[19], hz: hz}, nil
}

func (s processSampler) sample() (ProcessUsage, error) {
	fields, err := statFields(s.pid)
	if err != nil {
		return ProcessUsage{}, err
	}
	if fields[19] != s.startTime {
		return ProcessUsage{}, fmt.Errorf("process pid was reused")
	}
	user, userErr := strconv.ParseUint(fields[11], 10, 64)
	kernel, kernelErr := strconv.ParseUint(fields[12], 10, 64)
	if userErr != nil || kernelErr != nil || math.MaxUint64-user < kernel {
		return ProcessUsage{}, fmt.Errorf("invalid process CPU counters")
	}
	ticks := user + kernel
	seconds, fraction := ticks/s.hz, ticks%s.hz
	if seconds > uint64(math.MaxInt64)/uint64(time.Second) {
		return ProcessUsage{}, fmt.Errorf("process CPU counter overflows duration")
	}
	whole := seconds * uint64(time.Second)
	part := fraction * uint64(time.Second) / s.hz
	if part > uint64(math.MaxInt64)-whole {
		return ProcessUsage{}, fmt.Errorf("process CPU counter overflows duration")
	}
	usage := ProcessUsage{CPUTime: time.Duration(whole + part)}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", s.pid))
	if err != nil {
		return ProcessUsage{}, err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		parts := strings.Fields(line)
		if len(parts) != 3 || parts[2] != "kB" || (parts[0] != "VmRSS:" && parts[0] != "VmHWM:") {
			continue
		}
		n, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil || n > math.MaxUint64/1024 {
			return ProcessUsage{}, fmt.Errorf("invalid process memory counter")
		}
		if parts[0] == "VmRSS:" {
			usage.RSSBytes = n * 1024
		} else {
			usage.PeakRSSBytes = n * 1024
		}
	}
	return usage, nil
}

func (s processSampler) close() error { return nil }
