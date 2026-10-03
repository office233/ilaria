package autogenesis_test

import (
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swypik-os/core/autogenesis"
	"swypik-os/core/evidence"
	"swypik-os/core/hal"
)

func synthesize(t *testing.T, dev *hal.DiscoveredDevice) (*autogenesis.Synthesizer, *autogenesis.SynthesizedDriver, string) {
	t.Helper()
	dir := t.TempDir()
	synth := autogenesis.NewSynthesizer(dir)
	driver, err := synth.SynthesizeDriver(dev)
	if err != nil {
		t.Fatalf("SynthesizeDriver failed: %v", err)
	}
	return synth, driver, dir
}

func vehicleDevice() *hal.DiscoveredDevice {
	return &hal.DiscoveredDevice{
		ID: "dev_vehicle_can0", Name: "CAN Bus Vehicle Gateway", Class: hal.ClassVehicle,
		Bus: hal.BusCAN, Port: "vcan0", Protocol: "ISO-15765-4",
		DriverStatus: hal.DriverNeedsAutogenesis,
	}
}

// A generated candidate must never be reported as an active driver or make
// the device look ready: nothing compiled, loaded or probed it.
func TestSynthesizedDriverStaysUnverifiedDraft(t *testing.T) {
	dev := vehicleDevice()
	_, driver, dir := synthesize(t, dev)

	if driver.State != autogenesis.StateDraft {
		t.Errorf("state = %s, want %s", driver.State, autogenesis.StateDraft)
	}
	if driver.Evidence != evidence.Simulated {
		t.Errorf("evidence = %s, want %s", driver.Evidence, evidence.Simulated)
	}
	if dev.DriverStatus != hal.DriverCandidate {
		t.Errorf("device driver status = %s, want %s", dev.DriverStatus, hal.DriverCandidate)
	}
	for key, want := range map[string]string{"compiled": "false", "loaded": "false", "hardware_probe": "not_performed", "cached_to_disk": "true"} {
		if got := driver.Metrics[key]; got != want {
			t.Errorf("metric %s = %q, want %q", key, got, want)
		}
	}
	if _, ok := driver.Metrics["zero_sandbox_panics"]; ok {
		t.Error("driver claims a sandbox run that never happened")
	}
	if _, err := os.Stat(filepath.Join(dir, dev.ID+".go")); err != nil {
		t.Errorf("candidate source not cached: %v", err)
	}
}

// Generated device operations must fail loudly instead of returning invented
// readings or pretending an actuator moved.
func TestSynthesizedSourceHasNoFabricatedIO(t *testing.T) {
	_, driver, _ := synthesize(t, vehicleDevice())
	for _, fabricated := range []string{"2450.0", "62.5", "88.0", "340.5", "isOpen: true"} {
		if strings.Contains(driver.SourceCode, fabricated) {
			t.Errorf("candidate source still fabricates %q", fabricated)
		}
	}
	if !strings.Contains(driver.SourceCode, "errNoTransport") {
		t.Error("candidate source does not report its missing transport")
	}
}

func TestSynthesizedSourceNeutralizesMetadataNewlines(t *testing.T) {
	dev := vehicleDevice()
	dev.Name = "gateway\npackage injected"
	dev.Protocol = "ISO-15765-4\nfunc injected() {}"
	_, driver, _ := synthesize(t, dev)
	if strings.Contains(driver.SourceCode, "\npackage injected") || strings.Contains(driver.SourceCode, "\nfunc injected") {
		t.Fatalf("device metadata escaped generated comments:\n%s", driver.SourceCode)
	}
}

// Every generated class must at least type-check against the standard library,
// so a later compile stage starts from code that builds.
func TestSynthesizedSourceTypeChecks(t *testing.T) {
	classes := map[hal.DeviceClass]string{
		hal.ClassVehicle: "QueryPID", hal.ClassRobot: "MoveJoint",
		hal.ClassAppliance: "SetRelay", hal.ClassSensor: "ReadRawTelemetry",
	}
	for class, method := range classes {
		t.Run(string(class), func(t *testing.T) {
			dev := &hal.DiscoveredDevice{ID: "dev-" + strings.ToLower(string(class)) + ":0", Name: "fixture", Class: class}
			_, driver, _ := synthesize(t, dev)

			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, "candidate.go", driver.SourceCode, 0)
			if err != nil {
				t.Fatal(err)
			}
			conf := types.Config{Importer: importer.ForCompiler(fset, "source", nil)}
			if _, err := conf.Check(file.Name.Name, fset, []*ast.File{file}, nil); err != nil {
				t.Fatalf("candidate does not type-check: %v\n%s", err, driver.SourceCode)
			}
			found := false
			for _, name := range driver.ExportedFuncs {
				found = found || name == method
			}
			if !found {
				t.Errorf("exported funcs %v missing %s", driver.ExportedFuncs, method)
			}
		})
	}
}

func TestSynthesizeDriverIsIdempotent(t *testing.T) {
	dev := vehicleDevice()
	synth, first, _ := synthesize(t, dev)
	second, err := synth.SynthesizeDriver(dev)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || synth.TotalSynthesized() != 1 {
		t.Errorf("second synthesis regenerated the candidate (total %d)", synth.TotalSynthesized())
	}
}
