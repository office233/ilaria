package cyber_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"swypik-os/core/autogenesis"
	"swypik-os/core/cyber"
	"swypik-os/core/evidence"
	"swypik-os/core/hal"
)

func setupTestOrchestrator(t *testing.T) *cyber.Orchestrator {
	halMgr := hal.NewManager()
	halMgr.AttachVehicleSimulation("CyberTruck Gateway", "5YJSA1E21LF123456")
	halMgr.AttachRobotSimulation("Swypik Arm 6-DoF", 6)
	halMgr.AttachApplianceSimulation("Modbus Industrial Relay", 4)

	synth := autogenesis.NewSynthesizer(t.TempDir())
	return cyber.NewOrchestrator(halMgr, synth)
}

func TestCyberVehicleCommands(t *testing.T) {
	orch := setupTestOrchestrator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// 1. Set cabin climate in Romanian
	res, err := orch.DispatchIntent(ctx, "seteaza clima la 22.5 grade")
	if err != nil {
		t.Fatalf("Climate command error: %v", err)
	}
	if !res.Success {
		t.Errorf("Expected success, got false: %s", res.FeedbackMessage)
	}
	if !strings.Contains(res.FeedbackMessage, "22.5") {
		t.Errorf("Expected feedback with 22.5, got: %s", res.FeedbackMessage)
	}

	// 2. Query Vehicle Telemetry
	res, err = orch.DispatchIntent(ctx, "car telemetry")
	if err != nil {
		t.Fatalf("Telemetry command error: %v", err)
	}
	if res.Telemetry["speed_kmh"] != 0.0 {
		t.Errorf("Expected the parked simulation speed 0, got %v", res.Telemetry["speed_kmh"])
	}

	// 3. Unlock Doors
	res, err = orch.DispatchIntent(ctx, "descuie portierele")
	if err != nil {
		t.Fatalf("Unlock doors error: %v", err)
	}
	if !strings.Contains(res.FeedbackMessage, "Unlocked") {
		t.Errorf("Expected Unlocked message, got: %s", res.FeedbackMessage)
	}
}

func TestCyberRobotCommands(t *testing.T) {
	orch := setupTestOrchestrator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// 1. Move Joint in Romanian
	res, err := orch.DispatchIntent(ctx, "robot ridica bratul la 45 grade")
	if err != nil {
		t.Fatalf("Move joint error: %v", err)
	}
	if !res.Success {
		t.Errorf("Expected success, got: %s", res.FeedbackMessage)
	}
	if res.Telemetry["joint_1_deg"] != 45.0 {
		t.Errorf("Expected joint_1_deg 45.0, got %v", res.Telemetry["joint_1_deg"])
	}

	// 2. Gripper actuation
	res, err = orch.DispatchIntent(ctx, "strange clestele")
	if err != nil {
		t.Fatalf("Gripper error: %v", err)
	}
	if res.Telemetry["gripper_pct"] != 100.0 {
		t.Errorf("Expected gripper 100%%, got %v", res.Telemetry["gripper_pct"])
	}

	// 3. Drive rover
	res, err = orch.DispatchIntent(ctx, "inainteaza 2.5 metri")
	if err != nil {
		t.Fatalf("Drive rover error: %v", err)
	}
	if res.Telemetry["requested_distance_m"] != 2.5 {
		t.Errorf("Expected requested distance 2.5, got %v", res.Telemetry["requested_distance_m"])
	}
	if _, ok := res.Telemetry["distance_traveled_m"]; ok {
		t.Error("simulation must not report a measured distance")
	}
}

func TestCyberApplianceAndSensor(t *testing.T) {
	orch := setupTestOrchestrator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// 1. Turn ON fan
	res, err := orch.DispatchIntent(ctx, "porneste ventilatorul")
	if err != nil {
		t.Fatalf("Fan ON error: %v", err)
	}
	if res.Telemetry["relay_1"] != 1.0 {
		t.Errorf("Expected relay_1 == 1.0, got %v", res.Telemetry["relay_1"])
	}

	// 2. Turn OFF fan
	res, err = orch.DispatchIntent(ctx, "opreste ventilatorul")
	if err != nil {
		t.Fatalf("Fan OFF error: %v", err)
	}
	if res.Telemetry["relay_1"] != 0.0 {
		t.Errorf("Expected relay_1 == 0.0, got %v", res.Telemetry["relay_1"])
	}

	// 3. Inspect Camera
	res, err = orch.DispatchIntent(ctx, "verifica camera")
	if err != nil {
		t.Fatalf("Camera inspect error: %v", err)
	}
	if res.Success || res.Evidence != evidence.Failed {
		t.Errorf("camera inspection without a camera must fail, got success=%v evidence=%s: %s", res.Success, res.Evidence, res.FeedbackMessage)
	}
}

func TestCyberSafetyGovernorAndEStop(t *testing.T) {
	orch := setupTestOrchestrator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// 1. Safety violation: dangerous temperature
	res, err := orch.DispatchIntent(ctx, "seteaza clima la 45 grade")
	if err != nil {
		t.Fatalf("Expected handled validation, got error: %v", err)
	}
	if res.Success {
		t.Error("Expected command rejection for dangerous temp 45C")
	}
	if !strings.Contains(res.FeedbackMessage, "SAFETY REJECTED") {
		t.Errorf("Expected SAFETY REJECTED prefix, got: %s", res.FeedbackMessage)
	}

	// 2. Trigger Emergency Stop
	estopRes, err := orch.DispatchIntent(ctx, "OPRIRE DE URGENTA")
	if err != nil {
		t.Fatalf("E-Stop error: %v", err)
	}
	if !strings.Contains(estopRes.FeedbackMessage, "EMERGENCY STOP") {
		t.Errorf("Expected emergency stop message, got: %s", estopRes.FeedbackMessage)
	}

	if !orch.IsEStopActive() {
		t.Error("Safety governor should report E-Stop ACTIVE")
	}

	// 3. Any movement command while E-Stop is active must be strictly blocked
	blockedRes, err := orch.DispatchIntent(ctx, "robot ridica bratul la 20 grade")
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if blockedRes.Success {
		t.Error("Motion command MUST be blocked during active E-Stop")
	}

	// 4. Re-arm system
	resetRes, err := orch.DispatchIntent(ctx, "rearmeaza sistemul")
	if err != nil {
		t.Fatalf("Reset error: %v", err)
	}
	if !resetRes.Success {
		t.Error("Expected successful re-arm")
	}

	if orch.IsEStopActive() {
		t.Error("Safety governor should be cleared after re-arm")
	}
}

// No accepted command may claim bus traffic, sensor measurements or a
// physical effect: the orchestrator has no transport, so everything it
// accepts is simulated and must say so.
func TestCyberResultsNeverClaimHardware(t *testing.T) {
	orch := setupTestOrchestrator(t)
	ctx := context.Background()
	prompts := []string{
		"seteaza clima la 22 grade", "descuie portierele", "car telemetry",
		"robot ridica bratul la 30 grade", "strange clestele", "inainteaza 1 metri",
		"porneste ventilatorul", "OPRIRE DE URGENTA", "rearmeaza sistemul",
	}
	forbidden := []string{"via CAN", "CAN Bus command", "Dynamixel", "Modbus-RTU", "No collision detected", "odometry.", "zero artifacts", "operational"}
	for _, prompt := range prompts {
		res, err := orch.DispatchIntent(ctx, prompt)
		if err != nil {
			t.Fatalf("%q: %v", prompt, err)
		}
		if res.Success && res.Evidence != evidence.Simulated {
			t.Errorf("%q: accepted with evidence %s, want %s", prompt, res.Evidence, evidence.Simulated)
		}
		if res.Evidence.Real() {
			t.Errorf("%q: claims real evidence %s without any transport", prompt, res.Evidence)
		}
		if !strings.Contains(res.FeedbackMessage, "SIMULATION") {
			t.Errorf("%q: message does not say it is a simulation: %s", prompt, res.FeedbackMessage)
		}
		for _, claim := range forbidden {
			if strings.Contains(res.FeedbackMessage, claim) {
				t.Errorf("%q: message claims %q: %s", prompt, claim, res.FeedbackMessage)
			}
		}
	}
}
