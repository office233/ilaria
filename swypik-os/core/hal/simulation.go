package hal

import "fmt"

// These compatibility fixtures populate metadata only. They do not connect to
// physical devices, install drivers or perform any real control operation.
func (m *Manager) AttachVehicleSimulation(model, vin string) *DiscoveredDevice {
 d := &DiscoveredDevice{
  ID: "dev_vehicle_can0", Name: "SIMULATION: " + model, Class: ClassVehicle,
  Bus: BusCAN, Port: "vcan0", Protocol: "ISO-15765-4_CAN_OBD2", DriverStatus: DriverSimulated,
  Capabilities: []string{"read_rpm", "read_speed", "read_coolant_temp", "read_battery_soc", "set_cabin_temp", "lock_doors", "unlock_doors", "headlights_toggle"},
  Metadata: map[string]string{"vin": vin, "model": model, "bus_speed": "500kbps", "ecu_standard": "OBD2_PID_MODE_01", "telemetry_state": "SIMULATED", "simulation": "true"},
 }
 m.RegisterDevice(d); return d
}
func (m *Manager) AttachRobotSimulation(name string, degreesOfFreedom int) *DiscoveredDevice {
 d := &DiscoveredDevice{
  ID: "dev_robot_controller_0", Name: "SIMULATION: " + name, Class: ClassRobot,
  Bus: BusUART, Port: "COM3", Protocol: "DYNAMIXEL_SERVO_V2", DriverStatus: DriverSimulated,
  Capabilities: []string{"joint_control", "cartesian_move", "emergency_stop", "gripper_actuation", "read_encoders"},
  Metadata: map[string]string{"dof": fmt.Sprint(degreesOfFreedom), "kinematics": "FORWARD_INVERSE_DH", "baud_rate": "1000000", "safety_estop": "SIMULATED", "simulation": "true"},
 }
 m.RegisterDevice(d); return d
}
func (m *Manager) AttachApplianceSimulation(name string, channels int) *DiscoveredDevice {
 d := &DiscoveredDevice{
  ID: "dev_appliance_relay_0", Name: "SIMULATION: " + name, Class: ClassAppliance,
  Bus: BusModbus, Port: "COM4", Protocol: "MODBUS_RTU_FUNCTION_05", DriverStatus: DriverSimulated,
  Capabilities: []string{"relay_toggle", "power_metering", "schedule_cycle", "fault_detection"},
  Metadata: map[string]string{"channels": fmt.Sprint(channels), "slave_id": "1", "relay_states": "0x00", "simulation": "true"},
 }
 m.RegisterDevice(d); return d
}
