package cbf

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestNonFiniteControlEngagesHoldingPattern(t *testing.T) {
	arbiter := NewSimplexArbiter(SafetyEnvelope{})
	state := PhysicalState{ThermalC: 25, VelocityMps: 1, PositionM: 1, VibrationG: 0.1}
	for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		result := arbiter.FilterAction(context.Background(), state, ControlInput{ActuationTorque: bad}, time.Millisecond)
		if !result.SimplexEngaged || result.QPSolved || math.IsNaN(result.CertifiedInput.ActuationTorque) || math.IsInf(result.CertifiedInput.ActuationTorque, 0) {
			t.Fatalf("invalid nominal torque accepted: %+v", result)
		}
		if _, err := json.Marshal(result); err != nil {
			t.Fatalf("holding result must remain serializable: %v", err)
		}
		state.VelocityMps = bad
		result = arbiter.FilterAction(context.Background(), state, ControlInput{}, time.Millisecond)
		if !result.SimplexEngaged || math.IsNaN(result.CertifiedInput.ActuationTorque) || math.IsInf(result.CertifiedInput.ActuationTorque, 0) {
			t.Fatalf("invalid velocity produced non-finite holding torque: %+v", result)
		}
		state.VelocityMps = 1
	}
}

func TestHoldingTorqueIsBoundedInBothDirections(t *testing.T) {
	controller := BaselineSafetyController{}
	for _, speed := range []float64{-1e9, -1, 0, 1, 1e9} {
		input := controller.ExecuteSafeHolding(PhysicalState{VelocityMps: speed})
		if math.Abs(input.ActuationTorque) > 20 || input.ActuationTorque*speed > 0 {
			t.Fatalf("holding torque fails to oppose bounded reverse motion: speed=%v input=%+v", speed, input)
		}
	}
}
