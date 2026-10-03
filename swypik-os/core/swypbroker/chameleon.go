package swypbroker

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"time"

	"swypik-os/core/chameleon"
)

const (
	ChameleonMMIOCapability = "hw_mmio_write"
	ChameleonMMIOTarget     = "swyp_mmio_write"
	ChameleonMMIOSymbol     = "swyp_mmio_write"
)

type chameleonMMIOGrant struct {
	controller *chameleon.HardwareController
	token      chameleon.CapabilityToken
}

// ChameleonMMIOResolver is a concrete authority resolver for the single
// allowlisted Swyp MMIO adapter. The capability token remains host-only inside
// Grant; it is never copied into Swyp request/response protocol objects.
type ChameleonMMIOResolver struct {
	controller *chameleon.HardwareController
	registers  []uint32
	ttl        time.Duration
}

func NewChameleonMMIOResolver(controller *chameleon.HardwareController, allowedRegisters []uint32, ttl time.Duration) (*ChameleonMMIOResolver, error) {
	if controller == nil || len(allowedRegisters) == 0 || ttl <= 0 {
		return nil, errors.New("chameleon MMIO resolver requires controller, allowed registers, and positive ttl")
	}
	seen := map[uint32]bool{}
	registers := make([]uint32, 0, len(allowedRegisters))
	for _, address := range allowedRegisters {
		if seen[address] {
			return nil, fmt.Errorf("duplicate allowed MMIO register 0x%X", address)
		}
		seen[address] = true
		registers = append(registers, address)
	}
	return &ChameleonMMIOResolver{controller: controller, registers: registers, ttl: ttl}, nil
}

func (r *ChameleonMMIOResolver) Resolve(ctx context.Context, auth Authorization) (Grant, error) {
	select {
	case <-ctx.Done():
		return Grant{}, ctx.Err()
	default:
	}
	if auth.Capability.Name != ChameleonMMIOCapability || auth.Capability.Effect != ForeignCallEffect || auth.Target != ChameleonMMIOTarget || auth.Symbol != ChameleonMMIOSymbol {
		return Grant{}, ErrCapabilityDenied
	}
	token := r.controller.MintCapability(append([]uint32(nil), r.registers...), true, r.ttl)
	return NewGrant(chameleonMMIOGrant{controller: r.controller, token: token}), nil
}

// RegisterChameleonMMIOAdapter installs exactly one trusted adapter. There is no
// generic symbol lookup or library loading path.
func RegisterChameleonMMIOAdapter(registry *AdapterRegistry) error {
	if registry == nil {
		return errors.New("adapter registry is required")
	}
	return registry.Register(ChameleonMMIOTarget, ChameleonMMIOSymbol, "C", "swyp-c64-v1", executeChameleonMMIOWrite)
}

func executeChameleonMMIOWrite(ctx context.Context, invocation Invocation) (WireValue, error) {
	select {
	case <-ctx.Done():
		return WireValue{}, ctx.Err()
	default:
	}
	if invocation.Target != ChameleonMMIOTarget || invocation.Symbol != ChameleonMMIOSymbol || invocation.ABI != "C" || invocation.ABIVersion != "swyp-c64-v1" {
		return WireValue{}, errors.New("unexpected Chameleon MMIO invocation contract")
	}
	if invocation.Capability.Name != ChameleonMMIOCapability || invocation.Capability.Effect != ForeignCallEffect {
		return WireValue{}, errors.New("unexpected Chameleon MMIO capability")
	}
	if len(invocation.Arguments) != 2 || invocation.Result.Kind != "void" {
		return WireValue{}, errors.New("swyp_mmio_write requires two u64 arguments and void result")
	}
	grant, ok := invocation.Grant.Value().(chameleonMMIOGrant)
	if !ok || grant.controller == nil {
		return WireValue{}, errors.New("invalid Chameleon MMIO host grant")
	}
	address, err := brokerU64Argument(invocation.Arguments[0])
	if err != nil {
		return WireValue{}, fmt.Errorf("MMIO address: %w", err)
	}
	value, err := brokerU64Argument(invocation.Arguments[1])
	if err != nil {
		return WireValue{}, fmt.Errorf("MMIO value: %w", err)
	}
	if address > math.MaxUint32 || value > math.MaxUint32 {
		return WireValue{}, errors.New("MMIO address/value exceeds uint32 hardware ABI")
	}
	if err := grant.controller.WriteMMIO(grant.token, uint32(address), uint32(value)); err != nil {
		return WireValue{}, err
	}
	return WireValue{}, nil
}

func brokerU64Argument(value WireValue) (uint64, error) {
	if value.Type.Kind != "u64" || value.Type.Size != 8 || value.Type.Align != 8 || value.Encoding != WireEncoding {
		return 0, errors.New("expected swyp-c64 u64")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(value.Data)
	if err != nil || len(data) != 8 {
		return 0, errors.New("invalid u64 wire bytes")
	}
	return binary.LittleEndian.Uint64(data), nil
}
