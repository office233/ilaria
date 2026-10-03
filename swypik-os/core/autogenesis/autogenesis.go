package autogenesis

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"swypik-os/core/evidence"
	"swypik-os/core/hal"
)

// DriverState tracks the lifecycle of a synthesized driver.
type DriverState string

const (
	// StateDraft: source was generated and parsed; nothing else was proven.
	StateDraft DriverState = "DRAFT"
	// The states below are reserved for a pipeline that compiles, statically
	// verifies, sandbox-tests, checks protocol conformance, probes the
	// hardware, signs, loads and confirms telemetry. This package implements
	// none of those steps, so it never assigns them.
	StateCompiled DriverState = "COMPILED"
	StateActive   DriverState = "ACTIVE"
	StateDegraded DriverState = "DEGRADED"
	StateFailed   DriverState = "FAILED"
)

// SynthesizedDriver is a generated driver candidate. Its source has no
// hardware transport: every device operation returns an error.
type SynthesizedDriver struct {
	DeviceID      string            `json:"device_id"`
	DeviceName    string            `json:"device_name"`
	Class         hal.DeviceClass   `json:"class"`
	Bus           hal.BusType       `json:"bus"`
	Protocol      string            `json:"protocol"`
	SourceCode    string            `json:"source_code"`
	Checksum      string            `json:"checksum"`
	State         DriverState       `json:"state"`
	Evidence      evidence.Level    `json:"evidence"`
	ExportedFuncs []string          `json:"exported_funcs"`
	Metrics       map[string]string `json:"metrics"`
	CreatedAt     time.Time         `json:"created_at"`
}

// Synthesizer generates driver candidates for devices without a driver.
type Synthesizer struct {
	mu           sync.RWMutex
	cacheDir     string
	drivers      map[string]*SynthesizedDriver
	totalSynthed int64
}

// NewSynthesizer initializes the driver candidate generator.
func NewSynthesizer(cacheDir string) *Synthesizer {
	if cacheDir == "" {
		if cwd, err := os.Getwd(); err == nil {
			cacheDir = filepath.Join(cwd, "data", "drivers")
		} else {
			cacheDir = filepath.Join(".", "data", "drivers")
		}
	}

	return &Synthesizer{
		cacheDir: cacheDir,
		drivers:  make(map[string]*SynthesizedDriver),
	}
}

// SynthesizeDriver generates and syntax-checks a driver candidate. The result
// is always a DRAFT with simulated evidence, and the device is marked as having
// an unverified candidate, never as ready.
func (s *Synthesizer) SynthesizeDriver(dev *hal.DiscoveredDevice) (*SynthesizedDriver, error) {
	if dev == nil {
		return nil, fmt.Errorf("device is nil")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, exists := s.drivers[dev.ID]; exists {
		return existing, nil
	}

	start := time.Now()
	src, exportedFuncs, err := s.generateDriverSource(dev)
	if err != nil {
		return nil, fmt.Errorf("code synthesis failed: %w", err)
	}

	fset := token.NewFileSet()
	if _, err := parser.ParseFile(fset, dev.ID+".go", src, parser.AllErrors); err != nil {
		return nil, fmt.Errorf("synthesized code failed syntax verification: %w", err)
	}

	h := sha256.Sum256([]byte(src))

	driver := &SynthesizedDriver{
		DeviceID:      dev.ID,
		DeviceName:    dev.Name,
		Class:         dev.Class,
		Bus:           dev.Bus,
		Protocol:      dev.Protocol,
		SourceCode:    src,
		Checksum:      hex.EncodeToString(h[:]),
		State:         StateDraft,
		Evidence:      evidence.Simulated,
		ExportedFuncs: exportedFuncs,
		Metrics: map[string]string{
			"synthesis_latency_us": strconv.FormatInt(time.Since(start).Microseconds(), 10),
			"syntax_parsed":        "true",
			"compiled":             "false",
			"loaded":               "false",
			"hardware_probe":       "not_performed",
		},
		CreatedAt: time.Now(),
	}

	safeFileName := strings.NewReplacer("/", "_", "\\", "_", ":", "_").Replace(dev.ID)
	if err := os.MkdirAll(s.cacheDir, 0700); err != nil {
		driver.Metrics["cached_to_disk"] = "false: " + err.Error()
	} else if err := os.WriteFile(filepath.Join(s.cacheDir, safeFileName+".go"), []byte(src), 0600); err != nil {
		driver.Metrics["cached_to_disk"] = "false: " + err.Error()
	} else {
		driver.Metrics["cached_to_disk"] = "true"
	}

	s.drivers[dev.ID] = driver
	s.totalSynthed++

	dev.DriverStatus = hal.DriverCandidate

	return driver, nil
}

// generateDriverSource emits a candidate driver skeleton for the device class.
// It has no bus transport, so each device operation validates its arguments and
// then returns errNoTransport instead of inventing a reading or an actuation.
func (s *Synthesizer) generateDriverSource(dev *hal.DiscoveredDevice) (string, []string, error) {
	var validPkg strings.Builder
	for _, r := range strings.ToLower(dev.ID) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			validPkg.WriteRune(r)
		} else {
			validPkg.WriteRune('_')
		}
	}
	pkgName := validPkg.String()
	if len(pkgName) == 0 || (pkgName[0] >= '0' && pkgName[0] <= '9') {
		pkgName = "pkg_" + pkgName
	}

	var funcs []string
	var code strings.Builder
	const structName = "DeviceController"

	fmt.Fprintf(&code, "// UNVERIFIED DRIVER CANDIDATE for %s\n", generatedCommentText(dev.Name))
	fmt.Fprintf(&code, "// Bus: %s | Protocol: %s\n", generatedCommentText(string(dev.Bus)), generatedCommentText(dev.Protocol))
	code.WriteString("// Syntax-checked only: never compiled, loaded or run against hardware.\n")
	code.WriteString("// It has no bus transport; every device operation returns errNoTransport.\n\n")
	fmt.Fprintf(&code, "package %s\n\n", pkgName)
	if dev.Class == hal.ClassVehicle || dev.Class == hal.ClassRobot {
		code.WriteString("import (\n\t\"context\"\n\t\"errors\"\n\t\"fmt\"\n)\n\n")
	} else {
		code.WriteString("import \"errors\"\n\n")
	}
	code.WriteString("var errNoTransport = errors.New(\"driver candidate has no hardware transport\")\n\n")

	fmt.Fprintf(&code, "type %s struct {\n\tdeviceID string\n\tport     string\n}\n\n", structName)
	fmt.Fprintf(&code, "func New%s(port string) *%s {\n\treturn &%s{deviceID: %q, port: port}\n}\n\n", structName, structName, structName, dev.ID)
	funcs = append(funcs, "New"+structName)

	method := func(name, signature, body string) {
		fmt.Fprintf(&code, "func (c *%s) %s%s {\n%s}\n\n", structName, name, signature, body)
		funcs = append(funcs, name)
	}

	switch dev.Class {
	case hal.ClassVehicle:
		method("QueryPID", "(ctx context.Context, mode byte, pid byte) (float64, error)",
			"\treturn 0, fmt.Errorf(\"query PID 0x%02X: %w\", pid, errNoTransport)\n")
		method("SetCabinComfort", "(tempCelsius float64) error",
			"\tif tempCelsius < 16.0 || tempCelsius > 30.0 {\n\t\treturn fmt.Errorf(\"comfort temp out of safe bounds\")\n\t}\n\treturn errNoTransport\n")
	case hal.ClassRobot:
		method("MoveJoint", "(ctx context.Context, jointID int, angleDeg float64) error",
			"\tif angleDeg < -180.0 || angleDeg > 180.0 {\n\t\treturn fmt.Errorf(\"kinematic joint angle limit violation\")\n\t}\n\treturn errNoTransport\n")
		method("ActuateGripper", "(gripPercent float64) error",
			"\tif gripPercent < 0 || gripPercent > 100 {\n\t\treturn fmt.Errorf(\"gripper percentage out of range\")\n\t}\n\treturn errNoTransport\n")
		method("EmergencyStop", "() error",
			"\t// A software driver must never be the only stop path; this candidate cannot reach one.\n\treturn errNoTransport\n")
	case hal.ClassAppliance:
		method("SetRelay", "(channel int, state bool) error", "\treturn errNoTransport\n")
		method("ReadPowerWatts", "() (float64, error)", "\treturn 0, errNoTransport\n")
	default:
		method("ReadRawTelemetry", "() (map[string]float64, error)", "\treturn nil, errNoTransport\n")
	}
	method("Close", "() error", "\treturn nil\n")

	return code.String(), funcs, nil
}

func generatedCommentText(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r == '\u2028' || r == '\u2029' || r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
}

// GetDriver returns a synthesized driver candidate.
func (s *Synthesizer) GetDriver(deviceID string) (*SynthesizedDriver, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.drivers[deviceID]
	return d, ok
}

// ListDrivers returns all synthesized driver candidates.
func (s *Synthesizer) ListDrivers() []*SynthesizedDriver {
	s.mu.RLock()
	defer s.mu.RUnlock()
	res := make([]*SynthesizedDriver, 0, len(s.drivers))
	for _, d := range s.drivers {
		res = append(res, d)
	}
	return res
}

// TotalSynthesized returns the count of generated drivers.
func (s *Synthesizer) TotalSynthesized() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.totalSynthed
}
