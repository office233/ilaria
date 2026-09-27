package chameleon

import (
	"context"
	"testing"
	"time"
)

func TestChameleonHardwareAndCapabilities(t *testing.T) {
	key := []byte("SWYPIK_CHAMELEON_TEST_SECRET_2026")
	hc := NewHardwareController(key)

	// 1. Test SPSC Ring Buffer
	packet1 := TelemetryPacket{
		ThermalC:    42.0,
		VelocityMps: 1.2,
		PositionM:   3.4,
		VibrationG:  0.18,
	}
	hc.StreamTelemetryPacket(packet1)

	readPacket, ok := hc.ReadNextTelemetry()
	if !ok || readPacket.Sequence != 1 || readPacket.ThermalC != 42.0 {
		t.Errorf("SPSC ring buffer failed to pop packet: ok=%v, pkt=%+v", ok, readPacket)
	}

	// 2. Test Capability Tokens
	// Mint token for torque & cooling with write permissions for 5 seconds
	validCap := hc.MintCapability([]uint32{AddrActuationTorque, AddrCoolingDuty}, true, 5*time.Second)

	// Authorized write should succeed
	err := hc.WriteMMIO(validCap, AddrActuationTorque, 450)
	if err != nil {
		t.Fatalf("Expected authorized MMIO write to succeed, got: %v", err)
	}
	if hc.ReadMMIO(AddrActuationTorque) != 450 {
		t.Errorf("MMIO value mismatch: expected 450, got %d", hc.ReadMMIO(AddrActuationTorque))
	}

	// Unauthorized write (read-only token) should be rejected
	readOnlyCap := hc.MintCapability([]uint32{AddrActuationTorque}, false, 5*time.Second)
	err = hc.WriteMMIO(readOnlyCap, AddrActuationTorque, 999)
	if err == nil {
		t.Errorf("Expected unauthorized write to be rejected by capability validator")
	}

	// Unauthorized register address should be rejected
	statusCap := hc.MintCapability([]uint32{AddrStatusRegister}, true, 5*time.Second)
	err = hc.WriteMMIO(statusCap, AddrActuationTorque, 999)
	if err == nil {
		t.Errorf("Expected write to unauthorized register address to be rejected")
	}

	// 3. Test Sandboxed Reversible Multi-Register Command
	cmd := &MultiRegisterActuationCommand{
		TargetTorque:  600,
		TargetCooling: 80,
	}
	err = cmd.Execute(context.Background(), hc, validCap)
	if err != nil {
		t.Fatalf("Sandboxed command execution failed: %v", err)
	}
	if hc.ReadMMIO(AddrActuationTorque) != 600 || hc.ReadMMIO(AddrCoolingDuty) != 80 {
		t.Errorf("Failed to update target registers: torque=%d, cooling=%d",
			hc.ReadMMIO(AddrActuationTorque), hc.ReadMMIO(AddrCoolingDuty))
	}

	// Test Rollback
	err = cmd.Rollback(context.Background(), hc, validCap)
	if err != nil {
		t.Fatalf("Rollback failed: %v", err)
	}
	if hc.ReadMMIO(AddrActuationTorque) != 450 || hc.ReadMMIO(AddrCoolingDuty) != 0 {
		t.Errorf("Rollback did not restore previous register state: torque=%d, cooling=%d",
			hc.ReadMMIO(AddrActuationTorque), hc.ReadMMIO(AddrCoolingDuty))
	}

	// 4. Test Emergency Lock
	hc.EngageEmergencyLock()
	err = hc.WriteMMIO(validCap, AddrActuationTorque, 100)
	if err == nil {
		t.Errorf("Expected all writes to be blocked when emergency lock is engaged")
	}
	if hc.ReadMMIO(AddrActuationTorque) != 0 {
		t.Errorf("Actuation torque must be zeroed upon emergency lock engagement")
	}
}
