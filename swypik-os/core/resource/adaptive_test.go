package resource

import (
	"context"
	"errors"
	"testing"
	"time"

	"swypik-os/core/devicesynth"
)

func TestSelectProfileFromHardwareFacts(t *testing.T) {
	const gib = uint64(1 << 30)
	tests := []struct {
		name string
		fact HardwareFacts
		want Profile
	}{
		{"android", HardwareFacts{OS: "android", LogicalCPUs: 8, TotalMemoryBytes: 12 * gib}, ProfilePhone},
		{"small-pc", HardwareFacts{OS: "windows", LogicalCPUs: 4, TotalMemoryBytes: 8 * gib}, ProfilePhone},
		{"portable", HardwareFacts{OS: "windows", LogicalCPUs: 8, TotalMemoryBytes: 16 * gib, HasBattery: true}, ProfileBalanced},
		{"desktop", HardwareFacts{OS: "windows", LogicalCPUs: 8, TotalMemoryBytes: 16 * gib}, ProfileBalanced},
		{"workstation", HardwareFacts{OS: "windows", LogicalCPUs: 16, TotalMemoryBytes: 32 * gib}, ProfilePerformance},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := SelectProfile(tt.fact)
			if got != tt.want {
				t.Fatalf("profile=%q want %q", got, tt.want)
			}
		})
	}
}

func TestEffectiveBackgroundBudgetOnlyTightensBase(t *testing.T) {
	base := ForProfile(ProfilePerformance)
	b := EffectiveBackgroundBudget(base, RuntimeSignals{OnBattery: true, BatteryPercent: 55, MemoryLoadPercent: 82, ThermalCelsius: 78})
	if b.Paused {
		t.Fatal("moderate pressure should throttle, not pause")
	}
	if b.MaxCPUPercent > 2 || b.MaxGPUPercent > 5 || b.MaxWorkers != 1 {
		t.Fatalf("budget not tightened enough: %+v", b)
	}
	if b.MaxCPUPercent > base.MaxBackgroundCPUPercent || b.MaxGPUPercent > base.MaxBackgroundGPUPercent || b.MaxWorkers > base.MaxBackgroundWorkers {
		t.Fatalf("adaptive budget relaxed base: %+v base=%+v", b, base)
	}
}

func TestForegroundPreemptsWhileCriticalPressurePausesBackground(t *testing.T) {
	base := ForProfile(ProfileBalanced)
	foreground := EffectiveBackgroundBudget(base, RuntimeSignals{UserActive: true, BatteryPercent: -1, MemoryLoadPercent: -1, ThermalCelsius: -1})
	if foreground.Paused || !foreground.Preempt || foreground.MaxWorkers != 1 || foreground.MaxCPUPercent > 2 || foreground.MaxGPUPercent > 5 {
		t.Fatalf("foreground budget=%+v", foreground)
	}
	for _, signals := range []RuntimeSignals{
		{OnBattery: true, BatteryPercent: 10, MemoryLoadPercent: -1, ThermalCelsius: -1},
		{BatteryPercent: -1, MemoryLoadPercent: 95, ThermalCelsius: -1},
		{BatteryPercent: -1, MemoryLoadPercent: -1, ThermalCelsius: 90},
	} {
		if b := EffectiveBackgroundBudget(base, signals); !b.Paused {
			t.Fatalf("signals %+v did not pause: %+v", signals, b)
		}
	}
}

func TestGovernorPressureCancelsCooperativeRunAndResumes(t *testing.T) {
	g := NewGovernor(ForProfile(ProfileBalanced))
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- g.Run(context.Background(), func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		})
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background unit did not start")
	}
	g.UpdateSignals(RuntimeSignals{UserActive: true, BatteryPercent: -1, MemoryLoadPercent: -1, ThermalCelsius: -1})
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v want canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pressure did not preempt cooperative unit")
	}

	if err := g.Run(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("foreground-throttled governor did not admit cooperative work: %v", err)
	}
	g.UpdateSignals(RuntimeSignals{OnBattery: true, BatteryPercent: 10, MemoryLoadPercent: -1, ThermalCelsius: -1})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := g.Run(ctx, func(context.Context) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("critical-pressure governor admitted work: %v", err)
	}
	g.UpdateSignals(RuntimeSignals{BatteryPercent: -1, MemoryLoadPercent: 20, ThermalCelsius: -1})
	if err := g.Run(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("governor did not resume: %v", err)
	}
}

func TestSelectionFromManifestTightensButNeverRelaxesExplicitProfile(t *testing.T) {
	t.Setenv(profileEnv, "performance")
	manifest := devicesynth.HardwareManifest{
		SchemaVersion: devicesynth.HardwareManifestSchemaV1,
		DeviceClass:   devicesynth.PlatformAutomotive,
		Architecture:  devicesynth.ArchX8664,
		ABI:           "win64",
		Endianness:    devicesynth.EndianLittle,
		Graph: devicesynth.DeviceGraph{
			SchemaVersion: devicesynth.DeviceGraphSchemaV1,
			Devices:       []devicesynth.DeviceNode{},
		},
	}
	selection, err := SelectionFromManifest(manifest, HardwareFacts{OS: "windows", LogicalCPUs: 32, TotalMemoryBytes: 64 << 30})
	if err != nil {
		t.Fatal(err)
	}
	if selection.Policy.Profile != ProfilePerformance || selection.DeviceClass != devicesynth.PlatformAutomotive {
		t.Fatalf("selection=%+v", selection)
	}
	if selection.Policy.MaxBackgroundCPUPercent > 2 || selection.Policy.MaxBackgroundGPUPercent > 5 || selection.Policy.MaxBackgroundWorkers != 1 {
		t.Fatalf("automotive envelope relaxed explicit profile: %+v", selection.Policy)
	}
}

func TestDeviceClassPoliciesRemainWithinBaseEnvelope(t *testing.T) {
	classes := []devicesynth.PlatformClass{
		devicesynth.PlatformWorkstation,
		devicesynth.PlatformMobile,
		devicesynth.PlatformAutomotive,
		devicesynth.PlatformRobot,
		devicesynth.PlatformAppliance,
		devicesynth.PlatformEmbedded,
	}
	for _, class := range classes {
		t.Run(string(class), func(t *testing.T) {
			base := ForProfile(ProfilePerformance)
			got := ForDeviceClass(base, class)
			if got.MaxBackgroundCPUPercent > base.MaxBackgroundCPUPercent || got.MaxBackgroundGPUPercent > base.MaxBackgroundGPUPercent || got.MaxBackgroundWorkers > base.MaxBackgroundWorkers || got.MemoryLimitMB > base.MemoryLimitMB || got.MaxTrainingDeltaParams > base.MaxTrainingDeltaParams {
				t.Fatalf("device class %s relaxed base policy: base=%+v got=%+v", class, base, got)
			}
			if got.DeviceClass != class {
				t.Fatalf("device class=%q want %q", got.DeviceClass, class)
			}
		})
	}
}
