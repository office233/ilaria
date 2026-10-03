//go:build linux

package resource

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxEnergyReaderPowercapFixture(t *testing.T) {
	root := t.TempDir()
	zone := filepath.Join(root, "fixture-control", "fixture-zone")
	if err := os.MkdirAll(zone, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFixture := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(zone, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeFixture("name", "fixture-package\n")
	writeFixture("max_energy_range_uj", "1000000\n")
	writeFixture("energy_uj", "100\n")

	sampler := newEnergySampler(newLinuxEnergyReader(root))
	first := sampler.Sample()
	if first.Status != EnergyStatusAvailable || len(first.Counters) != 1 {
		t.Fatalf("first = %+v", first)
	}
	if first.Counters[0].Source != "linux_powercap" ||
		first.Counters[0].Scope != "powercap_zone" ||
		first.Counters[0].Domain != "fixture-package" ||
		first.Counters[0].Unit != EnergyUnitMicrojoule ||
		first.Counters[0].CounterRange != 1_000_000 {
		t.Fatalf("counter metadata = %+v", first.Counters[0])
	}

	writeFixture("energy_uj", "250\n")
	second := sampler.Sample().Counters[0]
	if second.DeltaStatus != EnergyDeltaMeasured {
		t.Fatalf("second = %+v", second)
	}
	if math.Abs(second.DeltaJoules-150e-6) > 1e-15 {
		t.Fatalf("delta = %.15f; want %.15f", second.DeltaJoules, 150e-6)
	}
}

func TestLinuxEnergyReaderMissingPowercapIsUnavailable(t *testing.T) {
	reader := newLinuxEnergyReader(filepath.Join(t.TempDir(), "missing"))
	got := reader.readEnergy()
	if got.Status != EnergyStatusUnavailable || got.Reason != "no_counter" {
		t.Fatalf("sample = %+v", got)
	}
}

func TestLinuxEnergyReaderFollowsTopLevelClassSymlink(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	zone := filepath.Join(target, "fixture-zone")
	if err := os.MkdirAll(zone, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"name":                "fixture-symlink-zone\n",
		"energy_uj":           "42\n",
		"max_energy_range_uj": "1000\n",
	} {
		if err := os.WriteFile(filepath.Join(zone, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(target, filepath.Join(root, "fixture-control")); err != nil {
		t.Fatal(err)
	}

	got := newLinuxEnergyReader(root).readEnergy()
	if got.Status != EnergyStatusAvailable || len(got.Counters) != 1 {
		t.Fatalf("sample = %+v", got)
	}
	counter := got.Counters[0]
	if counter.ID != "linux_powercap:fixture-control/fixture-zone" ||
		counter.Domain != "fixture-symlink-zone" ||
		counter.Counter != 42 {
		t.Fatalf("counter = %+v", counter)
	}
}

func TestLinuxEnergyCapabilityProbe(t *testing.T) {
	sampler := NewEnergySampler()
	defer sampler.Close()
	got := sampler.Sample()
	t.Logf("observed Linux powercap capability: status=%s reason=%s counters=%d", got.Status, got.Reason, len(got.Counters))
	for _, counter := range got.Counters {
		t.Logf("counter id=%s status=%s scope=%s domain=%q unit=%s reason=%s", counter.ID, counter.Status, counter.Scope, counter.Domain, counter.Unit, counter.Reason)
	}
}
