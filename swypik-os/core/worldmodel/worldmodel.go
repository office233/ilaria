// Package worldmodel provides deterministic physics approximations. The
// simulations are prototypes; their verdicts do not certify real-device safety.
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

// VehicleState captures dynamic telemetry for counterfactual physics simulation.
type VehicleState struct {
	VelocityKmh     float64     `json:"velocity_kmh"`
	SteerAngle      float64     `json:"steer_angle_deg"`
	MassKg          float64     `json:"mass_kg"`
	Surface         SurfaceType `json:"surface"`
	WheelbaseMeters float64     `json:"wheelbase_meters"`
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
	RiskScore            float64 `json:"risk_score"`           // Uncalibrated model index from 0.0 to 1.0.
	SimulatedTrajCount   int     `json:"simulated_traj_count"` // e.g. 100 counterfactuals
	PredictedStopDistM   float64 `json:"predicted_stop_dist_m"`
	MaxSafeSpeedKmh      float64 `json:"max_safe_speed_kmh"`
	HasLateralSpeedLimit bool    `json:"has_lateral_speed_limit"`
	SimulationDurationMs int64   `json:"sim_duration_ms"`
}

// Simulator evaluates deterministic physics scenarios without a latency guarantee.
type Simulator struct {
	mu     sync.RWMutex
	config *Config
}

// CalibrationVersion makes the prototype numerical contract explicit.
const CalibrationVersion = 1

// Config contains explicit, caller-supplied simulation assumptions. These are
// not measured device facts or calibrated probabilities of real-world harm.
type Config struct {
	Version                   int
	GravityMetersS2           float64
	SurfaceFriction           map[SurfaceType]float64
	VehicleRiskThreshold      float64
	RobotTorqueFraction       float64
	RobotDynamicMargin        float64
	FrictionVariationCount    int
	FrictionVariationFraction float64
}

func (c Config) Validate() error {
	if c.Version != CalibrationVersion || !finiteValues(c.GravityMetersS2,
		c.VehicleRiskThreshold, c.RobotTorqueFraction, c.RobotDynamicMargin, c.FrictionVariationFraction) ||
		c.GravityMetersS2 <= 0 || c.VehicleRiskThreshold < 0 || c.VehicleRiskThreshold > 1 ||
		c.RobotTorqueFraction <= 0 || c.RobotTorqueFraction > 1 || c.RobotDynamicMargin < 0 ||
		c.FrictionVariationCount < 2 || c.FrictionVariationCount > 10000 ||
		c.FrictionVariationFraction < 0 || c.FrictionVariationFraction >= 1 || len(c.SurfaceFriction) == 0 {
		return fmt.Errorf("invalid prototype simulation calibration")
	}
	for surface, friction := range c.SurfaceFriction {
		if surface == "" || !finiteValues(friction) || friction <= 0 {
			return fmt.Errorf("invalid friction calibration for %q", surface)
		}
	}
	return nil
}

// NewSimulator starts unconfigured and refuses verdicts until explicit
// calibration is supplied through NewConfiguredSimulator.
func NewSimulator() *Simulator {
	return &Simulator{}
}

func NewConfiguredSimulator(config Config) (*Simulator, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	friction := make(map[SurfaceType]float64, len(config.SurfaceFriction))
	for surface, coefficient := range config.SurfaceFriction {
		friction[surface] = coefficient
	}
	config.SurfaceFriction = friction
	return &Simulator{config: &config}, nil
}

// FrictionCoeff returns only explicitly calibrated surface coefficients.
func (s *Simulator) FrictionCoeff(surface SurfaceType) (float64, error) {
	if s == nil || s.config == nil {
		return 0, fmt.Errorf("explicit simulation calibration is required")
	}
	coefficient, exists := s.config.SurfaceFriction[surface]
	if !exists {
		return 0, fmt.Errorf("surface %q has no friction calibration", surface)
	}
	return coefficient, nil
}

func finiteValues(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

func invalidSimulation(reason string) SimulationVerdict {
	return SimulationVerdict{Vetoed: true, RiskScore: 1, Reason: reason}
}

// EvaluateVehicleManeuver checks the configured friction variations.
func (s *Simulator) EvaluateVehicleManeuver(state VehicleState, requestedDecelG float64, requestedSteerDeg float64) SimulationVerdict {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.config == nil {
		return invalidSimulation("Explicit simulation calibration is required")
	}
	if !finiteValues(state.VelocityKmh, state.SteerAngle, state.MassKg, state.WheelbaseMeters, requestedDecelG, requestedSteerDeg) ||
		state.VelocityKmh < 0 || state.MassKg <= 0 || state.WheelbaseMeters <= 0 || requestedDecelG < 0 ||
		math.Abs(state.SteerAngle) >= 90 || math.Abs(requestedSteerDeg) >= 90 {
		return invalidSimulation("Invalid vehicle telemetry or maneuver parameters")
	}

	start := time.Now()
	config := *s.config
	mu, known := config.SurfaceFriction[state.Surface]
	if !known {
		return invalidSimulation("Surface has no friction calibration")
	}
	g := config.GravityMetersS2
	vMs := state.VelocityKmh / 3.6

	// Stop distance d = v^2 / (2 * mu * g)
	predictedStopM := (vMs * vMs) / (2.0 * mu * g)
	maxSafeDecelG := mu

	// Max safe speed for requested steer angle: v_max = sqrt(mu * g * R)
	steerRad := math.Abs(requestedSteerDeg) * (math.Pi / 180.0)
	curvature := math.Tan(steerRad) / state.WheelbaseMeters
	maxSafeSpeedKmh := 0.0
	if curvature > 0 {
		maxSafeSpeedKmh = math.Sqrt(mu*g/curvature) * 3.6
	}

	// Friction circle equation parameters
	ax := requestedDecelG * g
	ay := (vMs * vMs) * curvature
	demand := math.Hypot(ax, ay)
	if !finiteValues(predictedStopM, maxSafeSpeedKmh, ax, ay, demand) {
		return invalidSimulation("Vehicle simulation exceeded its numeric range")
	}

	// Deterministic, evenly spaced variations of the configured friction estimate.
	trajCount := config.FrictionVariationCount
	skidCount := 0
	for i := 0; i < trajCount; i++ {
		noise := 1.0 + config.FrictionVariationFraction*(2*float64(i)/float64(trajCount-1)-1)
		effMu := mu * noise

		available := effMu * g
		if !finiteValues(available) || available <= 0 {
			return invalidSimulation("Friction calibration exceeded its numeric range")
		}

		if demand > available {
			skidCount++
		}
	}

	riskScore := float64(skidCount) / float64(trajCount)
	vetoed := false
	reason := ""

	if riskScore > config.VehicleRiskThreshold {
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
		PredictedStopDistM:   predictedStopM,
		MaxSafeSpeedKmh:      maxSafeSpeedKmh,
		HasLateralSpeedLimit: curvature > 0,
		SimulationDurationMs: time.Since(start).Milliseconds(),
	}
}

// EvaluateRoboticGrip evaluates static and dynamic torque limits on a robotic actuator.
func (s *Simulator) EvaluateRoboticGrip(state RobotState, commandedSpeedRadS float64) SimulationVerdict {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.config == nil {
		return invalidSimulation("Explicit simulation calibration is required")
	}
	if !finiteValues(state.ReachMeters, state.PayloadKg, state.StallTorque, state.MaxVelocity, commandedSpeedRadS) ||
		state.ReachMeters < 0 || state.PayloadKg < 0 || state.StallTorque <= 0 || state.MaxVelocity <= 0 {
		return invalidSimulation("Invalid robot telemetry or grip parameters")
	}
	if math.Abs(commandedSpeedRadS) > state.MaxVelocity {
		return invalidSimulation("Commanded speed exceeds the robot's velocity limit")
	}

	start := time.Now()
	config := *s.config
	g := config.GravityMetersS2

	// Static torque demand = Payload * g * Reach
	staticTorque := state.PayloadKg * g * state.ReachMeters

	// Dynamic torque with the configured speed-dependent margin.
	dynamicTorque := staticTorque * (1.0 + config.RobotDynamicMargin*(math.Abs(commandedSpeedRadS)/state.MaxVelocity))
	riskScore := dynamicTorque / state.StallTorque
	if !finiteValues(staticTorque, dynamicTorque, riskScore) {
		return invalidSimulation("Robot simulation exceeded its numeric range")
	}

	vetoed := false
	reason := ""

	if riskScore > config.RobotTorqueFraction {
		vetoed = true
		reason = fmt.Sprintf("Torque overload risk: demand %.3g Nm exceeds %.1f%% of stall torque (%.3g Nm)", dynamicTorque, config.RobotTorqueFraction*100, state.StallTorque)
	}

	return SimulationVerdict{
		Safe:                 !vetoed,
		Vetoed:               vetoed,
		Reason:               reason,
		RiskScore:            math.Min(1.0, riskScore),
		SimulatedTrajCount:   1,
		SimulationDurationMs: time.Since(start).Milliseconds(),
	}
}
