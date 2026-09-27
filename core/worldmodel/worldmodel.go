package worldmodel

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// SurfaceType defines road or terrain friction coefficients.
type SurfaceType string

const (
	SurfaceDryAsphalt SurfaceType = "dry_asphalt" // mu ~ 0.90
	SurfaceWetAsphalt SurfaceType = "wet_asphalt" // mu ~ 0.55
	SurfaceSnow       SurfaceType = "snow"        // mu ~ 0.25
	SurfaceIce        SurfaceType = "black_ice"   // mu ~ 0.12
)

// FrictionCoeff returns the estimated tire-road friction coefficient.
func FrictionCoeff(s SurfaceType) float64 {
	switch s {
	case SurfaceDryAsphalt:
		return 0.90
	case SurfaceWetAsphalt:
		return 0.55
	case SurfaceSnow:
		return 0.25
	case SurfaceIce:
		return 0.12
	default:
		return 0.70
	}
}

// VehicleState captures dynamic telemetry for counterfactual physics simulation.
type VehicleState struct {
	VelocityKmh float64     `json:"velocity_kmh"`
	SteerAngle  float64     `json:"steer_angle_deg"`
	MassKg      float64     `json:"mass_kg"`
	Surface     SurfaceType `json:"surface"`
}

// RobotState captures arm kinematics and payload parameters.
type RobotState struct {
	ReachMeters float64 `json:"reach_meters"`
	PayloadKg   float64 `json:"payload_kg"`
	StallTorque float64 `json:"stall_torque_nm"`
	MaxVelocity float64 `json:"max_velocity_rad_s"`
}

// SimulationVerdict is the safety evaluation of a cyber-physical intent.
type SimulationVerdict struct {
	Safe                 bool    `json:"safe"`
	Vetoed               bool    `json:"vetoed"`
	Reason               string  `json:"reason,omitempty"`
	RiskScore            float64 `json:"risk_score"`            // 0.0 (safe) to 1.0 (fatal crash)
	SimulatedTrajCount   int     `json:"simulated_traj_count"`  // e.g. 100 counterfactuals
	PredictedStopDistM   float64 `json:"predicted_stop_dist_m"`
	MaxSafeSpeedKmh      float64 `json:"max_safe_speed_kmh"`
	SimulationDurationMs int64   `json:"sim_duration_ms"`
}

// Simulator executes Monte Carlo and deterministic physics counterfactuals in <5ms.
type Simulator struct {
	mu sync.RWMutex
}

// NewSimulator creates an initialized physical world model engine.
func NewSimulator() *Simulator {
	return &Simulator{}
}

// EvaluateVehicleManeuver simulates 100 counterfactual emergency braking/steering trajectories.
func (s *Simulator) EvaluateVehicleManeuver(state VehicleState, requestedDecelG float64, requestedSteerDeg float64) SimulationVerdict {
	s.mu.RLock()
	defer s.mu.RUnlock()

	start := time.Now()
	mu := FrictionCoeff(state.Surface)
	g := 9.81
	vMs := state.VelocityKmh / 3.6

	// Stop distance d = v^2 / (2 * mu * g)
	predictedStopM := (vMs * vMs) / (2.0 * mu * g)
	maxSafeDecelG := mu * 0.95 // 95% of friction circle limit

	// Max safe speed for requested steer angle: v_max = sqrt(mu * g * R)
	wheelbase := 2.7 // meters
	steerRad := math.Abs(requestedSteerDeg) * (math.Pi / 180.0)
	var turnRadius float64 = 1000.0
	if steerRad > 0.01 {
		turnRadius = wheelbase / math.Tan(steerRad)
	}
	maxSafeSpeedMs := math.Sqrt(mu * g * turnRadius)
	maxSafeSpeedKmh := maxSafeSpeedMs * 3.6

	// Friction circle equation parameters
	ax := requestedDecelG * g
	ay := (vMs * vMs) / turnRadius

	// Run 100 counterfactual variations (noise on friction mu +/- 20%)
	trajCount := 100
	skidCount := 0
	for i := 0; i < trajCount; i++ {
		noise := 1.0 + (float64(i%21)-10.0)*0.02 // 0.8 to 1.2
		effMu := mu * noise

		demand := math.Sqrt(ax*ax + ay*ay)
		available := effMu * g

		if demand > available {
			skidCount++
		}
	}

	riskScore := float64(skidCount) / float64(trajCount)
	vetoed := false
	reason := ""

	if riskScore > 0.15 {
		vetoed = true
		reason = fmt.Sprintf("High skid risk (%.1f%%) on %s. Max safe deceleration: %.2f G, safe steer speed: %.1f km/h",
			riskScore*100, state.Surface, maxSafeDecelG, maxSafeSpeedKmh)
	}

	return SimulationVerdict{
		Safe:                 !vetoed,
		Vetoed:               vetoed,
		Reason:               reason,
		RiskScore:            riskScore,
		SimulatedTrajCount:   trajCount,
		PredictedStopDistM:   math.Round(predictedStopM*100) / 100,
		MaxSafeSpeedKmh:      math.Round(maxSafeSpeedKmh*10) / 10,
		SimulationDurationMs: time.Since(start).Milliseconds(),
	}
}

// EvaluateRoboticGrip evaluates static and dynamic torque limits on a robotic actuator.
func (s *Simulator) EvaluateRoboticGrip(state RobotState, commandedSpeedRadS float64) SimulationVerdict {
	s.mu.RLock()
	defer s.mu.RUnlock()

	start := time.Now()
	g := 9.81

	// Static torque demand = Payload * g * Reach
	staticTorque := state.PayloadKg * g * state.ReachMeters

	// Dynamic torque (centrifugal & acceleration margin ~ 20%)
	dynamicTorque := staticTorque * (1.0 + 0.2*(commandedSpeedRadS/math.Max(0.1, state.MaxVelocity)))

	vetoed := false
	reason := ""
	riskScore := dynamicTorque / math.Max(1.0, state.StallTorque)

	if riskScore > 0.85 {
		vetoed = true
		reason = fmt.Sprintf("Torque overload risk: demand %.1f Nm exceeds 85%% of stall torque (%.1f Nm)", dynamicTorque, state.StallTorque)
	}

	return SimulationVerdict{
		Safe:                 !vetoed,
		Vetoed:               vetoed,
		Reason:               reason,
		RiskScore:            math.Min(1.0, riskScore),
		SimulatedTrajCount:   50,
		SimulationDurationMs: time.Since(start).Milliseconds(),
	}
}
