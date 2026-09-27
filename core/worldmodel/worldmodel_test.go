package worldmodel

import (
	"testing"
)

func TestWorldModelSimulator(t *testing.T) {
	sim := NewSimulator()

	// 1. Safe dry asphalt braking maneuver (60 km/h, 0.4 G decel, straight)
	dryState := VehicleState{
		VelocityKmh: 60.0,
		SteerAngle:  0.0,
		MassKg:      1500.0,
		Surface:     SurfaceDryAsphalt,
	}

	verdictDry := sim.EvaluateVehicleManeuver(dryState, 0.4, 0.0)
	if !verdictDry.Safe || verdictDry.Vetoed {
		t.Errorf("Expected dry asphalt maneuver to be safe, got: %+v", verdictDry)
	}
	if verdictDry.SimulatedTrajCount != 100 {
		t.Errorf("Expected 100 counterfactuals evaluated, got: %d", verdictDry.SimulatedTrajCount)
	}

	// 2. Dangerous black ice maneuver (80 km/h, aggressive 0.6 G braking)
	iceState := VehicleState{
		VelocityKmh: 80.0,
		SteerAngle:  15.0,
		MassKg:      1500.0,
		Surface:     SurfaceIce,
	}

	verdictIce := sim.EvaluateVehicleManeuver(iceState, 0.6, 15.0)
	if verdictIce.Safe || !verdictIce.Vetoed {
		t.Errorf("Expected aggressive maneuver on black ice to be vetoed, got: %+v", verdictIce)
	}
	if verdictIce.RiskScore < 0.5 {
		t.Errorf("Expected high risk score on black ice, got: %.2f", verdictIce.RiskScore)
	}

	// 3. Robotic Arm Safe Payload (5 kg payload at 0.5m reach with 50 Nm stall torque)
	robotSafe := RobotState{
		ReachMeters: 0.5,
		PayloadKg:   5.0,
		StallTorque: 50.0,
		MaxVelocity: 2.0,
	}
	verdictRobotSafe := sim.EvaluateRoboticGrip(robotSafe, 1.0)
	if !verdictRobotSafe.Safe || verdictRobotSafe.Vetoed {
		t.Errorf("Expected robotic grip to be safe, got: %+v", verdictRobotSafe)
	}

	// 4. Robotic Arm Dangerous Overload (25 kg payload at 0.8m reach with 50 Nm stall torque)
	// Demand: 25 * 9.81 * 0.8 = 196.2 Nm >> 50 Nm
	robotOverload := RobotState{
		ReachMeters: 0.8,
		PayloadKg:   25.0,
		StallTorque: 50.0,
		MaxVelocity: 2.0,
	}
	verdictRobotOverload := sim.EvaluateRoboticGrip(robotOverload, 1.0)
	if verdictRobotOverload.Safe || !verdictRobotOverload.Vetoed {
		t.Errorf("Expected robotic overload to be vetoed, got: %+v", verdictRobotOverload)
	}
}
