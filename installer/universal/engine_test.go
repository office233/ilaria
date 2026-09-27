package universal_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"swypik-os/core/autogenesis"
	"swypik-os/core/hal"
	"swypik-os/installer/universal"
)

func TestUniversalInstallerPC(t *testing.T) {
	halMgr := hal.NewManager()
	synth := autogenesis.NewSynthesizer("")
	eng := universal.NewInstallerEngine(halMgr, synth)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	env, err := eng.ProbeTarget(ctx)
	if err != nil {
		t.Fatalf("ProbeTarget failed: %v", err)
	}

	if env.PlatformType != universal.PlatformPC {
		t.Errorf("Expected PlatformPC on default workstation, got %s", env.PlatformType)
	}

	plan := eng.GenerateAdaptationPlan(env)
	if plan.TargetProfile != "SwypikOS-Desktop-SpatialLuxury" {
		t.Errorf("Expected desktop profile, got %s", plan.TargetProfile)
	}

	tempDir, err := os.MkdirTemp("", "swypik_install_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	if err := eng.Deploy(ctx, tempDir, env, plan); err != nil {
		t.Fatalf("Deploy failed: %v", err)
	}

	manifestPath := filepath.Join(tempDir, "swypik_deployment_manifest.json")
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		t.Errorf("Deployment manifest was not created at %s", manifestPath)
	}
}

func TestUniversalInstallerRobotAndVehicle(t *testing.T) {
	// Test Robot Platform Adaptation
	halRobot := hal.NewManager()
	halRobot.AttachRobotSimulation("Swypik Robotic Arm", 6)
	synth := autogenesis.NewSynthesizer("")
	engRobot := universal.NewInstallerEngine(halRobot, synth)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	envRobot, err := engRobot.ProbeTarget(ctx)
	if err != nil {
		t.Fatalf("Probe robot failed: %v", err)
	}
	if envRobot.PlatformType != universal.PlatformRobot {
		t.Errorf("Expected PlatformRobot, got %s", envRobot.PlatformType)
	}

	planRobot := engRobot.GenerateAdaptationPlan(envRobot)
	if planRobot.SafetyGovernorMode != "ROBOTICS_ESTOP_ARMED" {
		t.Errorf("Expected ROBOTICS_ESTOP_ARMED, got %s", planRobot.SafetyGovernorMode)
	}

	// Test Vehicle Platform Adaptation
	halVehicle := hal.NewManager()
	halVehicle.AttachVehicleSimulation("Electric Vehicle Gateway", "1FA6P8CF5H123456")
	engVehicle := universal.NewInstallerEngine(halVehicle, synth)

	envVehicle, err := engVehicle.ProbeTarget(ctx)
	if err != nil {
		t.Fatalf("Probe vehicle failed: %v", err)
	}
	if envVehicle.PlatformType != universal.PlatformVehicle {
		t.Errorf("Expected PlatformVehicle, got %s", envVehicle.PlatformType)
	}

	planVehicle := engVehicle.GenerateAdaptationPlan(envVehicle)
	if planVehicle.SafetyGovernorMode != "AUTOMOTIVE_CRITICAL_WATCHDOG" {
		t.Errorf("Expected AUTOMOTIVE_CRITICAL_WATCHDOG, got %s", planVehicle.SafetyGovernorMode)
	}
}

func TestUserDataPartitionMapping(t *testing.T) {
	eng := universal.NewInstallerEngine(nil, nil)

	tempWorkspace, err := os.MkdirTemp("", "swypik_ws_*")
	if err != nil {
		t.Fatalf("Failed to create temp workspace: %v", err)
	}
	defer os.RemoveAll(tempWorkspace)

	mapping, err := eng.MapUserDataPartitions("", tempWorkspace)
	if err != nil {
		t.Fatalf("MapUserDataPartitions failed: %v", err)
	}

	t.Logf("User Data Mapping -> Profile: %s | Mapped Partitions: %d | Files Preserved: %d | Total MB: %.2f | Zero Loss: %v",
		mapping.UserProfilePath, len(mapping.MappedPartitions), mapping.TotalFilesPreserved, mapping.TotalStoragePreservedMB, mapping.ZeroLossVerified)

	if !mapping.ZeroLossVerified {
		t.Errorf("ZeroLossVerified must be true")
	}
	if len(mapping.MappedPartitions) == 0 {
		t.Errorf("Expected at least one partition mapped (e.g. Desktop, Documents)")
	}

	// Verify mount files were created
	mountManifest := filepath.Join(tempWorkspace, "swypik_user_mounts.json")
	if _, err := os.Stat(mountManifest); os.IsNotExist(err) {
		t.Errorf("Mount manifest was not written to %s", mountManifest)
	}
}
