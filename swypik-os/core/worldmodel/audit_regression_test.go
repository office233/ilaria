package worldmodel

import (
	"encoding/json"
	"math"
	"testing"
)

func TestVehicleInvalidTelemetryIsVetoed(t *testing.T) {
	sim := simulationFixture(t)
	valid := VehicleState{VelocityKmh: 60, MassKg: 1500, Surface: SurfaceDryAsphalt, WheelbaseMeters: 2.7}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		state := valid
		state.VelocityKmh = value
		assertVeto(t, sim.EvaluateVehicleManeuver(state, 0.4, 0))
		assertVeto(t, sim.EvaluateVehicleManeuver(valid, value, 0))
		assertVeto(t, sim.EvaluateVehicleManeuver(valid, 0.4, value))
	}
	for _, steer := range []float64{-180, -90, 90, 180} {
		assertVeto(t, sim.EvaluateVehicleManeuver(valid, 0, steer))
	}
}

func TestRobotInvalidTelemetryIsVetoed(t *testing.T) {
	sim := simulationFixture(t)
	valid := RobotState{ReachMeters: 0.5, PayloadKg: 5, StallTorque: 50, MaxVelocity: 2}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		state := valid
		state.PayloadKg = value
		assertVeto(t, sim.EvaluateRoboticGrip(state, 1))
		assertVeto(t, sim.EvaluateRoboticGrip(valid, value))
	}
	invalid := valid
	invalid.StallTorque = 0
	assertVeto(t, sim.EvaluateRoboticGrip(invalid, 1))
}

func TestRobotSpeedDirectionCannotReduceRisk(t *testing.T) {
	sim := simulationFixture(t)
	state := RobotState{ReachMeters: 0.8, PayloadKg: 25, StallTorque: 50, MaxVelocity: 2}
	positive := sim.EvaluateRoboticGrip(state, 10)
	negative := sim.EvaluateRoboticGrip(state, -10)
	if positive.Vetoed != negative.Vetoed || positive.RiskScore != negative.RiskScore {
		t.Fatalf("rotation direction changed load risk: forward=%+v reverse=%+v", positive, negative)
	}
}

func assertVeto(t *testing.T, result SimulationVerdict) {
	t.Helper()
	if result.Safe || !result.Vetoed || result.Reason == "" {
		t.Fatalf("invalid input received a safe verdict: %+v", result)
	}
	if _, err := json.Marshal(result); err != nil {
		t.Fatalf("veto must remain valid JSON: %v", err)
	}
}
