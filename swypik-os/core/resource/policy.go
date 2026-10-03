// Package resource defines the OS-wide background resource policy.
//
// The default is intentionally conservative: foreground responsiveness and
// battery/thermal headroom always win over indexing, contribution or polling.
// Explicit profiles override automatic selection; automatic performance mode is
// reserved for clearly provisioned battery-less workstations and remains bounded.
package resource

import (
	"runtime"
	"runtime/debug"
	"time"

	"swypik-os/core/devicesynth"
	controlkernelcontract "swypik-os/generated/controlkernel"
)

type Profile string

const (
	ProfilePhone       Profile = "phone"
	ProfileBalanced    Profile = "balanced"
	ProfilePerformance Profile = "performance"
)

type Policy struct {
	Profile                 Profile
	DeviceClass             devicesynth.PlatformClass
	MaxBackgroundCPUPercent int
	MaxBackgroundGPUPercent int
	MaxBackgroundWorkers    int
	StatusPollInterval      time.Duration
	SearchMaxFiles          int
	SearchMaxDocuments      int
	SearchMaxTextBytes      int
	MaxGraphCheckpoints     int
	MemoryLimitMB           int
	GCPercent               int
	MaxTrainingDeltaParams  int
	MaxPendingDeltas        int
	MaxChatHistoryMessages  int
	MaxDocumentBytes        int
	MaxAppCatalogEntries    int
	MaxResidentPeers        int
	MaxHiveTasks            int
	P2PInspectionQueue      int
	P2PInspectionPayloadMax int
}

func normalizeDeviceClass(class devicesynth.PlatformClass) devicesynth.PlatformClass {
	if class == "" {
		return devicesynth.PlatformUnknown
	}
	return class
}

// ForDeviceClass tightens a base profile for the operational class represented
// by the signed Hardware Manifest. It never raises any background limit above
// the selected profile. Automotive applies only to infotainment/compute-domain
// work; safety-critical actuation is governed elsewhere.
func ForDeviceClass(base Policy, class devicesynth.PlatformClass) Policy {
	class = normalizeDeviceClass(class)
	base.DeviceClass = class
	tightenInt := func(current, ceiling int) int {
		if current <= 0 || current > ceiling {
			return ceiling
		}
		return current
	}
	minPoll := func(current, floor time.Duration) time.Duration {
		if current < floor {
			return floor
		}
		return current
	}

	switch class {
	case devicesynth.PlatformMobile:
		base.MaxBackgroundCPUPercent = tightenInt(base.MaxBackgroundCPUPercent, 3)
		base.MaxBackgroundGPUPercent = tightenInt(base.MaxBackgroundGPUPercent, 8)
		base.MaxBackgroundWorkers = tightenInt(base.MaxBackgroundWorkers, 1)
		base.StatusPollInterval = minPoll(base.StatusPollInterval, 30*time.Second)
		base.MemoryLimitMB = tightenInt(base.MemoryLimitMB, 128)
		base.MaxTrainingDeltaParams = tightenInt(base.MaxTrainingDeltaParams, 32768)
	case devicesynth.PlatformAutomotive:
		base.MaxBackgroundCPUPercent = tightenInt(base.MaxBackgroundCPUPercent, 2)
		base.MaxBackgroundGPUPercent = tightenInt(base.MaxBackgroundGPUPercent, 5)
		base.MaxBackgroundWorkers = tightenInt(base.MaxBackgroundWorkers, 1)
		base.MemoryLimitMB = tightenInt(base.MemoryLimitMB, 192)
		base.MaxTrainingDeltaParams = tightenInt(base.MaxTrainingDeltaParams, 32768)
	case devicesynth.PlatformRobot:
		base.MaxBackgroundCPUPercent = tightenInt(base.MaxBackgroundCPUPercent, 3)
		base.MaxBackgroundGPUPercent = tightenInt(base.MaxBackgroundGPUPercent, 8)
		base.MaxBackgroundWorkers = tightenInt(base.MaxBackgroundWorkers, 1)
		base.MemoryLimitMB = tightenInt(base.MemoryLimitMB, 192)
		base.MaxTrainingDeltaParams = tightenInt(base.MaxTrainingDeltaParams, 32768)
	case devicesynth.PlatformAppliance, devicesynth.PlatformEmbedded:
		base.MaxBackgroundCPUPercent = tightenInt(base.MaxBackgroundCPUPercent, 2)
		base.MaxBackgroundGPUPercent = tightenInt(base.MaxBackgroundGPUPercent, 5)
		base.MaxBackgroundWorkers = tightenInt(base.MaxBackgroundWorkers, 1)
		base.StatusPollInterval = minPoll(base.StatusPollInterval, 30*time.Second)
		base.MemoryLimitMB = tightenInt(base.MemoryLimitMB, 128)
		base.MaxTrainingDeltaParams = tightenInt(base.MaxTrainingDeltaParams, 32768)
	}
	return base
}

func ForProfile(profile Profile) Policy {
	switch profile {
	case ProfilePhone:
		return Policy{
			Profile:                 ProfilePhone,
			DeviceClass:             devicesynth.PlatformUnknown,
			MaxBackgroundCPUPercent: 3,
			MaxBackgroundGPUPercent: 8,
			MaxBackgroundWorkers:    1,
			StatusPollInterval:      30 * time.Second,
			SearchMaxFiles:          1000,
			SearchMaxDocuments:      1000,
			SearchMaxTextBytes:      4096,
			MaxGraphCheckpoints:     4,
			MemoryLimitMB:           128,
			GCPercent:               50,
			MaxTrainingDeltaParams:  32768,
			MaxPendingDeltas:        16,
			MaxChatHistoryMessages:  20,
			MaxDocumentBytes:        128 << 10,
			MaxAppCatalogEntries:    32,
			MaxResidentPeers:        16,
			MaxHiveTasks:            16,
			P2PInspectionQueue:      4,
			P2PInspectionPayloadMax: 2048,
		}
	case ProfilePerformance:
		return Policy{
			Profile:                 ProfilePerformance,
			DeviceClass:             devicesynth.PlatformUnknown,
			MaxBackgroundCPUPercent: 25,
			MaxBackgroundGPUPercent: 50,
			MaxBackgroundWorkers:    4,
			StatusPollInterval:      2 * time.Second,
			SearchMaxFiles:          20000,
			SearchMaxDocuments:      20000,
			SearchMaxTextBytes:      16384,
			MaxGraphCheckpoints:     32,
			MemoryLimitMB:           512,
			GCPercent:               125,
			MaxTrainingDeltaParams:  1000000,
			MaxPendingDeltas:        256,
			MaxChatHistoryMessages:  100,
			MaxDocumentBytes:        4 << 20,
			MaxAppCatalogEntries:    512,
			MaxResidentPeers:        512,
			MaxHiveTasks:            256,
			P2PInspectionQueue:      32,
			P2PInspectionPayloadMax: 64 << 10,
		}
	default:
		return Policy{
			Profile:                 ProfileBalanced,
			DeviceClass:             devicesynth.PlatformUnknown,
			MaxBackgroundCPUPercent: 8,
			MaxBackgroundGPUPercent: 20,
			MaxBackgroundWorkers:    2,
			StatusPollInterval:      10 * time.Second,
			SearchMaxFiles:          5000,
			SearchMaxDocuments:      5000,
			SearchMaxTextBytes:      8192,
			MaxGraphCheckpoints:     8,
			MemoryLimitMB:           192,
			GCPercent:               75,
			MaxTrainingDeltaParams:  131072,
			MaxPendingDeltas:        64,
			MaxChatHistoryMessages:  60,
			MaxDocumentBytes:        512 << 10,
			MaxAppCatalogEntries:    128,
			MaxResidentPeers:        128,
			MaxHiveTasks:            128,
			P2PInspectionQueue:      8,
			P2PInspectionPayloadMax: 8 << 10,
		}
	}
}

// Default returns the process resource policy. A valid explicit
// SWYPIK_RESOURCE_PROFILE always wins; otherwise the profile is selected from
// conservative host facts. Unknown explicit values fail closed to balanced.
func Default() Policy {
	return DefaultSelection().Policy
}

// ApplyRuntime applies process-wide Go memory/GC limits. It is intended for
// SwypikOS control/UI processes only; Ilaria model runtimes have separate
// memory governance.
func ApplyRuntime(policy Policy) {
	procs := runtime.NumCPU()
	switch policy.Profile {
	case ProfilePhone:
		if procs > 1 {
			procs = 1
		}
	case ProfileBalanced:
		if procs > 2 {
			procs = 2
		}
	case ProfilePerformance:
		// Use all available logical CPUs.
	}
	if procs < 1 {
		procs = 1
	}
	runtime.GOMAXPROCS(procs)
	if policy.MemoryLimitMB > 0 {
		desired := int64(policy.MemoryLimitMB) << 20
		current := debug.SetMemoryLimit(-1)
		// Never relax a stricter process-local memory ceiling already chosen by
		// a component (for example, the native desktop's measured 24 MiB cap).
		if current <= 0 || desired < current {
			debug.SetMemoryLimit(desired)
		}
	}
	if policy.GCPercent > 0 {
		previous := debug.SetGCPercent(policy.GCPercent)
		// Lower GOGC collects earlier and is the stricter memory posture.
		if previous >= 0 && previous < policy.GCPercent {
			debug.SetGCPercent(previous)
		}
	}
}

func (p Policy) Contract() controlkernelcontract.ResourcePolicy {
	return controlkernelcontract.ResourcePolicy{
		Profile:                 string(p.Profile),
		DeviceClass:             string(normalizeDeviceClass(p.DeviceClass)),
		MaxBackgroundCPUPercent: uint64(p.MaxBackgroundCPUPercent),
		MaxBackgroundGPUPercent: uint64(p.MaxBackgroundGPUPercent),
		MaxBackgroundWorkers:    uint64(p.MaxBackgroundWorkers),
		StatusPollMS:            uint64(p.StatusPollInterval / time.Millisecond),
		SearchMaxFiles:          uint64(p.SearchMaxFiles),
		SearchMaxDocuments:      uint64(p.SearchMaxDocuments),
		SearchMaxTextBytes:      uint64(p.SearchMaxTextBytes),
		MaxGraphCheckpoints:     uint64(p.MaxGraphCheckpoints),
		MemoryLimitMB:           uint64(p.MemoryLimitMB),
		GCPercent:               uint64(p.GCPercent),
		MaxTrainingDeltaParams:  uint64(p.MaxTrainingDeltaParams),
		MaxPendingDeltas:        uint64(p.MaxPendingDeltas),
		MaxChatHistoryMessages:  uint64(p.MaxChatHistoryMessages),
		MaxDocumentBytes:        uint64(p.MaxDocumentBytes),
		MaxAppCatalogEntries:    uint64(p.MaxAppCatalogEntries),
		MaxResidentPeers:        uint64(p.MaxResidentPeers),
		MaxHiveTasks:            uint64(p.MaxHiveTasks),
		P2PInspectionQueue:      uint64(p.P2PInspectionQueue),
		P2PInspectionPayloadMax: uint64(p.P2PInspectionPayloadMax),
	}
}
