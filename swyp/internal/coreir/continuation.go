package coreir

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"swyp-lang/internal/storageabi"
)

const (
	ContinuationVersion  uint64 = 1
	MaxContinuationBytes        = 6 << 20
)

// Continuation is an authority-free Core execution snapshot. It is useful only
// when a trusted host binds its digest to the immutable module/run identity and
// authenticates that binding. No capability, lease, fence or credential lives
// in this object.
type Continuation struct {
	Version        uint64              `json:"version"`
	ModuleHash     string              `json:"module_hash"`
	Entry          string              `json:"entry"`
	RunID          string              `json:"run_id"`
	FuelLimit      int                 `json:"fuel_limit"`
	StepsUsed      int                 `json:"steps_used"`
	MaxEffectBytes int                 `json:"max_effect_bytes"`
	EffectBytes    int                 `json:"effect_bytes"`
	EffectCursor   uint64              `json:"effect_cursor"`
	EffectData     []byte              `json:"effect_data,omitempty"`
	Storage        *storageabi.State   `json:"storage,omitempty"`
	Frames         []ContinuationFrame `json:"frames"`
}

// ContinuationFrame stores the precise mutable-slot interpreter position.
// AwaitingChild is set on caller frames whose current instruction is the call
// represented by the next frame. The leaf always points at its next instruction.
type ContinuationFrame struct {
	Function      string   `json:"function"`
	Block         int      `json:"block"`
	Instruction   int      `json:"instruction"`
	AwaitingChild bool     `json:"awaiting_child"`
	Slots         []string `json:"slots"`
}

func EncodeContinuation(c Continuation) ([]byte, error) {
	if err := validateContinuationEnvelope(c); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxContinuationBytes {
		return nil, diagnostic("continuation_too_large", fmt.Sprintf("continuation exceeds %d bytes", MaxContinuationBytes))
	}
	return raw, nil
}

func DecodeContinuation(raw []byte) (Continuation, error) {
	var c Continuation
	if err := decodeStrictBounded(raw, MaxContinuationBytes, &c); err != nil {
		return Continuation{}, err
	}
	if err := validateContinuationEnvelope(c); err != nil {
		return Continuation{}, err
	}
	return c, nil
}

func validateContinuationEnvelope(c Continuation) error {
	if c.Version != ContinuationVersion || c.FuelLimit < 1 || c.FuelLimit > MaxFuel || c.StepsUsed < 0 || c.StepsUsed > c.FuelLimit ||
		c.MaxEffectBytes < 0 || c.MaxEffectBytes > MaxEffectBytes || c.EffectBytes < 0 || c.EffectBytes > c.MaxEffectBytes ||
		len(c.EffectData) != c.EffectBytes || c.EffectCursor == 0 || c.EffectCursor > uint64(c.StepsUsed) ||
		!validContinuationDigest(c.ModuleHash) || !validContinuationEntry(c.Entry) || !validContinuationRunID(c.RunID) ||
		len(c.Frames) < 1 || len(c.Frames) > MaxCallDepth {
		return diagnostic("invalid_continuation", "invalid continuation version, budget or frame count")
	}
	for _, frame := range c.Frames {
		if frame.Function == "" || len(frame.Function) > 128 || frame.Block < 0 || frame.Instruction < 0 || len(frame.Slots) > MaxSlots {
			return diagnostic("invalid_continuation", "invalid continuation frame")
		}
		for _, encoded := range frame.Slots {
			if _, _, err := decodeContinuationValue(encoded); err != nil {
				return err
			}
		}
	}
	if c.Storage != nil {
		if c.Storage.MaxBlocks != storageabi.DefaultMaxBlocks || c.Storage.MaxBytes != storageabi.DefaultMaxBytes {
			return diagnostic("invalid_continuation", "continuation storage limits do not match the interpreter budget")
		}
		if _, err := storageabi.RestoreState(*c.Storage); err != nil {
			return diagnostic("invalid_continuation", err.Error())
		}
	}
	return nil
}

type decodedContinuationFrame struct {
	function executableFunction
	state    *machineFrame
}

func (e *Executable) decodeContinuationFrames(c Continuation) ([]decodedContinuationFrame, error) {
	if e == nil {
		return nil, diagnostic("invalid_continuation", "nil executable")
	}
	arenaBytes := len(e.data) + len(c.EffectData)
	frames := make([]decodedContinuationFrame, len(c.Frames))
	for i, encoded := range c.Frames {
		f, ok := e.functions[encoded.Function]
		if !ok || encoded.Block >= len(f.Blocks) || len(encoded.Slots) != len(f.Slots) {
			return nil, diagnostic("invalid_continuation", "continuation frame does not match executable")
		}
		block := f.Blocks[encoded.Block]
		if encoded.Instruction > len(block.Instructions) {
			return nil, diagnostic("invalid_continuation", "continuation instruction is outside block")
		}
		slots := make([]Value, len(encoded.Slots))
		for si, raw := range encoded.Slots {
			value, initialized, err := decodeContinuationValue(raw)
			if err != nil {
				return nil, err
			}
			if !initialized {
				continue
			}
			if value.typ != f.Slots[si] {
				return nil, diagnostic("invalid_continuation", "continuation slot type does not match executable")
			}
			if value.typ == Bytes {
				if _, _, err := byteSpanInArena(value.u, arenaBytes); err != nil {
					return nil, diagnostic("invalid_continuation", "continuation byte span is outside restored arena")
				}
			}
			slots[si] = value
		}
		for pi := range f.Params {
			if slots[pi].typ == "" {
				return nil, diagnostic("invalid_continuation", "continuation function parameter is uninitialized")
			}
		}
		frames[i] = decodedContinuationFrame{function: f, state: &machineFrame{
			function: encoded.Function, block: encoded.Block, instruction: encoded.Instruction,
			awaitingChild: encoded.AwaitingChild, slots: slots,
		}}
	}
	for i := range frames {
		leaf := i == len(frames)-1
		frame := frames[i].state
		if leaf {
			if frame.awaitingChild {
				return nil, diagnostic("invalid_continuation", "leaf continuation frame cannot await a child")
			}
			continue
		}
		if !frame.awaitingChild || frame.instruction >= len(frames[i].function.Blocks[frame.block].Instructions) {
			return nil, diagnostic("invalid_continuation", "caller continuation frame is not suspended on a call")
		}
		instruction := frames[i].function.Blocks[frame.block].Instructions[frame.instruction]
		if instruction.Op != "call" || instruction.Callee != frames[i+1].state.function {
			return nil, diagnostic("invalid_continuation", "continuation call stack does not match executable")
		}
	}
	leaf := frames[len(frames)-1]
	leafBlock := leaf.function.Blocks[leaf.state.block]
	if leaf.state.instruction == 0 || leaf.state.instruction > len(leafBlock.Instructions) {
		return nil, diagnostic("invalid_continuation", "continuation leaf is not at a post-effect boundary")
	}
	resolved := leafBlock.Instructions[leaf.state.instruction-1]
	if resolved.Op != EffectClockRead && resolved.Op != EffectFSRead {
		return nil, diagnostic("invalid_continuation", "continuation leaf does not follow a resolved effect")
	}
	if resolved.Dest < 0 || resolved.Dest >= len(leaf.state.slots) || leaf.state.slots[resolved.Dest].typ == "" {
		return nil, diagnostic("invalid_continuation", "resolved effect destination is not present in continuation state")
	}
	return frames, nil
}

func (m *machine) checkpointContinuation() error {
	if m == nil || m.effects == nil || m.effects.checkpoint == nil {
		return nil
	}
	c := Continuation{
		Version: ContinuationVersion, ModuleHash: m.executable.moduleHash, Entry: m.entry, RunID: m.runID,
		FuelLimit: m.limit, StepsUsed: m.used,
		MaxEffectBytes: m.effects.maxBytes, EffectBytes: m.effects.bytesUsed,
		EffectCursor: m.effects.sequence, Frames: make([]ContinuationFrame, len(m.frames)),
	}
	if m.effects.data != nil {
		base := len(m.executable.data)
		if len(m.effects.data) < base || !bytes.Equal(m.effects.data[:base], m.executable.data) {
			return diagnostic("invalid_continuation", "effect arena lost immutable module prefix")
		}
		c.EffectData = append([]byte(nil), m.effects.data[base:]...)
	}
	if len(c.EffectData) != c.EffectBytes {
		return diagnostic("invalid_continuation", "effect byte accounting does not match arena")
	}
	if m.storage != nil {
		state, err := m.storage.ExportState()
		if err != nil {
			return diagnostic("invalid_continuation", err.Error())
		}
		c.Storage = &state
	}
	for i, frame := range m.frames {
		encoded := ContinuationFrame{
			Function: frame.function, Block: frame.block, Instruction: frame.instruction,
			AwaitingChild: frame.awaitingChild, Slots: make([]string, len(frame.slots)),
		}
		for si, value := range frame.slots {
			encoded.Slots[si] = encodeContinuationValue(value)
		}
		c.Frames[i] = encoded
	}
	if _, err := EncodeContinuation(c); err != nil {
		return err
	}
	return m.effects.checkpoint(m.ctx, c)
}

func canonicalModuleHash(m Module) (string, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

// ModuleHash is the stable SHA-256 identity of the validated canonical module
// snapshot owned by this executable.
func (e *Executable) ModuleHash() string {
	if e == nil {
		return ""
	}
	return e.moduleHash
}

func validContinuationDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validContinuationEntry(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for i, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' {
			continue
		}
		if i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}

func validContinuationRunID(s string) bool {
	if len(s) == 0 || len(s) > 120 {
		return false
	}
	for _, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '_' || c == '.' || c == ':' || c == '-' {
			continue
		}
		return false
	}
	return true
}

func (m *machine) resumeFrames(frames []decodedContinuationFrame, index int) (Value, error) {
	if index < 0 || index >= len(frames) {
		return Value{}, diagnostic("invalid_continuation", "continuation frame index outside stack")
	}
	decoded := frames[index]
	frame := decoded.state
	m.frames = append(m.frames, frame)
	defer func() { m.frames = m.frames[:len(m.frames)-1] }()
	depth := index + 1
	if index+1 < len(frames) {
		instruction := decoded.function.Blocks[frame.block].Instructions[frame.instruction]
		value, err := m.resumeFrames(frames, index+1)
		if err != nil {
			return Value{}, err
		}
		frame.awaitingChild = false
		if instruction.Dest >= 0 {
			frame.slots[instruction.Dest] = value
		}
		return m.runFrame(decoded.function, frame, depth, frame.block, frame.instruction+1)
	}
	return m.runFrame(decoded.function, frame, depth, frame.block, frame.instruction)
}

func encodeContinuationValue(v Value) string {
	if v.typ == "" {
		return ""
	}
	bits := uint64(0)
	switch v.typ {
	case I64:
		bits = uint64(v.i)
	case U64, Bytes:
		bits = v.u
	case F64, IEEE64:
		bits = math.Float64bits(v.f)
	case Bool:
		if v.b {
			bits = 1
		}
	default:
		return ""
	}
	return string(v.typ) + ":" + fmt.Sprintf("%016x", bits)
}

func decodeContinuationValue(encoded string) (Value, bool, error) {
	if encoded == "" {
		return Value{}, false, nil
	}
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 || len(parts[1]) != 16 {
		return Value{}, false, diagnostic("invalid_continuation", "invalid encoded continuation value")
	}
	if decoded, err := hex.DecodeString(parts[1]); err != nil || hex.EncodeToString(decoded) != parts[1] {
		return Value{}, false, diagnostic("invalid_continuation", "continuation value bits must be lowercase hexadecimal")
	}
	bits, err := strconv.ParseUint(parts[1], 16, 64)
	if err != nil {
		return Value{}, false, diagnostic("invalid_continuation", "invalid continuation value bits")
	}
	t := Type(parts[0])
	switch t {
	case I64:
		return Int(int64(bits)), true, nil
	case U64:
		return Uint(bits), true, nil
	case F64:
		value := math.Float64frombits(bits)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return Value{}, false, diagnostic("invalid_continuation", "f64 continuation value must be finite")
		}
		return Value{typ: F64, f: value}, true, nil
	case IEEE64:
		return Value{typ: IEEE64, f: math.Float64frombits(bits)}, true, nil
	case Bool:
		if bits > 1 {
			return Value{}, false, diagnostic("invalid_continuation", "bool continuation value must be zero or one")
		}
		return Boolean(bits == 1), true, nil
	case Bytes:
		return Value{typ: Bytes, u: bits}, true, nil
	default:
		return Value{}, false, diagnostic("invalid_continuation", "unsupported continuation value type")
	}
}
