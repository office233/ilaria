package worldmodel

import (
	"math"
	"testing"
)

func TestRobotLimitsHaveNoArtificialDenominatorFloors(t *testing.T) {
	s := simulationFixture(t)
	for _, speed := range []float64{100, -100} {
		assertVeto(t, s.EvaluateRoboticGrip(RobotState{ReachMeters: 0, PayloadKg: 0,
			StallTorque: 100, MaxVelocity: 1}, speed))
	}
	assertVeto(t, s.EvaluateRoboticGrip(RobotState{ReachMeters: 0.1, PayloadKg: 0.1,
		StallTorque: 0.01, MaxVelocity: 1}, 0))
	assertVeto(t, s.EvaluateRoboticGrip(RobotState{ReachMeters: 0.1, PayloadKg: 0.1,
		StallTorque: 0.11, MaxVelocity: 0.01}, 0.01))
	if got := s.EvaluateRoboticGrip(RobotState{ReachMeters: 0.1, PayloadKg: 0.1,
		StallTorque: 1, MaxVelocity: 1}, 0); !got.Safe || got.SimulatedTrajCount != 1 {
		t.Fatalf("valid static evaluation misreported: %+v", got)
	}
}

func TestVehicleRequiresKnownSurfaceAndExplicitGeometry(t *testing.T) {
	s := simulationFixture(t)
	state := VehicleState{VelocityKmh: 60, MassKg: 1500, Surface: "unknown", WheelbaseMeters: 2.7}
	assertVeto(t, s.EvaluateVehicleManeuver(state, 0.4, 0))
	state.Surface = SurfaceDryAsphalt
	state.WheelbaseMeters = 0
	assertVeto(t, s.EvaluateVehicleManeuver(state, 0.4, 0))
	state.WheelbaseMeters = 2.7
	state.SteerAngle = 90
	assertVeto(t, s.EvaluateVehicleManeuver(state, 0.4, 0))
	state.SteerAngle = 0
	straight := s.EvaluateVehicleManeuver(state, 0.4, 0)
	if !straight.Safe || straight.HasLateralSpeedLimit || straight.MaxSafeSpeedKmh != 0 {
		t.Fatalf("straight maneuver has a fabricated turn radius: %+v", straight)
	}
	if got := s.EvaluateVehicleManeuver(state, 0, 0.1); !got.HasLateralSpeedLimit {
		t.Fatal("small nonzero steering was rounded to straight travel")
	}
	if coefficient, err := s.FrictionCoeff("unknown"); coefficient != 0 || err == nil {
		t.Fatal("unknown surface received invented friction")
	}
}

func TestSimulationConfigurationIsRequiredAndOwned(t *testing.T) {
	assertVeto(t, NewSimulator().EvaluateRoboticGrip(RobotState{}, 0))
	assertVeto(t, NewSimulator().EvaluateVehicleManeuver(VehicleState{}, 0, 0))
	config := testCalibration()
	s, err := NewConfiguredSimulator(config)
	if err != nil {
		t.Fatal(err)
	}
	config.SurfaceFriction[SurfaceIce] = 100
	state := VehicleState{VelocityKmh: 80, MassKg: 1500, Surface: SurfaceIce, WheelbaseMeters: 2.7}
	assertVeto(t, s.EvaluateVehicleManeuver(state, 0.6, 0))
	config.GravityMetersS2 = math.NaN()
	if _, err := NewConfiguredSimulator(config); err == nil {
		t.Fatal("nonfinite calibration accepted")
	}
}
