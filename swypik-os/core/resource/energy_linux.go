//go:build linux

package resource

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const linuxPowercapABIRoot = "/sys/class/powercap"

type linuxEnergyZone struct {
	id         string
	domain     string
	energyPath string
	rangeValue uint64
}

type linuxEnergyReader struct {
	root       string
	discovered bool
	zones      []linuxEnergyZone
	reason     string
}

type linuxPowercapWalkRoot struct {
	path   string
	prefix string
}

func newPlatformEnergyReader() energyReader {
	return newLinuxEnergyReader(linuxPowercapABIRoot)
}

func newLinuxEnergyReader(root string) *linuxEnergyReader {
	return &linuxEnergyReader{root: root}
}

func (r *linuxEnergyReader) discover() {
	r.discovered = true
	info, err := os.Stat(r.root)
	if err != nil {
		r.reason = linuxEnergyReason(err, "no_counter")
		return
	}
	if !info.IsDir() {
		r.reason = "powercap_root_not_directory"
		return
	}

	permissionDenied := false
	walkRoots := []linuxPowercapWalkRoot{{path: r.root}}
	entries, readErr := os.ReadDir(r.root)
	if readErr != nil {
		r.reason = linuxEnergyReason(readErr, "discovery_failed")
		return
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink == 0 {
			continue
		}
		path := filepath.Join(r.root, entry.Name())
		target, err := filepath.EvalSymlinks(path)
		if err != nil {
			permissionDenied = permissionDenied || errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES)
			continue
		}
		info, err := os.Stat(target)
		if err != nil {
			permissionDenied = permissionDenied || errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES)
			continue
		}
		if info.IsDir() {
			walkRoots = append(walkRoots, linuxPowercapWalkRoot{path: target, prefix: entry.Name()})
		}
	}

	seenEnergyPaths := make(map[string]struct{})
	for _, walkRoot := range walkRoots {
		walkErr := filepath.WalkDir(walkRoot.path, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES) {
					permissionDenied = true
				}
				if entry != nil && entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() || entry.Name() != "energy_uj" {
				return nil
			}
			canonicalPath, err := filepath.EvalSymlinks(path)
			if err != nil {
				canonicalPath = path
			}
			if _, exists := seenEnergyPaths[canonicalPath]; exists {
				return nil
			}
			seenEnergyPaths[canonicalPath] = struct{}{}
			zoneDir := filepath.Dir(path)
			nameBytes, err := os.ReadFile(filepath.Join(zoneDir, "name"))
			if err != nil {
				if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES) {
					permissionDenied = true
				}
				return nil
			}
			domain := strings.TrimSpace(string(nameBytes))
			if domain == "" {
				return nil
			}
			rel, err := filepath.Rel(walkRoot.path, zoneDir)
			if err != nil || strings.HasPrefix(rel, "..") {
				return nil
			}
			if rel == "." {
				rel = ""
			}
			if walkRoot.prefix != "" {
				rel = filepath.Join(walkRoot.prefix, rel)
			}
			if rel == "" {
				rel = filepath.Base(zoneDir)
			}
			var rangeValue uint64
			if rangeBytes, err := os.ReadFile(filepath.Join(zoneDir, "max_energy_range_uj")); err == nil {
				rangeValue, _ = strconv.ParseUint(strings.TrimSpace(string(rangeBytes)), 10, 64)
			}
			r.zones = append(r.zones, linuxEnergyZone{
				id:         "linux_powercap:" + filepath.ToSlash(rel),
				domain:     domain,
				energyPath: path,
				rangeValue: rangeValue,
			})
			return nil
		})
		if walkErr != nil {
			r.reason = linuxEnergyReason(walkErr, "discovery_failed")
			return
		}
	}
	sort.Slice(r.zones, func(i, j int) bool { return r.zones[i].id < r.zones[j].id })
	if len(r.zones) == 0 {
		if permissionDenied {
			r.reason = "permission_denied"
		} else {
			r.reason = "no_counter"
		}
	}
}

func (r *linuxEnergyReader) readEnergy() rawEnergyRead {
	if !r.discovered {
		r.discover()
	}
	if len(r.zones) == 0 {
		return rawEnergyRead{Status: EnergyStatusUnavailable, Reason: r.reason}
	}

	result := rawEnergyRead{Status: EnergyStatusUnavailable, Counters: make([]rawEnergyCounter, 0, len(r.zones))}
	permissionDenied := false
	for _, zone := range r.zones {
		counter := rawEnergyCounter{
			ID:           zone.id,
			Status:       EnergyStatusUnavailable,
			Source:       "linux_powercap",
			Scope:        "powercap_zone",
			Domain:       zone.domain,
			Unit:         EnergyUnitMicrojoule,
			CounterRange: zone.rangeValue,
			ObservedAt:   time.Now(),
		}
		data, err := os.ReadFile(zone.energyPath)
		if err != nil {
			counter.Reason = linuxEnergyReason(err, "read_failed")
			permissionDenied = permissionDenied || counter.Reason == "permission_denied"
			result.Counters = append(result.Counters, counter)
			continue
		}
		value, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if err != nil {
			counter.Reason = "invalid_counter"
			result.Counters = append(result.Counters, counter)
			continue
		}
		counter.Counter = value
		counter.ObservedAt = time.Now()
		counter.Status = EnergyStatusAvailable
		result.Status = EnergyStatusAvailable
		result.Counters = append(result.Counters, counter)
	}
	if result.Status != EnergyStatusAvailable {
		if permissionDenied {
			result.Reason = "permission_denied"
		} else {
			result.Reason = "no_readable_counter"
		}
	}
	return result
}

func linuxEnergyReason(err error, fallback string) string {
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
		return "permission_denied"
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "no_counter"
	}
	if fallback != "" {
		return fallback
	}
	return fmt.Sprintf("platform_error:%T", err)
}

func (*linuxEnergyReader) close() error { return nil }
