package chameleon

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// MMIOFlags represents register bitmasks mapped directly to hardware memory.
type MMIOFlags uint32

const (
	StatusReady       MMIOFlags = 1 << 0
	StatusEngaged     MMIOFlags = 1 << 1
	StatusThermalTrip MMIOFlags = 1 << 2
	StatusVibTrip     MMIOFlags = 1 << 3
	StatusSafetyLock  MMIOFlags = 1 << 4
)

// HardwareAddresses standard MMIO memory layout.
const (
	AddrStatusRegister   uint32 = 0x1000
	AddrActuationTorque  uint32 = 0x1004
	AddrCoolingDuty      uint32 = 0x1008
	AddrHardwareInterlock uint32 = 0x100C
)

// CapabilityToken is an unforgeable cryptographic authorization token (C-Space token).
type CapabilityToken struct {
	TokenID    string    `json:"token_id"`
	AllowedReg []uint32  `json:"allowed_registers"`
	CanWrite   bool      `json:"can_write"`
	ExpiresAt  time.Time `json:"expires_at"`
	Signature  string    `json:"signature"`
}

// TelemetryPacket captures real-time hardware status streamed through SPSC buffers.
type TelemetryPacket struct {
	Sequence       uint64    `json:"sequence"`
	TimestampNanos int64     `json:"timestamp_nanos"`
	ThermalC       float64   `json:"thermal_celsius"`
	VibrationG     float64   `json:"vibration_g"`
	PositionM      float64   `json:"position_meters"`
	VelocityMps    float64   `json:"velocity_mps"`
	MMIOBits       uint32    `json:"mmio_bits"`
}

// SPSCRingBuffer provides an ultra-low-latency Single-Producer Single-Consumer lockless queue.
type SPSCRingBuffer struct {
	buffer []TelemetryPacket
	mask   uint64
	head   uint64 // written by producer
	tail   uint64 // read by consumer
}

// NewSPSCRingBuffer creates a power-of-two bounded circular ring buffer.
func NewSPSCRingBuffer(sizePowerOfTwo int) *SPSCRingBuffer {
	if sizePowerOfTwo < 16 {
		sizePowerOfTwo = 1024
	}
	return &SPSCRingBuffer{
		buffer: make([]TelemetryPacket, sizePowerOfTwo),
		mask:   uint64(sizePowerOfTwo - 1),
	}
}

// Push appends a telemetry packet without blocking; overwrites oldest if saturated.
func (rb *SPSCRingBuffer) Push(packet TelemetryPacket) {
	h := atomic.LoadUint64(&rb.head)
	t := atomic.LoadUint64(&rb.tail)
	if h-t > rb.mask {
		// Buffer saturated: advance tail to prevent word tearing
		atomic.StoreUint64(&rb.tail, h-rb.mask)
	}
	rb.buffer[h&rb.mask] = packet
	atomic.StoreUint64(&rb.head, h+1)
}

// Pop retrieves the oldest packet, returning false if empty.
func (rb *SPSCRingBuffer) Pop() (TelemetryPacket, bool) {
	t := atomic.LoadUint64(&rb.tail)
	h := atomic.LoadUint64(&rb.head)
	if t >= h {
		return TelemetryPacket{}, false
	}
	packet := rb.buffer[t&rb.mask]
	atomic.StoreUint64(&rb.tail, t+1)
	return packet, true
}

// HardwareController manages the virtual and physical MMIO address space.
type HardwareController struct {
	mu            sync.RWMutex
	mmio          map[uint32]uint32
	ringBuffer    *SPSCRingBuffer
	masterSecret  []byte
	sequenceCount uint64
	emergencyLock atomic.Bool
}

// NewHardwareController initializes the chameleon hardware abstraction.
func NewHardwareController(secretKey []byte) *HardwareController {
	if len(secretKey) == 0 {
		secretKey = make([]byte, 32)
		_, _ = rand.Read(secretKey)
	}

	hc := &HardwareController{
		mmio:         make(map[uint32]uint32),
		ringBuffer:   NewSPSCRingBuffer(2048),
		masterSecret: secretKey,
	}

	hc.SetupDefaults()
	return hc
}

// SetupDefaults initializes standard MMIO registers.
func (hc *HardwareController) SetupDefaults() {
	hc.mu.Lock()
	defer hc.mu.Unlock()

	hc.mmio[AddrStatusRegister] = uint32(StatusReady | StatusSafetyLock)
	hc.mmio[AddrActuationTorque] = 0
	hc.mmio[AddrCoolingDuty] = 0
	hc.mmio[AddrHardwareInterlock] = 0
}

// MintCapability creates a cryptographically attested C-Space token.
func (hc *HardwareController) MintCapability(allowedRegs []uint32, canWrite bool, duration time.Duration) CapabilityToken {
	tokenBytes := make([]byte, 16)
	_, _ = rand.Read(tokenBytes)
	tokenID := hex.EncodeToString(tokenBytes)
	expires := time.Now().Add(duration)

	mac := hmac.New(sha256.New, hc.masterSecret)
	mac.Write([]byte(fmt.Sprintf("%s:%v:%v:%d", tokenID, allowedRegs, canWrite, expires.UnixNano())))
	sig := hex.EncodeToString(mac.Sum(nil))

	return CapabilityToken{
		TokenID:    tokenID,
		AllowedReg: allowedRegs,
		CanWrite:   canWrite,
		ExpiresAt:  expires,
		Signature:  sig,
	}
}

// VerifyCapability cryptographically validates that a token was issued by the Chameleon microkernel.
func (hc *HardwareController) VerifyCapability(token CapabilityToken, address uint32, write bool) bool {
	if time.Now().After(token.ExpiresAt) {
		return false
	}
	if write && !token.CanWrite {
		return false
	}

	allowed := false
	for _, reg := range token.AllowedReg {
		if reg == address {
			allowed = true
			break
		}
	}
	if !allowed {
		return false
	}

	mac := hmac.New(sha256.New, hc.masterSecret)
	mac.Write([]byte(fmt.Sprintf("%s:%v:%v:%d", token.TokenID, token.AllowedReg, token.CanWrite, token.ExpiresAt.UnixNano())))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(token.Signature), []byte(expected))
}

// WriteMMIO safely updates an MMIO register under capability verification.
func (hc *HardwareController) WriteMMIO(capToken CapabilityToken, address uint32, value uint32) error {
	if hc.emergencyLock.Load() {
		return errors.New("hardware interlock engaged: physical MMIO writes strictly prohibited")
	}

	if !hc.VerifyCapability(capToken, address, true) {
		return fmt.Errorf("capability access violation: unauthorized write to MMIO 0x%X", address)
	}

	hc.mu.Lock()
	defer hc.mu.Unlock()

	hc.mmio[address] = value
	return nil
}

// ReadMMIO retrieves a mapped register value.
func (hc *HardwareController) ReadMMIO(address uint32) uint32 {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	return hc.mmio[address]
}

// EngageEmergencyLock engages the hardware safety lock.
func (hc *HardwareController) EngageEmergencyLock() {
	hc.emergencyLock.Store(true)
	hc.mu.Lock()
	hc.mmio[AddrStatusRegister] |= uint32(StatusSafetyLock)
	hc.mmio[AddrActuationTorque] = 0 // Cut power
	hc.mu.Unlock()
}

// StreamTelemetryPacket pushes a sampled telemetry packet into the SPSC buffer.
func (hc *HardwareController) StreamTelemetryPacket(packet TelemetryPacket) {
	packet.Sequence = atomic.AddUint64(&hc.sequenceCount, 1)
	hc.ringBuffer.Push(packet)
}

// ReadNextTelemetry consumes the next available packet from the SPSC ring buffer.
func (hc *HardwareController) ReadNextTelemetry() (TelemetryPacket, bool) {
	return hc.ringBuffer.Pop()
}

// SandboxedCommand defines the reversible execution pattern for atomic hardware changes.
type SandboxedCommand interface {
	Execute(ctx context.Context, hc *HardwareController, capToken CapabilityToken) error
	Rollback(ctx context.Context, hc *HardwareController, capToken CapabilityToken) error
	Descriptor() string
}

// MultiRegisterActuationCommand coordinates atomic torque and cooling register updates.
type MultiRegisterActuationCommand struct {
	TargetTorque    uint32
	TargetCooling   uint32
	PreviousTorque  uint32
	PreviousCooling uint32
}

func (cmd *MultiRegisterActuationCommand) Execute(ctx context.Context, hc *HardwareController, capToken CapabilityToken) error {
	cmd.PreviousTorque = hc.ReadMMIO(AddrActuationTorque)
	cmd.PreviousCooling = hc.ReadMMIO(AddrCoolingDuty)

	if err := hc.WriteMMIO(capToken, AddrActuationTorque, cmd.TargetTorque); err != nil {
		return fmt.Errorf("torque write failed: %w", err)
	}

	if err := hc.WriteMMIO(capToken, AddrCoolingDuty, cmd.TargetCooling); err != nil {
		// Atomic compensation rollback
		if rbErr := cmd.Rollback(ctx, hc, capToken); rbErr != nil {
			return fmt.Errorf("cooling write failed: %w; rollback failure: %v", err, rbErr)
		}
		return fmt.Errorf("cooling write failed: %w", err)
	}

	return nil
}

func (cmd *MultiRegisterActuationCommand) Rollback(ctx context.Context, hc *HardwareController, capToken CapabilityToken) error {
	var errs []string
	if err := hc.WriteMMIO(capToken, AddrActuationTorque, cmd.PreviousTorque); err != nil {
		errs = append(errs, fmt.Sprintf("torque rollback: %v", err))
	}
	if err := hc.WriteMMIO(capToken, AddrCoolingDuty, cmd.PreviousCooling); err != nil {
		errs = append(errs, fmt.Sprintf("cooling rollback: %v", err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

func (cmd *MultiRegisterActuationCommand) Descriptor() string {
	return fmt.Sprintf("MultiRegisterActuation(Torque=%d, Cooling=%d)", cmd.TargetTorque, cmd.TargetCooling)
}
