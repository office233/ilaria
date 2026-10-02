package coreir

import (
	"context"
	"errors"
	"fmt"

	"swyp-lang/internal/storageabi"
)

// MaxEffectBytes bounds additional byte data returned by a broker in one run.
// Module constants have their separate MaxByteArenaBytes limit.
const MaxEffectBytes = 1 << 20

// EffectRunOptions contains host-supplied execution and response allocation
// budgets. These budgets do not grant authority to any effect.
type EffectRunOptions struct {
	Fuel       int
	MaxBytes   int
	RunID      string
	Checkpoint ContinuationHandler
}

// EffectCall is a detached invocation for an explicitly supplied host handler.
// Requirement is a declarative name, never an authority token. Path is owned by
// the handler and cannot mutate the executable or the running machine.
type EffectCall struct {
	Sequence      uint64
	Function      string
	Effect        string
	Requirement   string
	ResultType    Type
	Path          []byte
	FuelRemaining int
	MaxBytes      int
	Location      Location
}

// EffectReply must correlate with the invocation. clock.read returns a U64
// Value and no Bytes. fs.read returns owned Bytes and a zero Value; descriptors
// are allocated by the machine, never accepted from a host response.
type EffectReply struct {
	Sequence uint64
	Effect   string
	Value    Value
	Bytes    []byte
}

// EffectHandler runs synchronously on the safe interpreter's existing call
// stack. The handler must respect ctx, including while waiting for transport.
// Swyp itself does not resolve capabilities or perform host effects.
type EffectHandler func(ctx context.Context, call EffectCall) (EffectReply, error)

// ContinuationHandler is invoked only after a successful effect result has been
// incorporated into VM state and before the next guest instruction executes.
// A trusted caller can durably authenticate/persist the snapshot before
// returning. An error prevents further guest execution.
type ContinuationHandler func(ctx context.Context, continuation Continuation) error

// EffectRunResult retains the run's owned byte arena, so returned descriptors
// remain usable after the handler finishes without altering the executable.
type EffectRunResult struct {
	RunResult
	data []byte
}

func (r EffectRunResult) ResolveBytes(v Value) ([]byte, error) {
	if v.typ != Bytes {
		return nil, diagnostic("type_mismatch", "value is not bytes")
	}
	offset, length, err := byteSpanInArena(v.u, len(r.data))
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), r.data[offset:offset+length]...), nil
}

type effectExecution struct {
	handler     EffectHandler
	checkpoint  ContinuationHandler
	sequence    uint64
	maxBytes    int
	bytesUsed   int
	data        []byte
	requirement map[string]map[string]string
}

// EffectPreflight describes the validated broker requirements without running
// guest instructions. Binding keys are FUNCTION/EFFECT, and values are logical
// capability names. The returned slices and map are detached from executable
// state and convey no host authority.
type EffectPreflight struct {
	Entry              string
	Effects            []string
	CapabilityBindings map[string]string
}

// PreflightEffects applies the same supported-effect and unique-binding checks
// as RunWithEffects, including the selected entry's transitive declarations.
// It does not invoke a handler, read a clock, resolve a file, or execute a guest
// instruction. Pure entries produce empty, non-nil effects and bindings.
func (e *Executable) PreflightEffects(entry string) (EffectPreflight, error) {
	if e == nil {
		return EffectPreflight{}, diagnostic("invalid_ir", "nil executable")
	}
	f, ok := e.functions[entry]
	if !ok {
		return EffectPreflight{}, diagnostic("unknown_function", entry)
	}
	requirements, err := e.effectRequirements(entry)
	if err != nil {
		return EffectPreflight{}, err
	}
	bindings := make(map[string]string)
	for name, effects := range requirements {
		for effect, requirement := range effects {
			bindings[name+"/"+effect] = requirement
		}
	}
	return EffectPreflight{Entry: entry, Effects: append([]string{}, f.Effects...), CapabilityBindings: bindings}, nil
}

// RunWithEffects enables only clock.read and fs.read through handler and reuses
// the safe Core interpreter. Fuel, traps, calls, cancellation and storage retain
// Run's semantics. Unsupported effect profiles fail before guest execution.
// Run, RunFast, RunTurbo and Verify keep their existing pure-only boundaries.
func (e *Executable) RunWithEffects(ctx context.Context, entry string, args []Value, options EffectRunOptions, handler EffectHandler) (EffectRunResult, error) {
	if ctx == nil || options.Fuel < 1 || options.Fuel > MaxFuel || options.MaxBytes < 0 || options.MaxBytes > MaxEffectBytes {
		return EffectRunResult{}, diagnostic("invalid_budget", "context, fuel 1..1000000 and effect bytes 0..1048576 required")
	}
	if e == nil {
		return EffectRunResult{}, diagnostic("invalid_ir", "nil executable")
	}
	if options.Checkpoint != nil && !validContinuationRunID(options.RunID) {
		return EffectRunResult{}, diagnostic("invalid_run_id", "continuation checkpointing requires a bounded run identity")
	}
	f, ok := e.functions[entry]
	if !ok {
		return EffectRunResult{}, diagnostic("unknown_function", entry)
	}
	requirements, err := e.effectRequirements(entry)
	if err != nil {
		return EffectRunResult{}, err
	}
	if len(f.Effects) != 0 && handler == nil {
		return EffectRunResult{}, diagnostic("effect_handler_required", "effectful execution requires an explicit host handler")
	}
	if len(args) != len(f.Params) {
		return EffectRunResult{}, diagnostic("arity", "incorrect entry argument count")
	}
	for i, a := range args {
		if a.typ != f.Params[i].Type {
			return EffectRunResult{}, diagnostic("type_mismatch", fmt.Sprintf("entry argument %d requires %s", i, f.Params[i].Type))
		}
		if a.typ == Bytes {
			if _, _, err := e.byteSpanBounds(a.u); err != nil {
				return EffectRunResult{}, err
			}
		}
	}
	m := machine{executable: e, ctx: ctx, limit: options.Fuel, entry: entry, runID: options.RunID, effects: &effectExecution{
		handler: handler, checkpoint: options.Checkpoint, maxBytes: options.MaxBytes, requirement: requirements,
	}}
	value, err := m.call(entry, args, 1)
	return EffectRunResult{RunResult: RunResult{Value: value, Steps: m.used}, data: m.byteData()}, err
}

// ResumeWithEffects resumes an authenticated continuation without replaying the
// effect whose completed result produced the checkpoint. The caller must pass
// the original fuel/byte limits exactly; a continuation can never widen them.
func (e *Executable) ResumeWithEffects(ctx context.Context, entry string, continuation Continuation, options EffectRunOptions, handler EffectHandler) (EffectRunResult, error) {
	if ctx == nil || e == nil {
		return EffectRunResult{}, diagnostic("invalid_continuation", "resume requires context and executable")
	}
	if _, err := EncodeContinuation(continuation); err != nil {
		return EffectRunResult{}, err
	}
	if continuation.FuelLimit != options.Fuel || continuation.MaxEffectBytes != options.MaxBytes {
		return EffectRunResult{}, diagnostic("continuation_policy_changed", "resume budgets do not match the checkpoint")
	}
	if !validContinuationRunID(options.RunID) || continuation.RunID != options.RunID ||
		continuation.Entry != entry || continuation.ModuleHash != e.moduleHash ||
		continuation.Frames[0].Function != entry {
		return EffectRunResult{}, diagnostic("continuation_identity_mismatch", "continuation module, entry or run identity does not match requested execution")
	}
	requirements, err := e.effectRequirements(entry)
	if err != nil {
		return EffectRunResult{}, err
	}
	frames, err := e.decodeContinuationFrames(continuation)
	if err != nil {
		return EffectRunResult{}, err
	}
	m := machine{executable: e, ctx: ctx, limit: continuation.FuelLimit, used: continuation.StepsUsed, entry: entry, runID: options.RunID, effects: &effectExecution{
		handler: handler, checkpoint: options.Checkpoint, sequence: continuation.EffectCursor,
		maxBytes: continuation.MaxEffectBytes, bytesUsed: continuation.EffectBytes, requirement: requirements,
	}}
	if len(continuation.EffectData) != 0 {
		m.effects.data = append(append([]byte(nil), e.data...), continuation.EffectData...)
	}
	if continuation.Storage != nil {
		m.storage, err = storageabi.RestoreState(*continuation.Storage)
		if err != nil {
			return EffectRunResult{}, diagnostic("invalid_continuation", err.Error())
		}
	}
	value, err := m.resumeFrames(frames, 0)
	return EffectRunResult{RunResult: RunResult{Value: value, Steps: m.used}, data: m.byteData()}, err
}

func (e *Executable) effectRequirements(entry string) (map[string]map[string]string, error) {
	for _, effect := range e.functions[entry].Effects {
		if effect != EffectClockRead && effect != EffectFSRead {
			return nil, diagnostic("unsupported_effect", fmt.Sprintf("brokered Core execution does not support %s", effect))
		}
	}
	result := make(map[string]map[string]string)
	var visit func(string) error
	visit = func(name string) error {
		if _, visited := result[name]; visited {
			return nil
		}
		f := e.functions[name]
		bindings := make(map[string]string)
		result[name] = bindings
		for _, block := range f.Blocks {
			for _, instruction := range block.Instructions {
				if instruction.Op == "call" {
					if err := visit(instruction.Callee); err != nil {
						return err
					}
					continue
				}
				if instruction.Op != EffectClockRead && instruction.Op != EffectFSRead {
					continue
				}
				if _, bound := bindings[instruction.Op]; bound {
					continue
				}
				for _, requirement := range f.RequiredCapabilities {
					if requirement.Effect == instruction.Op {
						if bindings[instruction.Op] != "" {
							return &Diagnostic{Code: "ambiguous_capability", Message: fmt.Sprintf("%s requires one logical capability binding for %s", name, instruction.Op), Location: instruction.Location}
						}
						bindings[instruction.Op] = requirement.Name
					}
				}
			}
		}
		return nil
	}
	return result, visit(entry)
}

func (m *machine) executeEffect(f Function, instruction Instruction, slots []Value) (Value, error) {
	if m.effects == nil || m.effects.handler == nil {
		return Value{}, diagnostic("effect_handler_required", "effectful execution requires an explicit host handler")
	}
	call := EffectCall{
		Function: f.Name, Effect: instruction.Op,
		Requirement: m.effects.requirement[f.Name][instruction.Op],
		ResultType:  U64, FuelRemaining: m.limit - m.used,
		MaxBytes: m.effects.maxBytes - m.effects.bytesUsed, Location: instruction.Location,
	}
	if instruction.Op == EffectFSRead {
		view := slots[instruction.Args[0]]
		offset, length, err := m.byteSpanBounds(view.u)
		if err != nil {
			return Value{}, err
		}
		call.Path = append([]byte(nil), m.byteData()[offset:offset+length]...)
		call.ResultType = Bytes
	}
	if err := m.checkContext(instruction.Location); err != nil {
		return Value{}, err
	}
	m.effects.sequence++
	call.Sequence = m.effects.sequence
	reply, err := m.effects.handler(m.ctx, call)
	// A result arriving after cancellation cannot resume guest execution.
	if contextErr := m.checkContext(instruction.Location); contextErr != nil {
		return Value{}, contextErr
	}
	if err != nil {
		var d *Diagnostic
		if errors.As(err, &d) {
			return Value{}, err
		}
		return Value{}, diagnostic("effect_error", err.Error())
	}
	if reply.Sequence != call.Sequence || reply.Effect != call.Effect {
		return Value{}, diagnostic("effect_result_mismatch", "effect result does not match the pending invocation")
	}
	if call.ResultType == U64 {
		if reply.Value.typ != U64 || reply.Bytes != nil {
			return Value{}, diagnostic("type_mismatch", "clock.read result requires u64 and no bytes")
		}
		return reply.Value, nil
	}
	if reply.Value != (Value{}) {
		return Value{}, diagnostic("type_mismatch", "fs.read result requires bytes and no scalar or descriptor")
	}
	if len(reply.Bytes) > call.MaxBytes {
		return Value{}, diagnostic("effect_bytes_exhausted", "broker result exceeds the remaining byte budget")
	}
	if m.effects.data == nil {
		m.effects.data = append([]byte{}, m.executable.data...)
	}
	offset := len(m.effects.data)
	m.effects.data = append(m.effects.data, reply.Bytes...)
	m.effects.bytesUsed += len(reply.Bytes)
	return ByteSpan(uint32(offset), uint32(len(reply.Bytes)))
}

func (m *machine) byteData() []byte {
	if m.effects != nil && m.effects.data != nil {
		return m.effects.data
	}
	return m.executable.data
}

func (m *machine) byteSpanBounds(raw uint64) (offset, length int, err error) {
	return byteSpanInArena(raw, len(m.byteData()))
}

func byteSpanInArena(raw uint64, size int) (offset, length int, err error) {
	o := uint64(uint32(raw >> 32))
	l := uint64(uint32(raw))
	if o > uint64(size) || o+l > uint64(size) {
		return 0, 0, diagnostic("invalid_bytespan", "bytes descriptor is outside execution arena")
	}
	return int(o), int(l), nil
}
