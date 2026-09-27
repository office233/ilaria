package neuromorphic

import (
	"testing"
)

func TestNeuromorphicAdapter(t *testing.T) {
	adapter := NewAdapter()

	// 1. Verify ultra-low power budget (< 35 mW)
	powerMw, _ := adapter.GetTelemetry()
	if powerMw > 35.0 || powerMw <= 0 {
		t.Errorf("Expected ultra-low power budget (<35mW), got: %.1f mW", powerMw)
	}

	// 2. Test 4-20mA current loop ingestion (12 mA -> 50% physical level)
	evCurrent := adapter.IngestAnalog(0, SignalCurrentLoop, 12.0, 10.0)
	if evCurrent.PhysicalVal != 50.0 {
		t.Errorf("Expected 50.0%% physical value for 12mA, got: %.2f", evCurrent.PhysicalVal)
	}
	if evCurrent.Anomaly {
		t.Errorf("Normal current loop should not trigger anomaly")
	}

	// 3. Test Analog 0-10V ingestion with high voltage spike (bearing surge)
	// Feeding high 9.8V signal over repeated dt steps to trigger LIF firing and anomaly
	for step := 0; step < 10; step++ {
		adapter.IngestAnalog(1, SignalAnalogVoltage, 9.8, 10.0)
	}

	evSurge := adapter.IngestAnalog(1, SignalAnalogVoltage, 9.8, 10.0)
	if evSurge.SpikeRateHz <= 100.0 {
		t.Errorf("Expected high spike rate for near-10V analog input, got: %.1f Hz", evSurge.SpikeRateHz)
	}

	// 4. Test PWM translation for analog motor/valve control
	freq, duty, err := adapter.ConvertIntentToPWM(75.5)
	if err != nil {
		t.Fatalf("PWM translation failed: %v", err)
	}
	if freq != 1000 || duty != 75.5 {
		t.Errorf("Unexpected PWM values: freq=%d, duty=%.2f", freq, duty)
	}

	// 5. Test invalid PWM rejection
	_, _, err = adapter.ConvertIntentToPWM(120.0)
	if err == nil {
		t.Errorf("Expected error for out-of-range PWM duty cycle")
	}

	// 6. Test LayerNorm Latent Dequantization
	rawVals := []float64{10.0, 20.0, 30.0, 40.0, 50.0}
	latent := adapter.DeQuantizeToLatent(rawVals)
	if len(latent) != 5 {
		t.Fatalf("Expected 5 latent dimensions, got %d", len(latent))
	}
	// Center value (30.0) should be near 0.0
	if latent[2] != 0.0 {
		t.Errorf("Expected mean-centered latent value 0.0, got: %.3f", latent[2])
	}

	// 7. Test Modbus FC16 Frame Synthesis with CRC-16
	registers := []uint16{0x01F4, 0x03E8} // 500, 1000
	modbusFrame := adapter.SynthesizeModbusFrame(0x01, 0x0064, registers)
	// Frame length: 1 (slave) + 1 (FC) + 2 (addr) + 2 (count) + 1 (bytes) + 4 (regs) + 2 (CRC) = 13 bytes
	if len(modbusFrame) != 13 {
		t.Fatalf("Expected 13-byte Modbus frame, got %d bytes", len(modbusFrame))
	}
	// Verify that calculating CRC over entire frame including CRC gives 0
	checkCRC := CalculateCRC16(modbusFrame)
	if checkCRC != 0 {
		t.Errorf("CRC-16 validation over full frame failed: expected 0 remainder, got 0x%04X", checkCRC)
	}
}
