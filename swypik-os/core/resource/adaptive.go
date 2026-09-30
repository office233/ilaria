package resource

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"swypik-os/core/devicesynth"
)

const (
	profileEnv        = "SWYPIK_RESOURCE_PROFILE"
	userActiveWindow  = 30 * time.Second
	minCriticalMemory = 256 << 20
)

// HardwareFacts are deliberately coarse, privacy-preserving facts used only to
// choose a conservative process resource profile. They contain no serials,
// hostnames or stable device identifiers.
type HardwareFacts struct {
	OS               string `json:"os"`
	Arch             string `json:"arch"`
	LogicalCPUs      int    `json:"logical_cpus"`
	TotalMemoryBytes uint64 `json:"total_memory_bytes"`
	HasBattery       bool   `json:"has_battery"`
}

type Selection struct {
	Policy      Policy                    `json:"policy"`
	DeviceClass devicesynth.PlatformClass `json:"device_class"`
	Source      string                    `json:"source"`
	Reason      string                    `json:"reason"`
	Facts       HardwareFacts             `json:"facts"`
}

// SelectProfile maps stable hardware facts to a bounded base profile. Portable
// and constrained devices stay conservative. Performance is automatic only on
// clearly provisioned, battery-less workstations; runtime pressure can only
// tighten this base budget, never relax it.
func SelectProfile(f HardwareFacts) (Profile, string) {
	const (
		gib = uint64(1 << 30)
	)
	if strings.EqualFold(f.OS, "android") {
		return ProfilePhone, "mobile operating system"
	}
	if (f.TotalMemoryBytes > 0 && f.TotalMemoryBytes <= 4*gib) || (f.LogicalCPUs > 0 && f.LogicalCPUs <= 4) {
		return ProfilePhone, "constrained CPU or memory capacity"
	}
	if f.HasBattery {
		if (f.TotalMemoryBytes > 0 && f.TotalMemoryBytes <= 8*gib) || (f.LogicalCPUs > 0 && f.LogicalCPUs <= 6) {
			return ProfilePhone, "portable constrained hardware"
		}
		return ProfileBalanced, "portable hardware"
	}
	if f.LogicalCPUs >= 16 && f.TotalMemoryBytes >= 24*gib {
		return ProfilePerformance, "high-headroom workstation"
	}
	return ProfileBalanced, "general-purpose hardware"
}

func validProfile(p Profile) bool {
	return p == ProfilePhone || p == ProfileBalanced || p == ProfilePerformance
}

// DefaultSelection reports both the selected policy and why it was selected.
// "auto" and an unset variable use hardware detection. An invalid explicit
// value does not silently become performance; it falls back to balanced.
func DefaultSelection() Selection {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(profileEnv)))
	if raw != "" && raw != "auto" {
		profile := Profile(raw)
		if validProfile(profile) {
			return Selection{Policy: ForProfile(profile), DeviceClass: devicesynth.PlatformUnknown, Source: "explicit", Reason: profileEnv}
		}
		return Selection{Policy: ForProfile(ProfileBalanced), DeviceClass: devicesynth.PlatformUnknown, Source: "fallback", Reason: "invalid explicit profile"}
	}
	facts, err := DetectHardwareFacts()
	if err != nil {
		return Selection{Policy: ForProfile(ProfileBalanced), DeviceClass: devicesynth.PlatformUnknown, Source: "fallback", Reason: "hardware detection unavailable"}
	}
	profile, reason := SelectProfile(facts)
	return Selection{Policy: ForProfile(profile), DeviceClass: devicesynth.PlatformUnknown, Source: "automatic", Reason: reason, Facts: facts}
}

// SelectionFromManifest combines coarse capacity facts with an already-probed,
// validated Hardware Manifest. Explicit profile selection remains the maximum
// envelope, while device class may only tighten it.
func SelectionFromManifest(manifest devicesynth.HardwareManifest, facts HardwareFacts) (Selection, error) {
	if err := manifest.Validate(); err != nil {
		return Selection{}, fmt.Errorf("resource device-class manifest: %w", err)
	}
	class := normalizeDeviceClass(manifest.DeviceClass)
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(profileEnv)))
	var profile Profile
	var source, reason string
	if raw != "" && raw != "auto" {
		profile = Profile(raw)
		if !validProfile(profile) {
			profile = ProfileBalanced
			source, reason = "fallback", "invalid explicit profile"
		} else {
			source, reason = "explicit", profileEnv
		}
	} else {
		profile, reason = SelectProfile(facts)
		source = "hardware-manifest"
	}
	policy := ForDeviceClass(ForProfile(profile), class)
	return Selection{Policy: policy, DeviceClass: class, Source: source, Reason: reason, Facts: facts}, nil
}

// RuntimeSignals are ephemeral pressure signals. Unknown numeric values are -1.
// They intentionally exclude personal content and stable identifiers.
type RuntimeSignals struct {
	UserActive           bool   `json:"user_active"`
	OnBattery            bool   `json:"on_battery"`
	BatteryPercent       int    `json:"battery_percent"`
	MemoryLoadPercent    int    `json:"memory_load_percent"`
	AvailableMemoryBytes uint64 `json:"available_memory_bytes"`
	ThermalCelsius       int    `json:"thermal_celsius"`
}

type BackgroundBudget struct {
	MaxCPUPercent int      `json:"max_cpu_percent"`
	MaxGPUPercent int      `json:"max_gpu_percent"`
	MaxWorkers    int      `json:"max_workers"`
	Paused        bool     `json:"paused"`
	Preempt       bool     `json:"preempt"`
	Reasons       []string `json:"reasons,omitempty"`
}

func clampPercent(v int) int {
	if v < 1 {
		return 1
	}
	if v > 100 {
		return 100
	}
	return v
}

func tighten(current, ceiling int) int {
	if current <= 0 || current > ceiling {
		return ceiling
	}
	return current
}

func BaseBackgroundBudget(policy Policy) BackgroundBudget {
	workers := policy.MaxBackgroundWorkers
	if workers < 1 {
		workers = 1
	}
	return BackgroundBudget{
		MaxCPUPercent: clampPercent(policy.MaxBackgroundCPUPercent),
		MaxGPUPercent: clampPercent(policy.MaxBackgroundGPUPercent),
		MaxWorkers:    workers,
	}
}

// EffectiveBackgroundBudget only tightens the base policy. Foreground activity
// preempts cooperative work and throttles future admission without making an
// interactive caller wait indefinitely for the whole machine to become idle.
// Power, thermal and memory pressure either throttle or pause background work.
func EffectiveBackgroundBudget(policy Policy, signals RuntimeSignals) BackgroundBudget {
	b := BaseBackgroundBudget(policy)
	addReason := func(reason string) { b.Reasons = append(b.Reasons, reason) }

	if signals.UserActive {
		b.Preempt = true
		b.MaxCPUPercent = tighten(b.MaxCPUPercent, 2)
		b.MaxGPUPercent = tighten(b.MaxGPUPercent, 5)
		b.MaxWorkers = 1
		addReason("foreground-active")
	}
	if signals.OnBattery {
		b.MaxCPUPercent = tighten(b.MaxCPUPercent, 3)
		b.MaxGPUPercent = tighten(b.MaxGPUPercent, 8)
		b.MaxWorkers = 1
		addReason("on-battery")
		if signals.BatteryPercent >= 0 && signals.BatteryPercent <= 20 {
			b.Paused = true
			addReason("battery-low")
		}
	}
	if signals.MemoryLoadPercent >= 90 || (signals.AvailableMemoryBytes > 0 && signals.AvailableMemoryBytes < minCriticalMemory) {
		b.Paused = true
		addReason("memory-critical")
	} else if signals.MemoryLoadPercent >= 80 {
		b.MaxCPUPercent = tighten(b.MaxCPUPercent, 2)
		b.MaxGPUPercent = tighten(b.MaxGPUPercent, 5)
		b.MaxWorkers = 1
		addReason("memory-pressure")
	}
	if signals.ThermalCelsius >= 85 {
		b.Paused = true
		addReason("thermal-critical")
	} else if signals.ThermalCelsius >= 75 {
		b.MaxCPUPercent = tighten(b.MaxCPUPercent, 3)
		b.MaxGPUPercent = tighten(b.MaxGPUPercent, 8)
		b.MaxWorkers = 1
		addReason("thermal-pressure")
	}
	return b
}

type SignalSource interface {
	Sample(context.Context) (RuntimeSignals, error)
}

type SystemSignalSource struct{}

func (SystemSignalSource) Sample(ctx context.Context) (RuntimeSignals, error) {
	if ctx == nil {
		return RuntimeSignals{}, fmt.Errorf("nil signal context")
	}
	if err := ctx.Err(); err != nil {
		return RuntimeSignals{}, err
	}
	return sampleSystemSignals()
}

// WatchGovernor periodically refreshes a governor from system pressure. Sensor
// errors keep the previous safe budget rather than inventing optimistic state.
func WatchGovernor(ctx context.Context, governor *Governor, source SignalSource, interval time.Duration) error {
	if ctx == nil || governor == nil || source == nil {
		return fmt.Errorf("adaptive governor requires context, governor and signal source")
	}
	if interval < time.Second {
		interval = time.Second
	}
	sample := func() {
		if signals, err := source.Sample(ctx); err == nil {
			governor.UpdateSignals(signals)
		}
	}
	sample()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			sample()
		}
	}
}
