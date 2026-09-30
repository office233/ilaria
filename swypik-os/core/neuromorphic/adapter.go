package neuromorphic

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// SignalType indicates the analog legacy interface.
type SignalType string

const (
	SignalAnalogVoltage SignalType = "0_10v_analog"
	SignalCurrentLoop   SignalType = "4_20ma_current"
	SignalTachometer    SignalType = "pulse_tachometer"
)

// LIFNeuron implements a biological Leaky Integrate-and-Fire model.
type LIFNeuron struct {
	VMembrane       float64 // Membrane potential (mV)
	VRest           float64 // Resting potential (-70 mV)
	VThreshold      float64 // Firing threshold (-50 mV)
	VReset          float64 // Reset potential (-75 mV)
	DecayRate       float64 // Exponential decay factor (0.0 to 1.0)
	SpikeCount      int64
	LastSpikeTime   time.Time
	RefractoryUntil time.Time
}

// SpikeEvent represents an asynchronous event emitted by the neuromorphic adapter.
type SpikeEvent struct {
	Timestamp   time.Time `json:"timestamp"`
	Channel     int       `json:"channel"`
	SpikeRateHz float64   `json:"spike_rate_hz"`
	PhysicalVal float64   `json:"physical_val"`
	Anomaly     bool      `json:"anomaly"`
}

// Adapter bridges analog legacy industrial equipment into the SwypikOS cognitive bus.
type Adapter struct {
	mu           sync.RWMutex
	neurons      [4]*LIFNeuron
	anomalyLimit float64 // Spike rate threshold for emergency alert
	recentSpikes []SpikeEvent
	powerWatts   float64 // Ultra-low power consumption (e.g. 0.028 W = 28 mW)
}

// NewAdapter initializes the neuromorphic edge adapter.
func NewAdapter() *Adapter {
	a := &Adapter{
		anomalyLimit: 180.0, // > 180 Hz indicates abnormal vibration / motor surge
		recentSpikes: make([]SpikeEvent, 0),
		powerWatts:   0.028, // 28 mW ultra-low power budget
	}

	for i := 0; i < 4; i++ {
		a.neurons[i] = &LIFNeuron{
			VMembrane:  -70.0,
			VRest:      -70.0,
			VThreshold: -50.0,
			VReset:     -75.0,
			DecayRate:  0.85,
		}
	}

	return a
}

// IngestAnalog converts a continuous analog physical reading into LIF spike trains.
func (a *Adapter) IngestAnalog(channel int, signal SignalType, rawValue float64, dtMs float64) SpikeEvent {
	a.mu.Lock()
	defer a.mu.Unlock()

	if channel < 0 || channel >= 4 {
		channel = 0
	}
	n := a.neurons[channel]
	now := time.Now()

	// 1. Normalize physical signal to synaptic input current
	var current float64
	var physicalVal float64

	switch signal {
	case SignalAnalogVoltage: // 0 to 10V
		val := math.Max(0.0, math.Min(10.0, rawValue))
		physicalVal = val
		current = val * 5.0 // Map 0-10V to 0-50 pA input current

	case SignalCurrentLoop: // 4 to 20 mA (Pressure, Level)
		val := math.Max(4.0, math.Min(20.0, rawValue))
		physicalVal = (val - 4.0) / 16.0 * 100.0 // 0 to 100% engineering units
		current = (val - 4.0) * 3.5

	case SignalTachometer: // Pulses / RPM
		physicalVal = rawValue
		current = math.Min(60.0, rawValue/100.0)
	}

	// 2. Leaky integration step: V(t+dt) = V_rest + (V(t) - V_rest)*decay + I
	if now.After(n.RefractoryUntil) {
		n.VMembrane = n.VRest + (n.VMembrane-n.VRest)*n.DecayRate + current*(dtMs/10.0)
	}

	// 3. Threshold fire & reset
	spiked := false
	if n.VMembrane >= n.VThreshold {
		spiked = true
		n.SpikeCount++
		n.VMembrane = n.VReset
		n.RefractoryUntil = now.Add(2 * time.Millisecond) // 2ms refractory
		n.LastSpikeTime = now
	}

	// Calculate instantaneous spike rate (Hz)
	spikeRate := current * 3.6
	anomaly := spikeRate > a.anomalyLimit

	event := SpikeEvent{
		Timestamp:   now,
		Channel:     channel,
		SpikeRateHz: math.Round(spikeRate*10) / 10,
		PhysicalVal: math.Round(physicalVal*100) / 100,
		Anomaly:     anomaly,
	}

	if spiked {
		a.recentSpikes = append(a.recentSpikes, event)
		if len(a.recentSpikes) > 100 {
			copy(a.recentSpikes, a.recentSpikes[len(a.recentSpikes)-50:])
			for i := 50; i < len(a.recentSpikes); i++ {
				a.recentSpikes[i] = SpikeEvent{}
			}
			a.recentSpikes = a.recentSpikes[:50]
		}
	}

	return event
}

// ConvertIntentToPWM translates a high-level cognitive intent into analog PWM duty cycle (0-100%).
func (a *Adapter) ConvertIntentToPWM(targetPercent float64) (frequencyHz int, dutyCyclePercent float64, err error) {
	if targetPercent < 0.0 || targetPercent > 100.0 {
		return 0, 0, fmt.Errorf("PWM duty cycle out of range [0-100]: %.2f", targetPercent)
	}

	// Industrial 1 kHz PWM modulation
	return 1000, targetPercent, nil
}

// GetTelemetry returns adapter power consumption and active neuron states.
func (a *Adapter) GetTelemetry() (powerMilliwatts float64, totalSpikes int64) {
	a.mu.RLock()
	defer a.mu.RUnlock()

	var total int64
	for _, n := range a.neurons {
		total += n.SpikeCount
	}

	return a.powerWatts * 1000.0, total
}

// DeQuantizeToLatent normalizes legacy industrial register sweeps into a standardized latent embedding vector:
// s_t = LayerNorm(W_in * v_raw + b_in)
func (a *Adapter) DeQuantizeToLatent(rawRegisters []float64) []float64 {
	n := len(rawRegisters)
	if n == 0 {
		return nil
	}

	// 1. Calculate Mean
	var sum float64
	for _, v := range rawRegisters {
		sum += v
	}
	mean := sum / float64(n)

	// 2. Calculate Variance
	var sumSqDiff float64
	for _, v := range rawRegisters {
		diff := v - mean
		sumSqDiff += diff * diff
	}
	variance := sumSqDiff / float64(n)
	stdDev := math.Sqrt(variance + 1e-5) // eps = 1e-5

	// 3. LayerNorm standardization
	latent := make([]float64, n)
	for i, v := range rawRegisters {
		latent[i] = math.Round(((v-mean)/stdDev)*1000) / 1000
	}

	return latent
}

// CalculateCRC16 computes standard industrial Modbus RTU CRC-16 (polynomial 0xA001).
func CalculateCRC16(data []byte) uint16 {
	var crc uint16 = 0xFFFF
	for _, b := range data {
		crc ^= uint16(b)
		for i := 0; i < 8; i++ {
			if (crc & 0x0001) != 0 {
				crc = (crc >> 1) ^ 0xA001
			} else {
				crc = crc >> 1
			}
		}
	}
	return crc
}

// SynthesizeModbusFrame converts a high-level intent vector into a compliant Modbus FC16 frame.
func (a *Adapter) SynthesizeModbusFrame(slaveID byte, startAddr uint16, registers []uint16) []byte {
	regCount := uint16(len(registers))
	byteCount := byte(regCount * 2)

	// Frame header: [SlaveID, FunctionCode 0x10, StartAddrHi, StartAddrLo, RegCountHi, RegCountLo, ByteCount]
	frame := make([]byte, 7+byteCount+2)
	frame[0] = slaveID
	frame[1] = 0x10 // Function Code 16 (Preset Multiple Registers)
	frame[2] = byte(startAddr >> 8)
	frame[3] = byte(startAddr & 0xFF)
	frame[4] = byte(regCount >> 8)
	frame[5] = byte(regCount & 0xFF)
	frame[6] = byteCount

	offset := 7
	for _, reg := range registers {
		frame[offset] = byte(reg >> 8)
		frame[offset+1] = byte(reg & 0xFF)
		offset += 2
	}

	// Calculate and append CRC-16 (Low byte first, then High byte)
	crc := CalculateCRC16(frame[:offset])
	frame[offset] = byte(crc & 0xFF)
	frame[offset+1] = byte(crc >> 8)

	return frame
}
