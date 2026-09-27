package cbf

import (
	"context"
	"testing"
	"time"
)

func TestControlBarrierFunctionsAndSimplex(t *testing.T) {
	env := SafetyEnvelope{
		MaxThermalC:  80.0,
		MaxVelocity:  3.0,
		MaxPosition:  10.0,
		MaxVibration: 4.0,
	}

	arbiter := NewSimplexArbiter(env)

	// 1. Nominal Safe Control: velocity 1.0 m/s, target torque 15.0
	stateSafe := PhysicalState{
		ThermalC:    45.0,
		VelocityMps: 1.0,
		PositionM:   2.0,
		VibrationG:  0.2,
		Timestamp:   time.Now(),
	}
	uNomSafe := ControlInput{
		ActuationTorque: 12.0,
		AuxCoolingDuty:  0.2,
	}

	resSafe := arbiter.FilterAction(context.Background(), stateSafe, uNomSafe, 5*time.Millisecond)
	if !resSafe.QPSolved || resSafe.SimplexEngaged {
		t.Errorf("Expected nominal input to pass QP filter, got: %+v", resSafe)
	}
	if resSafe.Deviation > 0.01 {
		t.Errorf("Expected minimal/zero deviation for safe control, got: %.2f", resSafe.Deviation)
	}

	// 2. Dangerous Over-Torque: near velocity boundary (v = 2.9 m/s, max = 3.0), AI proposes aggressive 80.0 torque
	stateNearLimit := PhysicalState{
		ThermalC:    50.0,
		VelocityMps: 2.9,
		PositionM:   5.0,
		VibrationG:  0.5,
		Timestamp:   time.Now(),
	}
	uNomAggressive := ControlInput{
		ActuationTorque: 80.0,
		AuxCoolingDuty:  0.3,
	}

	resProjected := arbiter.FilterAction(context.Background(), stateNearLimit, uNomAggressive, 5*time.Millisecond)
	if !resProjected.QPSolved || resProjected.SimplexEngaged {
		t.Errorf("Expected aggressive input to be projected via QP, got: %+v", resProjected)
	}
	if resProjected.CertifiedInput.ActuationTorque >= 80.0 {
		t.Errorf("Expected actuation torque to be constrained by velocity barrier, got: %.2f", resProjected.CertifiedInput.ActuationTorque)
	}
	if resProjected.Deviation <= 0.0 {
		t.Errorf("Expected positive deviation when clamping torque")
	}

	// 3. Thermal Overheating Boundary: Temperature 82.0C exceeds 80.0C limit -> Simplex Trigger
	stateOverheat := PhysicalState{
		ThermalC:    82.0, // Envelope penetrated!
		VelocityMps: 1.5,
		PositionM:   4.0,
		VibrationG:  0.3,
		Timestamp:   time.Now(),
	}
	resSimplex := arbiter.FilterAction(context.Background(), stateOverheat, uNomSafe, 5*time.Millisecond)
	if !resSimplex.SimplexEngaged {
		t.Errorf("Expected Simplex Arbiter to disengage unverified AI on envelope penetration")
	}
	if resSimplex.CertifiedInput.ActuationTorque >= 0 {
		t.Errorf("Expected Certified SBC to execute negative holding braking torque, got: %.2f", resSimplex.CertifiedInput.ActuationTorque)
	}
	if resSimplex.CertifiedInput.AuxCoolingDuty != 1.0 {
		t.Errorf("Expected max auxiliary cooling (1.0) under Simplex holding pattern")
	}

	// 4. AI Latency Deadline Overrun: 500ms > 100ms -> Simplex Trigger
	resDeadline := arbiter.FilterAction(context.Background(), stateSafe, uNomSafe, 500*time.Millisecond)
	if !resDeadline.SimplexEngaged {
		t.Errorf("Expected Simplex Arbiter to trigger on AI deadline overrun")
	}
}
