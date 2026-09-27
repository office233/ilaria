package autogenesis_test

import (
	"os"
	"path/filepath"
	"testing"

	"swypik-os/core/autogenesis"
	"swypik-os/core/hal"
)

func TestAutogenesisVehicleDriver(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "swypik_drivers_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	synth := autogenesis.NewSynthesizer(tempDir)

	dev := &hal.DiscoveredDevice{
		ID:           "dev_vehicle_can0",
		Name:         "CAN Bus Vehicle Gateway",
		Class:        hal.ClassVehicle,
		Bus:          hal.BusCAN,
		Port:         "vcan0",
		Protocol:     "ISO-15765-4",
		DriverStatus: hal.DriverNeedsAutogenesis,
		Capabilities: []string{"read_rpm", "set_cabin_temp"},
	}

	driver, err := synth.SynthesizeDriver(dev)
	if err != nil {
		t.Fatalf("SynthesizeDriver failed: %v", err)
	}

	if driver.State != autogenesis.StateActive {
		t.Errorf("Expected driver StateActive, got %s", driver.State)
	}

	if len(driver.ExportedFuncs) < 3 {
		t.Errorf("Expected at least 3 exported functions, got %v", driver.ExportedFuncs)
	}

	// Verify file was written to disk
	filePath := filepath.Join(tempDir, dev.ID+".go")
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		t.Errorf("Synthesized driver file was not saved to %s", filePath)
	}

	// Verify HAL device was updated to Ready
	if dev.DriverStatus != hal.DriverReady {
		t.Errorf("Expected HAL DriverReady, got %s", dev.DriverStatus)
	}
}

func TestAutogenesisRobotDriver(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "swypik_drivers_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	synth := autogenesis.NewSynthesizer(tempDir)

	dev := &hal.DiscoveredDevice{
		ID:           "dev_robot_arm_0",
		Name:         "6-DoF Articulated Manipulator",
		Class:        hal.ClassRobot,
		Bus:          hal.BusUART,
		Port:         "COM3",
		Protocol:     "DYNAMIXEL_V2",
		DriverStatus: hal.DriverNeedsAutogenesis,
		Capabilities: []string{"move_joint", "gripper", "estop"},
	}

	driver, err := synth.SynthesizeDriver(dev)
	if err != nil {
		t.Fatalf("SynthesizeDriver failed: %v", err)
	}

	if driver.Checksum == "" {
		t.Error("Expected valid checksum on synthesized driver")
	}

	// Verify idempotency (re-fetching doesn't recreate from scratch)
	driver2, err := synth.SynthesizeDriver(dev)
	if err != nil {
		t.Fatalf("Second SynthesizeDriver call failed: %v", err)
	}
	if driver.Checksum != driver2.Checksum {
		t.Error("Checksum mismatch on cached driver")
	}
}

func TestAutogenesisApplianceDriver(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "swypik_drivers_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	synth := autogenesis.NewSynthesizer(tempDir)

	dev := &hal.DiscoveredDevice{
		ID:           "dev_appliance_relays",
		Name:         "Modbus Power Distribution Relay Hub",
		Class:        hal.ClassAppliance,
		Bus:          hal.BusModbus,
		Port:         "COM4",
		Protocol:     "MODBUS_RTU",
		DriverStatus: hal.DriverNeedsAutogenesis,
		Capabilities: []string{"relay_control", "power_metering"},
	}

	driver, err := synth.SynthesizeDriver(dev)
	if err != nil {
		t.Fatalf("SynthesizeDriver failed: %v", err)
	}

	if driver.Class != hal.ClassAppliance {
		t.Errorf("Expected ClassAppliance, got %s", driver.Class)
	}
}
