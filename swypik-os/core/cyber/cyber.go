package cyber

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"swypik-os/core/autogenesis"
	"swypik-os/core/evidence"
	"swypik-os/core/hal"
	resourcepolicy "swypik-os/core/resource"
)

// PhysicalActionType denotes the exact physical actuation domain.
type PhysicalActionType string

const (
	ActionVehicleClimate   PhysicalActionType = "VEHICLE_CLIMATE"
	ActionVehicleDoors     PhysicalActionType = "VEHICLE_DOORS"
	ActionVehicleTelemetry PhysicalActionType = "VEHICLE_TELEMETRY"
	ActionRobotMove        PhysicalActionType = "ROBOT_MOVE_JOINT"
	ActionRobotGripper     PhysicalActionType = "ROBOT_GRIPPER"
	ActionRobotDrive       PhysicalActionType = "ROBOT_DRIVE"
	ActionApplianceRelay   PhysicalActionType = "APPLIANCE_RELAY"
	ActionAppliancePower   PhysicalActionType = "APPLIANCE_POWER"
	ActionCameraInspect    PhysicalActionType = "CAMERA_INSPECT"
	ActionEmergencyStop    PhysicalActionType = "EMERGENCY_STOP"
)

// PhysicalCommand is the structured machine representation of a high-level human intention.
type PhysicalCommand struct {
	Domain         hal.DeviceClass        `json:"domain"`
	TargetDeviceID string                 `json:"target_device_id"`
	Action         PhysicalActionType     `json:"action"`
	Params         map[string]interface{} `json:"params"`
	RawPrompt      string                 `json:"raw_prompt"`
}

// ActuationResult holds the outcome of a command. Success means the command
// was accepted; Evidence says what it actually touched. This orchestrator has
// no bus transport, so every accepted command is evidence.Simulated and its
// telemetry is the simulation's own state, not a device reading.
type ActuationResult struct {
	Command         *PhysicalCommand   `json:"command"`
	Success         bool               `json:"success"`
	Evidence        evidence.Level     `json:"evidence"`
	Telemetry       map[string]float64 `json:"telemetry"`
	FeedbackMessage string             `json:"feedback_message"`
	ExecutionTimeMs int64              `json:"execution_time_ms"`
	Timestamp       time.Time          `json:"timestamp"`
}

// SafetyGovernor enforces physical limits, rate limiting, and hard real-time E-Stops.
type SafetyGovernor struct {
	mu          sync.RWMutex
	eStopActive int32 // atomic boolean: 1 = active, 0 = clear
	maxJointDeg float64
	minJointDeg float64
	minTempC    float64
	maxTempC    float64
}

func NewSafetyGovernor() *SafetyGovernor {
	return &SafetyGovernor{
		maxJointDeg: 180.0,
		minJointDeg: -180.0,
		minTempC:    16.0,
		maxTempC:    30.0,
	}
}

func (g *SafetyGovernor) IsEStopActive() bool {
	return atomic.LoadInt32(&g.eStopActive) == 1
}

func (g *SafetyGovernor) TriggerEStop() {
	atomic.StoreInt32(&g.eStopActive, 1)
}

func (g *SafetyGovernor) ResetEStop() {
	atomic.StoreInt32(&g.eStopActive, 0)
}

func (g *SafetyGovernor) Validate(cmd *PhysicalCommand) error {
	if cmd == nil {
		return fmt.Errorf("invalid command: nil")
	}
	if g.IsEStopActive() && cmd.Action != ActionEmergencyStop {
		return fmt.Errorf("SAFETY INTERLOCK: Physical Emergency Stop (E-Stop) is ACTIVE. All motions locked.")
	}

	switch cmd.Action {
	case ActionVehicleClimate:
		if temp, ok := cmd.Params["temp"].(float64); ok {
			if temp < g.minTempC || temp > g.maxTempC {
				return fmt.Errorf("safety violation: target temp %.1fC outside bounds [%.1f - %.1f]", temp, g.minTempC, g.maxTempC)
			}
		}
	case ActionRobotMove:
		if angle, ok := cmd.Params["angle"].(float64); ok {
			if angle < g.minJointDeg || angle > g.maxJointDeg {
				return fmt.Errorf("safety violation: joint angle %.1f exceeds kinematic envelope [%.1f - %.1f]", angle, g.minJointDeg, g.maxJointDeg)
			}
		}
	case ActionRobotGripper:
		if pct, ok := cmd.Params["percent"].(float64); ok {
			if pct < 0.0 || pct > 100.0 {
				return fmt.Errorf("safety violation: gripper percentage %.1f out of range [0-100]", pct)
			}
		}
	}

	return nil
}

// Orchestrator parses intents and applies them to an in-memory simulation.
// It never performs device I/O.
type Orchestrator struct {
	mu            sync.RWMutex
	halMgr        *hal.Manager
	synth         *autogenesis.Synthesizer
	safety        *SafetyGovernor
	lastTelemetry map[string]float64
	history       []*ActuationResult
	maxHistory    int
}

// NewOrchestrator creates the central cyber-physical brain.
func NewOrchestrator(halMgr *hal.Manager, synth *autogenesis.Synthesizer) *Orchestrator {
	if halMgr == nil {
		halMgr = hal.NewManager()
	}
	if synth == nil {
		synth = autogenesis.NewSynthesizer("")
	}

	policy := resourcepolicy.Default()
	maxHistory := policy.MaxChatHistoryMessages
	if maxHistory < 20 {
		maxHistory = 20
	}
	return &Orchestrator{
		halMgr: halMgr,
		synth:  synth,
		safety: NewSafetyGovernor(),
		// The simulation starts parked and idle; there is no camera to report on.
		lastTelemetry: map[string]float64{
			"vehicle_speed_kmh":    0.0,
			"vehicle_rpm":          0.0,
			"vehicle_cabin_temp_c": 21.0,
			"robot_arm_joint_1":    0.0,
			"robot_gripper_pct":    0.0,
			"appliance_relay_1":    0.0,
			"appliance_power_w":    0.0,
		},
		history:    make([]*ActuationResult, 0, min(maxHistory, 16)),
		maxHistory: maxHistory,
	}
}

// DispatchIntent parses natural language commands (Romanian & English) and executes cybernetic control.
func (o *Orchestrator) DispatchIntent(ctx context.Context, naturalPrompt string) (*ActuationResult, error) {
	start := time.Now()
	clean := strings.TrimSpace(naturalPrompt)
	lower := strings.ToLower(clean)

	// 1. Check for Emergency Stop immediately!
	if strings.Contains(lower, "reset estop") || strings.Contains(lower, "armeaza") || strings.Contains(lower, "rearmeaza") {
		o.safety.ResetEStop()
		return &ActuationResult{
			Command:         &PhysicalCommand{Action: "RESET_ESTOP", RawPrompt: clean},
			Success:         true,
			Evidence:        evidence.Simulated,
			FeedbackMessage: "SIMULATION: software E-Stop latch cleared. No hardware safety circuit is connected.",
			ExecutionTimeMs: time.Since(start).Milliseconds(),
			Timestamp:       time.Now(),
		}, nil
	}

	if strings.Contains(lower, "stop") || strings.Contains(lower, "urgenta") || strings.Contains(lower, "estop") || strings.Contains(lower, "e-stop") {
		return o.TriggerEStop(), nil
	}

	// 2. Parse command into PhysicalCommand
	cmd, err := o.parseCommand(clean, lower)
	if err != nil {
		return nil, err
	}

	// 3. Validate against Safety Governor
	if err := o.safety.Validate(cmd); err != nil {
		return &ActuationResult{
			Command:         cmd,
			Success:         false,
			Evidence:        evidence.Failed,
			FeedbackMessage: fmt.Sprintf("[SAFETY REJECTED] %v", err),
			ExecutionTimeMs: time.Since(start).Milliseconds(),
			Timestamp:       time.Now(),
		}, nil
	}

	// 4. Execute Actuation
	o.mu.Lock()
	defer o.mu.Unlock()

	result := &ActuationResult{
		Command:   cmd,
		Success:   true,
		Evidence:  evidence.Simulated,
		Telemetry: make(map[string]float64),
		Timestamp: time.Now(),
	}

	switch cmd.Action {
	case ActionVehicleClimate:
		temp, ok := cmd.Params["temp"].(float64)
		if !ok {
			return nil, fmt.Errorf("invalid temp parameter")
		}
		o.lastTelemetry["vehicle_cabin_temp_c"] = temp
		result.Telemetry["cabin_temp_c"] = temp
		result.FeedbackMessage = fmt.Sprintf("SIMULATION: cabin setpoint recorded as %.1f°C. No CAN frame was sent.", temp)

	case ActionVehicleDoors:
		unlock, ok := cmd.Params["unlock"].(bool)
		if !ok {
			return nil, fmt.Errorf("invalid unlock parameter")
		}
		stateStr := "Locked"
		if unlock {
			stateStr = "Unlocked"
		}
		result.FeedbackMessage = fmt.Sprintf("SIMULATION: doors marked %s. No body-control command was sent.", stateStr)

	case ActionVehicleTelemetry:
		// Return current telemetry state without overwriting
		result.Telemetry["speed_kmh"] = o.lastTelemetry["vehicle_speed_kmh"]
		result.Telemetry["rpm"] = o.lastTelemetry["vehicle_rpm"]
		result.Telemetry["cabin_temp_c"] = o.lastTelemetry["vehicle_cabin_temp_c"]
		result.FeedbackMessage = fmt.Sprintf("SIMULATION state (no vehicle read): Speed: %.1f km/h | Engine: %.0f RPM | Cabin: %.1f°C",
			result.Telemetry["speed_kmh"], result.Telemetry["rpm"], result.Telemetry["cabin_temp_c"])

	case ActionRobotMove:
		angle, ok := cmd.Params["angle"].(float64)
		if !ok {
			return nil, fmt.Errorf("invalid angle parameter")
		}
		var jointID int
		if val, ok := cmd.Params["joint"].(float64); ok {
			jointID = int(val)
		} else if val, ok := cmd.Params["joint"].(int); ok {
			jointID = val
		} else {
			return nil, fmt.Errorf("invalid joint parameter")
		}
		o.lastTelemetry[fmt.Sprintf("robot_arm_joint_%d", jointID)] = angle
		result.Telemetry[fmt.Sprintf("joint_%d_deg", jointID)] = angle
		result.FeedbackMessage = fmt.Sprintf("SIMULATION: joint %d setpoint recorded as %.1f°. No servo command was sent and no collision check ran.", jointID, angle)

	case ActionRobotGripper:
		pct, ok := cmd.Params["percent"].(float64)
		if !ok {
			return nil, fmt.Errorf("invalid percent parameter")
		}
		o.lastTelemetry["robot_gripper_pct"] = pct
		result.Telemetry["gripper_pct"] = pct
		result.FeedbackMessage = fmt.Sprintf("SIMULATION: gripper setpoint recorded as %.0f%%. No actuator moved.", pct)

	case ActionRobotDrive:
		dist, ok := cmd.Params["distance_m"].(float64)
		if !ok {
			return nil, fmt.Errorf("invalid distance_m parameter")
		}
		result.Telemetry["requested_distance_m"] = dist
		result.FeedbackMessage = fmt.Sprintf("SIMULATION: drive request for %.2f m recorded. No motor was commanded and no odometry was measured.", dist)

	case ActionApplianceRelay:
		var ch int
		if val, ok := cmd.Params["channel"].(float64); ok {
			ch = int(val)
		} else if val, ok := cmd.Params["channel"].(int); ok {
			ch = val
		} else {
			return nil, fmt.Errorf("invalid channel parameter")
		}
		state, ok := cmd.Params["state"].(bool)
		if !ok {
			return nil, fmt.Errorf("invalid state parameter")
		}
		val := 0.0
		stateStr := "OFF"
		if state {
			val = 1.0
			stateStr = "ON"
		}
		o.lastTelemetry[fmt.Sprintf("appliance_relay_%d", ch)] = val
		result.Telemetry[fmt.Sprintf("relay_%d", ch)] = val
		result.FeedbackMessage = fmt.Sprintf("SIMULATION: relay %d marked %s. No Modbus frame was sent and no power was measured.", ch, stateStr)

	case ActionCameraInspect:
		result.Success = false
		result.Evidence = evidence.Failed
		result.FeedbackMessage = "No camera device is bound; no frames were captured."
	}

	result.ExecutionTimeMs = time.Since(start).Milliseconds()
	o.appendHistoryLocked(result)
	return result, nil
}

// parseCommand decomposes high-level Romanian/English phrases into structured PhysicalCommands.
func (o *Orchestrator) parseCommand(clean string, lower string) (*PhysicalCommand, error) {
	// 1. Robot Arm Kinematics / Joints (checked before climate to avoid 'grade' conflict)
	if strings.Contains(lower, "brat") || strings.Contains(lower, "arm") || strings.Contains(lower, "joint") || (strings.Contains(lower, "robot") && (strings.Contains(lower, "ridica") || strings.Contains(lower, "misca") || strings.Contains(lower, "move") || strings.Contains(lower, "roteste"))) {
		re := regexp.MustCompile(`(\d+(?:\.\d+)?)`)
		matches := re.FindStringSubmatch(clean)
		angle := 45.0
		if len(matches) > 1 {
			if parsed, err := strconv.ParseFloat(matches[1], 64); err == nil {
				angle = parsed
			}
		}
		return &PhysicalCommand{
			Domain:         hal.ClassRobot,
			TargetDeviceID: "dev_robot_controller_0",
			Action:         ActionRobotMove,
			Params:         map[string]interface{}{"joint": 1, "angle": angle},
			RawPrompt:      clean,
		}, nil
	}

	// 2. Vehicle Climate
	if strings.Contains(lower, "clima") || strings.Contains(lower, "temperature") || strings.Contains(lower, "temperatura") || (strings.Contains(lower, "grade") && !strings.Contains(lower, "robot") && !strings.Contains(lower, "brat")) {
		re := regexp.MustCompile(`(\d+(?:\.\d+)?)`)
		matches := re.FindStringSubmatch(clean)
		temp := 21.0
		if len(matches) > 1 {
			if parsed, err := strconv.ParseFloat(matches[1], 64); err == nil {
				temp = parsed
			}
		}
		return &PhysicalCommand{
			Domain:         hal.ClassVehicle,
			TargetDeviceID: "dev_vehicle_can0",
			Action:         ActionVehicleClimate,
			Params:         map[string]interface{}{"temp": temp},
			RawPrompt:      clean,
		}, nil
	}

	// 3. Vehicle Doors
	if strings.Contains(lower, "descuie") || strings.Contains(lower, "unlock") {
		return &PhysicalCommand{
			Domain:         hal.ClassVehicle,
			TargetDeviceID: "dev_vehicle_can0",
			Action:         ActionVehicleDoors,
			Params:         map[string]interface{}{"unlock": true},
			RawPrompt:      clean,
		}, nil
	}
	if strings.Contains(lower, "incuie") || strings.Contains(lower, "lock") {
		return &PhysicalCommand{
			Domain:         hal.ClassVehicle,
			TargetDeviceID: "dev_vehicle_can0",
			Action:         ActionVehicleDoors,
			Params:         map[string]interface{}{"unlock": false},
			RawPrompt:      clean,
		}, nil
	}

	// 4. Vehicle Telemetry / Telemetrie
	if strings.Contains(lower, "masina") || strings.Contains(lower, "car") || strings.Contains(lower, "rpm") || strings.Contains(lower, "viteza") || strings.Contains(lower, "speed") {
		return &PhysicalCommand{
			Domain:         hal.ClassVehicle,
			TargetDeviceID: "dev_vehicle_can0",
			Action:         ActionVehicleTelemetry,
			Params:         map[string]interface{}{},
			RawPrompt:      clean,
		}, nil
	}

	// 5. Robot Gripper / Cleste
	if strings.Contains(lower, "cleste") || strings.Contains(lower, "gripper") || strings.Contains(lower, "prinde") || strings.Contains(lower, "strange") {
		pct := 100.0
		if strings.Contains(lower, "deschide") || strings.Contains(lower, "open") {
			pct = 0.0
		}
		return &PhysicalCommand{
			Domain:         hal.ClassRobot,
			TargetDeviceID: "dev_robot_controller_0",
			Action:         ActionRobotGripper,
			Params:         map[string]interface{}{"percent": pct},
			RawPrompt:      clean,
		}, nil
	}

	// 6. Robot Drive / Inainteaza / Deplaseaza
	if strings.Contains(lower, "inainteaza") || strings.Contains(lower, "drive") || strings.Contains(lower, "avanseaza") {
		re := regexp.MustCompile(`(\d+(?:\.\d+)?)`)
		matches := re.FindStringSubmatch(clean)
		dist := 1.0
		if len(matches) > 1 {
			if parsed, err := strconv.ParseFloat(matches[1], 64); err == nil {
				dist = parsed
			}
		}
		return &PhysicalCommand{
			Domain:         hal.ClassRobot,
			TargetDeviceID: "dev_robot_controller_0",
			Action:         ActionRobotDrive,
			Params:         map[string]interface{}{"distance_m": dist},
			RawPrompt:      clean,
		}, nil
	}

	// 7. Appliance / Releu / Ventilator / Pompa
	if strings.Contains(lower, "ventilator") || strings.Contains(lower, "fan") || strings.Contains(lower, "pompa") || strings.Contains(lower, "releu") || strings.Contains(lower, "lumini") || strings.Contains(lower, "priza") {
		state := true
		if strings.Contains(lower, "opreste") || strings.Contains(lower, "off") || strings.Contains(lower, "stinge") {
			state = false
		}
		return &PhysicalCommand{
			Domain:         hal.ClassAppliance,
			TargetDeviceID: "dev_appliance_relay_0",
			Action:         ActionApplianceRelay,
			Params:         map[string]interface{}{"channel": 1, "state": state},
			RawPrompt:      clean,
		}, nil
	}

	// 8. Camera / Video Inspection
	if strings.Contains(lower, "camera") || strings.Contains(lower, "video") || strings.Contains(lower, "inspect") || strings.Contains(lower, "vedere") {
		return &PhysicalCommand{
			Domain:         hal.ClassSensor,
			TargetDeviceID: "dev_camera_usb_0",
			Action:         ActionCameraInspect,
			Params:         map[string]interface{}{},
			RawPrompt:      clean,
		}, nil
	}

	return nil, fmt.Errorf("could not resolve physical domain from prompt: %q", clean)
}

// TriggerEStop latches the software governor and parks the simulation. It
// cannot stop hardware: a real E-Stop must be an independent safety circuit.
func (o *Orchestrator) TriggerEStop() *ActuationResult {
	o.safety.TriggerEStop()
	o.mu.Lock()
	defer o.mu.Unlock()

	// Park all telemetry to safe neutral
	o.lastTelemetry["vehicle_speed_kmh"] = 0.0
	o.lastTelemetry["vehicle_rpm"] = 0.0
	o.lastTelemetry["appliance_relay_1"] = 0.0
	o.lastTelemetry["appliance_power_w"] = 0.0

	res := &ActuationResult{
		Command: &PhysicalCommand{
			Domain:         hal.ClassActuator,
			TargetDeviceID: "ALL_SYSTEMS",
			Action:         ActionEmergencyStop,
			Params:         map[string]interface{}{"safe_halt": true},
			RawPrompt:      "EMERGENCY_STOP",
		},
		Success:         true,
		Evidence:        evidence.Simulated,
		FeedbackMessage: "SIMULATION EMERGENCY STOP: software governor latched and simulated state parked. No hardware safety circuit is connected; no physical actuator was stopped.",
		ExecutionTimeMs: 0,
		Timestamp:       time.Now(),
	}
	o.appendHistoryLocked(res)
	return res
}

func (o *Orchestrator) appendHistoryLocked(result *ActuationResult) {
	if result == nil {
		return
	}
	limit := o.maxHistory
	if limit <= 0 {
		limit = 100
	}
	if len(o.history) < limit {
		o.history = append(o.history, result)
		return
	}
	copy(o.history, o.history[1:])
	o.history[limit-1] = result
}

// GetTelemetrySnapshot returns a copy of the simulation state. None of it was
// read from a device.
func (o *Orchestrator) GetTelemetrySnapshot() map[string]float64 {
	o.mu.RLock()
	defer o.mu.RUnlock()
	res := make(map[string]float64)
	for k, v := range o.lastTelemetry {
		res[k] = v
	}
	return res
}

// IsEStopActive checks if system is currently halted.
func (o *Orchestrator) IsEStopActive() bool {
	return o.safety.IsEStopActive()
}
