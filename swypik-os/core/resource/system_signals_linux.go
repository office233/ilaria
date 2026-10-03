//go:build linux

package resource

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

func linuxMemory() (total, available uint64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = value << 10
		case "MemAvailable":
			available = value << 10
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if total == 0 {
		return 0, 0, errors.New("MemTotal unavailable")
	}
	return total, available, nil
}

func linuxBattery() (hasBattery, onBattery bool, percent int) {
	percent = -1
	entries, _ := filepath.Glob("/sys/class/power_supply/*")
	for _, entry := range entries {
		typeBytes, err := os.ReadFile(filepath.Join(entry, "type"))
		if err != nil || !strings.EqualFold(strings.TrimSpace(string(typeBytes)), "Battery") {
			continue
		}
		hasBattery = true
		if status, err := os.ReadFile(filepath.Join(entry, "status")); err == nil {
			state := strings.ToLower(strings.TrimSpace(string(status)))
			onBattery = state == "discharging"
		}
		if capacity, err := os.ReadFile(filepath.Join(entry, "capacity")); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(capacity))); err == nil {
				percent = n
			}
		}
		break
	}
	return hasBattery, onBattery, percent
}

func linuxThermalCelsius() int {
	maxTemp := -1
	paths, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		raw, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil {
			continue
		}
		temp := raw
		if temp > 1000 {
			temp /= 1000
		}
		if temp >= 0 && temp <= 200 && temp > maxTemp {
			maxTemp = temp
		}
	}
	return maxTemp
}

func DetectHardwareFacts() (HardwareFacts, error) {
	total, _, err := linuxMemory()
	if err != nil {
		return HardwareFacts{}, err
	}
	hasBattery, _, _ := linuxBattery()
	return HardwareFacts{OS: runtime.GOOS, Arch: runtime.GOARCH, LogicalCPUs: runtime.NumCPU(), TotalMemoryBytes: total, HasBattery: hasBattery}, nil
}

func sampleSystemSignals() (RuntimeSignals, error) {
	total, available, err := linuxMemory()
	if err != nil {
		return RuntimeSignals{}, err
	}
	_, onBattery, percent := linuxBattery()
	memoryLoad := -1
	if total > 0 && available <= total {
		memoryLoad = int((total - available) * 100 / total)
	}
	return RuntimeSignals{
		OnBattery:            onBattery,
		BatteryPercent:       percent,
		MemoryLoadPercent:    memoryLoad,
		AvailableMemoryBytes: available,
		ThermalCelsius:       linuxThermalCelsius(),
	}, nil
}
