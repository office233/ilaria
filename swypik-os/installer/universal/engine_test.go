package universal_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"swypik-os/core/autogenesis"
	"swypik-os/core/hal"
	"swypik-os/installer/universal"
)

// fixtureProfile creates a user profile with one Documents file so tests never
// list the real user's folders.
func fixtureProfile(t *testing.T) string {
	t.Helper()
	profile := t.TempDir()
	if err := os.MkdirAll(filepath.Join(profile, "Documents", "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "Documents", "fixture.txt"), []byte("owned test fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	return profile
}

func TestUniversalInstallerPCWritesMetadataOnly(t *testing.T) {
	eng := universal.NewInstallerEngine(hal.NewManager(), autogenesis.NewSynthesizer(t.TempDir()))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	env, err := eng.ProbeTarget(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if env.PlatformType != universal.PlatformPC {
		t.Errorf("Expected PC, got %s", env.PlatformType)
	}
	env.PreservedUserData = []string{filepath.Join(fixtureProfile(t), "Documents")}

	plan := eng.GenerateAdaptationPlan(env)
	if plan.TargetProfile != "SwypikOS-Desktop-SpatialLuxury" {
		t.Error(plan.TargetProfile)
	}

	target := t.TempDir()
	if err := eng.Deploy(ctx, target, env, plan); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(target, "swypik_deployment_manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]interface{}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["status"] != "METADATA_ONLY" || manifest["os_installed"] != false {
		t.Errorf("manifest claims an installation: status=%v os_installed=%v", manifest["status"], manifest["os_installed"])
	}
	if strings.Contains(string(raw), "OPERATIONAL") {
		t.Error("manifest still reports OPERATIONAL")
	}
}

func TestUniversalInstallerRobotAndVehicle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	synth := autogenesis.NewSynthesizer(t.TempDir())

	halRobot := hal.NewManager()
	halRobot.AttachRobotSimulation("Swypik Robotic Arm", 6)
	engRobot := universal.NewInstallerEngine(halRobot, synth)
	envRobot, err := engRobot.ProbeTarget(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if envRobot.PlatformType != universal.PlatformRobot {
		t.Error(envRobot.PlatformType)
	}
	if mode := engRobot.GenerateAdaptationPlan(envRobot).SafetyGovernorMode; mode != "ROBOTICS_ESTOP_ARMED" {
		t.Error(mode)
	}

	halVehicle := hal.NewManager()
	halVehicle.AttachVehicleSimulation("Electric Vehicle Gateway", "1FA6P8CF5H123456")
	engVehicle := universal.NewInstallerEngine(halVehicle, synth)
	envVehicle, err := engVehicle.ProbeTarget(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if envVehicle.PlatformType != universal.PlatformVehicle {
		t.Error(envVehicle.PlatformType)
	}
	if mode := engVehicle.GenerateAdaptationPlan(envVehicle).SafetyGovernorMode; mode != "AUTOMOTIVE_CRITICAL_WATCHDOG" {
		t.Error(mode)
	}
}

// The mapping is a descriptor inventory. It must never claim zero-loss, and it
// must count only regular files toward the byte total.
func TestUserDataPartitionMappingClaimsNoProtection(t *testing.T) {
	eng := universal.NewInstallerEngine(nil, autogenesis.NewSynthesizer(t.TempDir()))
	workspace := t.TempDir()
	mapping, err := eng.MapUserDataPartitions(fixtureProfile(t), workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(mapping.MappedPartitions) != 1 {
		t.Fatalf("mapped %v, want only Documents", mapping.MappedPartitions)
	}
	if !strings.HasPrefix(mapping.DataLossProtection, "NOT_VERIFIED") {
		t.Errorf("data loss protection = %q", mapping.DataLossProtection)
	}
	if mapping.TopLevelEntries != 2 || mapping.TopLevelFileBytes != int64(len("owned test fixture")) {
		t.Errorf("entries=%d bytes=%d, want 2 entries and only the file's bytes", mapping.TopLevelEntries, mapping.TopLevelFileBytes)
	}
	descriptor, err := os.ReadFile(filepath.Join(workspace, "mnt", "Documents.mount"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(descriptor), "GUARANTEED") || !strings.Contains(string(descriptor), "MOUNTED=false") {
		t.Errorf("descriptor overclaims: %s", descriptor)
	}
	if _, err := os.Stat(filepath.Join(workspace, "swypik_user_mounts.json")); err != nil {
		t.Fatal(err)
	}
}

func TestUserDataPartitionMappingReportsWriteFailure(t *testing.T) {
	eng := universal.NewInstallerEngine(nil, autogenesis.NewSynthesizer(t.TempDir()))
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := eng.MapUserDataPartitions(fixtureProfile(t), blocker); err == nil {
		t.Fatal("mapping into an unusable workspace reported success")
	}
}
