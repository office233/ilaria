// Package cbf is a prototype control-barrier simulation. Its outputs do not
// establish physical safety, certification or a hard real-time guarantee.
package cbf

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// PhysicalState captures continuous dynamical state vector x(t).
type PhysicalState struct {
	ThermalC    float64 `json:"thermal_celsius"`
	VelocityMps float64 `json:"velocity_mps"`
	PositionM   float64 `json:"position_meters"`
	VibrationG  float64 `json:"vibration_g"`
	Timestamp   time.Time
}

// SafetyEnvelope defines the boundary of the safe set S = {x | h(x) >= 0}.
type SafetyEnvelope struct {
	MaxThermalC  float64 `json:"max_thermal_celsius"`
	MaxVelocity  float64 `json:"max_velocity_mps"`
	MaxPosition  float64 `json:"max_position_meters"`
	MaxVibration float64 `json:"max_vibration_g"`
}

// ControlInput represents the control effort u (acceleration, torque, PWM).
type ControlInput struct {
	ActuationTorque float64 `json:"actuation_torque"`
	AuxCoolingDuty  float64 `json:"aux_cooling_duty"`
}

// BarrierEvaluation records the evaluation of the safety barrier h(x).
type BarrierEvaluation struct {
	HThermal   float64
	HVelocity  float64
	HPosition  float64
	HVibration float64
	MinMargin  float64
	Safe       bool
}

// QPFilterResult holds the verified safe control output u* and metrics.
type QPFilterResult struct {
	CertifiedInput      ControlInput `json:"certified_input"`
	NominalInput        ControlInput `json:"nominal_input"`
	Deviation           float64      `json:"deviation"`
	QPSolved            bool         `json:"qp_solved"`
	SimplexEngaged      bool         `json:"simplex_engaged"`
	SimplexReason       string       `json:"simplex_reason,omitempty"`
	MinSafetyMargin     float64      `json:"min_safety_margin"`
	FilterDurationMicro int64        `json:"filter_duration_us"`
}

// BaselineSafetyController provides a bounded holding pattern for the model.
type BaselineSafetyController struct{}

func (sbc *BaselineSafetyController) ExecuteSafeHolding(state PhysicalState) ControlInput {
	// Deterministic fail-safe: dynamic regenerative braking, max cooling
	velocity := state.VelocityMps
	if !finite(velocity) {
		velocity = 0 // Direction is unknown; never emit non-finite actuation.
	}
	return ControlInput{
		ActuationTorque: -math.Max(-20.0, math.Min(20.0, velocity*15.0)), // Oppose velocity
		AuxCoolingDuty:  1.0,                                             // Max heat dissipation
	}
}

func finite(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

// SimplexArbiter coordinates proposed inputs with the model's CBF filter.
type SimplexArbiter struct {
	mu            sync.RWMutex
	envelope      SafetyEnvelope
	sbc           *BaselineSafetyController
	alphaParam    float64 // Class-K function slope: alpha(h) = alphaParam * h
	maxExecTime   time.Duration
	failoverCount int64
}

// NewSimplexArbiter initializes the deterministic CBF filter and Simplex arbiter.
func NewSimplexArbiter(env SafetyEnvelope) *SimplexArbiter {
	if !finite(env.MaxThermalC) || env.MaxThermalC <= 0 {
		env.MaxThermalC = 85.0
	}
	if !finite(env.MaxVelocity) || env.MaxVelocity <= 0 {
		env.MaxVelocity = 3.5
	}
	if !finite(env.MaxPosition) || env.MaxPosition <= 0 {
		env.MaxPosition = 15.0
	}
	if !finite(env.MaxVibration) || env.MaxVibration <= 0 {
		env.MaxVibration = 4.5
	}

	return &SimplexArbiter{
		envelope:    env,
		sbc:         &BaselineSafetyController{},
		alphaParam:  1.5,
		maxExecTime: 1 * time.Millisecond, // Base budget used by the inference deadline check.
	}
}

// EvaluateBarriers calculates barrier functions h_i(x) for all state dimensions.
func (sa *SimplexArbiter) EvaluateBarriers(x PhysicalState) BarrierEvaluation {
	if !finite(x.ThermalC, x.VelocityMps, x.PositionM, x.VibrationG) {
		return BarrierEvaluation{Safe: false}
	}
	hT := sa.envelope.MaxThermalC - x.ThermalC
	hV := sa.envelope.MaxVelocity - x.VelocityMps
	hP := sa.envelope.MaxPosition - x.PositionM
	hG := sa.envelope.MaxVibration - x.VibrationG

	minMargin := math.Min(math.Min(hT, hV), math.Min(hP, hG))

	return BarrierEvaluation{
		HThermal:   hT,
		HVelocity:  hV,
		HPosition:  hP,
		HVibration: hG,
		MinMargin:  minMargin,
		Safe:       minMargin > 0,
	}
}

// FilterAction applies the Control Barrier Function Quadratic Program (QP) projection:
// min 0.5 * ||u - u_nom||^2 subject to Lie derivative barrier inequalities: L_f h(x) + L_g h(x) u >= -alpha(h(x))
func (sa *SimplexArbiter) FilterAction(
	ctx context.Context,
	state PhysicalState,
	uNom ControlInput,
	aiLatency time.Duration,
) QPFilterResult {
	start := time.Now()
	sa.mu.Lock()
	defer sa.mu.Unlock()
	validState := finite(state.ThermalC, state.VelocityMps, state.PositionM, state.VibrationG)
	validInput := finite(uNom.ActuationTorque, uNom.AuxCoolingDuty)
	if !validState || !validInput {
		sa.failoverCount++
		// Keep the result serializable even when untrusted numeric input is NaN.
		nominal := uNom
		if !validInput {
			nominal = ControlInput{}
		}
		return QPFilterResult{
			CertifiedInput:      sa.sbc.ExecuteSafeHolding(state),
			NominalInput:        nominal,
			SimplexEngaged:      true,
			SimplexReason:       "Non-finite telemetry or control input",
			MinSafetyMargin:     sa.EvaluateBarriers(state).MinMargin,
			FilterDurationMicro: time.Since(start).Microseconds(),
		}
	}

	// 1. Simplex Deadline Check: If AI inference experienced deadline overrun (> 1ms allocation window)
	if aiLatency > sa.maxExecTime*100 { // Prototype inference budget; not a hard real-time guarantee.
		sa.failoverCount++
		safeU := sa.sbc.ExecuteSafeHolding(state)
		return QPFilterResult{
			CertifiedInput:      safeU,
			NominalInput:        uNom,
			Deviation:           math.Abs(safeU.ActuationTorque - uNom.ActuationTorque),
			QPSolved:            false,
			SimplexEngaged:      true,
			SimplexReason:       fmt.Sprintf("AI deadline overrun: %v exceeded real-time window", aiLatency),
			MinSafetyMargin:     sa.EvaluateBarriers(state).MinMargin,
			FilterDurationMicro: time.Since(start).Microseconds(),
		}
	}

	// 2. Evaluate Barrier Functions h(x)
	barriers := sa.EvaluateBarriers(state)

	// If system already penetrated the boundary (h(x) <= 0), engage Simplex fail-safe immediately
	if !barriers.Safe {
		sa.failoverCount++
		safeU := sa.sbc.ExecuteSafeHolding(state)
		return QPFilterResult{
			CertifiedInput:      safeU,
			NominalInput:        uNom,
			Deviation:           math.Abs(safeU.ActuationTorque - uNom.ActuationTorque),
			QPSolved:            false,
			SimplexEngaged:      true,
			SimplexReason:       fmt.Sprintf("Safety envelope penetrated: min margin = %.2f", barriers.MinMargin),
			MinSafetyMargin:     barriers.MinMargin,
			FilterDurationMicro: time.Since(start).Microseconds(),
		}
	}

	// 3. Solve 1D Quadratic Program Projection:
	// System: dv/dt = (u / mass) - drag * v
	// Barrier: h_v(x) = v_max - v >= 0
	// Lie derivative: L_f h + L_g h * u = - (u / mass - drag * v) >= -alpha * h_v
	// => u <= mass * (drag * v + alpha * h_v)
	mass := 5.0
	drag := 0.05
	maxTorqueAllowed := mass * (drag*state.VelocityMps + sa.alphaParam*barriers.HVelocity)

	// Thermal Barrier:
	// If thermal margin narrows (hT < 15C), scale down torque to prevent thermal trip
	thermalFactor := math.Min(1.0, math.Max(0.1, barriers.HThermal/15.0))
	effectiveMaxTorque := math.Min(maxTorqueAllowed, 100.0*thermalFactor)

	// QP Optimal Projection: min 0.5 * (u - u_nom)^2 subject to u <= effectiveMaxTorque and u >= -50.0
	uStar := uNom.ActuationTorque
	if uStar > effectiveMaxTorque {
		uStar = effectiveMaxTorque
	}
	if uStar < -50.0 {
		uStar = -50.0 // Physical reverse torque limit
	}

	// Dynamic auxiliary cooling: if thermal margin drops below 20C, force auxiliary pump on
	cooling := uNom.AuxCoolingDuty
	if barriers.HThermal < 20.0 {
		cooling = math.Max(cooling, 1.0-(barriers.HThermal/20.0))
	}

	certified := ControlInput{
		ActuationTorque: math.Round(uStar*100) / 100,
		AuxCoolingDuty:  math.Round(cooling*100) / 100,
	}

	deviation := math.Abs(certified.ActuationTorque - uNom.ActuationTorque)

	return QPFilterResult{
		CertifiedInput:      certified,
		NominalInput:        uNom,
		Deviation:           deviation,
		QPSolved:            true,
		SimplexEngaged:      false,
		MinSafetyMargin:     barriers.MinMargin,
		FilterDurationMicro: time.Since(start).Microseconds(),
	}
}

// GetTelemetry returns total safety interlock statistics.
func (sa *SimplexArbiter) GetTelemetry() (failovers int64, envelope SafetyEnvelope) {
	sa.mu.RLock()
	defer sa.mu.RUnlock()
	return sa.failoverCount, sa.envelope
}
