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
	"swypik-os/core/devicesynth"
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
	if env.HardwareManifest.DeviceClass != devicesynth.PlatformWorkstation {
		t.Fatalf("device class=%q want workstation", env.HardwareManifest.DeviceClass)
	}
	if plan.ResourcePolicy.DeviceClass != string(devicesynth.PlatformWorkstation) || plan.ResourcePolicy.Profile == "" {
		t.Fatalf("resource policy not derived from manifest: %+v", plan.ResourcePolicy)
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

func TestProbeTargetCarriesExplicitHALResourcesWithoutFabrication(t *testing.T) {
	manager := hal.NewManager()
	manager.RegisterScanner(func(context.Context) ([]*hal.DiscoveredDevice, error) {
		return []*hal.DiscoveredDevice{{
			ID:           "dev_fixture_nic",
			Name:         "Fixture NIC",
			Class:        hal.ClassNetwork,
			Bus:          hal.BusPCIe,
			Protocol:     "FIXTURE",
			DriverStatus: hal.DriverNeedsAutogenesis,
			Resources: []hal.HardwareResource{
				{Kind: hal.ResourceMMIO, Start: 0xfebf0000, Length: 0x1000},
				{Kind: hal.ResourceIRQ, Start: 17, Length: 1},
			},
		}}, nil
	})
	eng := universal.NewInstallerEngine(manager, autogenesis.NewSynthesizer(t.TempDir()))
	env, err := eng.ProbeTarget(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var resources []devicesynth.DeviceResource
	for _, resource := range env.HardwareManifest.Graph.Resources {
		if resource.DeviceID == "dev_fixture_nic" {
			resources = append(resources, resource)
		}
	}
	if len(resources) != 2 || resources[0].Kind != devicesynth.ResourceIRQ && resources[1].Kind != devicesynth.ResourceIRQ {
		t.Fatalf("manifest resources=%+v", resources)
	}
	for _, resource := range env.HardwareManifest.Graph.Resources {
		if resource.DeviceID == "dev_host_compute_0" {
			t.Fatalf("legacy HAL fabricated host-compute authority: %+v", resource)
		}
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
	robotPlan := engRobot.GenerateAdaptationPlan(envRobot)
	if mode := robotPlan.SafetyGovernorMode; mode != "ROBOTICS_ESTOP_ARMED" {
		t.Error(mode)
	}
	if envRobot.HardwareManifest.DeviceClass != devicesynth.PlatformRobot || robotPlan.ResourcePolicy.DeviceClass != string(devicesynth.PlatformRobot) {
		t.Fatalf("robot manifest/policy mismatch: class=%q policy=%+v", envRobot.HardwareManifest.DeviceClass, robotPlan.ResourcePolicy)
	}
	if robotPlan.ResourcePolicy.MaxBackgroundWorkers != 1 || robotPlan.ResourcePolicy.MaxBackgroundCPUPercent > 3 || robotPlan.ResourcePolicy.MaxBackgroundGPUPercent > 8 {
		t.Fatalf("robot background envelope too permissive: %+v", robotPlan.ResourcePolicy)
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
	vehiclePlan := engVehicle.GenerateAdaptationPlan(envVehicle)
	if mode := vehiclePlan.SafetyGovernorMode; mode != "AUTOMOTIVE_CRITICAL_WATCHDOG" {
		t.Error(mode)
	}
	if envVehicle.HardwareManifest.DeviceClass != devicesynth.PlatformAutomotive || vehiclePlan.ResourcePolicy.DeviceClass != string(devicesynth.PlatformAutomotive) {
		t.Fatalf("vehicle manifest/policy mismatch: class=%q policy=%+v", envVehicle.HardwareManifest.DeviceClass, vehiclePlan.ResourcePolicy)
	}
	if vehiclePlan.ResourcePolicy.MaxBackgroundWorkers != 1 || vehiclePlan.ResourcePolicy.MaxBackgroundCPUPercent > 2 || vehiclePlan.ResourcePolicy.MaxBackgroundGPUPercent > 5 {
		t.Fatalf("automotive background envelope too permissive: %+v", vehiclePlan.ResourcePolicy)
	}
	manifestJSON, err := json.Marshal(envVehicle.HardwareManifest)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(manifestJSON), "1FA6P8CF5H123456") {
		t.Fatal("vehicle private identifier leaked into hardware manifest")
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
