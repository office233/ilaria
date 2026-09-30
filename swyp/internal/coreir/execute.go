package coreir

import (
	"context"
	"errors"
	"fmt"
)

type executableFunction struct {
	Function
	constants        [][]Value
	fastBlocks       [][]fastInstruction
	fastTerminators  []fastTerminator
	turboBlocks      [][]turboInstruction
	turboTerminators []turboTerminator
	turboExtras      []turboExtra
	turboLocations   []Location
}

// Executable owns a validated snapshot. Mutating the input Module cannot alter
// its behavior. Concurrent runs use independent slots, stacks and fuel counters.
type Executable struct {
	functions map[string]executableFunction
	data      []byte
}
type RunResult struct {
	Value Value `json:"value"`
	Steps int   `json:"steps"`
}

func Prepare(m Module) (*Executable, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	copy := cloneModule(m)
	e := &Executable{functions: map[string]executableFunction{}, data: append([]byte(nil), copy.Data...)}
	for _, f := range copy.Functions {
		cf := executableFunction{Function: f, constants: make([][]Value, len(f.Blocks))}
		for bi, b := range f.Blocks {
			cf.constants[bi] = make([]Value, len(b.Instructions))
			for ii, ins := range b.Instructions {
				if ins.Constant != nil {
					cf.constants[bi][ii], _ = ParseValue(ins.Constant.Type, ins.Constant.Value)
				}
			}
		}
		cf.fastBlocks = prepareFastBlocks(f, cf.constants)
		cf.fastTerminators = prepareFastTerminators(f)
		var err error
		cf.turboBlocks, cf.turboExtras, cf.turboLocations, err = prepareTurboBlocks(f, cf.constants)
		if err != nil {
			return nil, err
		}
		cf.turboTerminators, err = prepareTurboTerminators(f, &cf.turboLocations)
		if err != nil {
			return nil, err
		}
		e.functions[f.Name] = cf
	}
	return e, nil
}

func cloneModule(m Module) Module {
	out := Module{
		Version:   m.Version,
		Data:      append([]byte(nil), m.Data...),
		Functions: make([]Function, len(m.Functions)),
	}
	for fi, f := range m.Functions {
		cf := Function{
			Name:          f.Name,
			Result:        f.Result,
			EffectVersion: f.EffectVersion,
			Params:        append([]Parameter(nil), f.Params...),
			Effects:       append([]string(nil), f.Effects...),
			RequiredCapabilities: append(
				[]CapabilityRequirement(nil),
				f.RequiredCapabilities...,
			),
			Slots:  append([]Type(nil), f.Slots...),
			Blocks: make([]Block, len(f.Blocks)),
		}
		for bi, b := range f.Blocks {
			cb := Block{
				Instructions: make([]Instruction, len(b.Instructions)),
				Terminator: Terminator{
					Op:       b.Terminator.Op,
					Value:    b.Terminator.Value,
					Targets:  append([]int(nil), b.Terminator.Targets...),
					Location: b.Terminator.Location,
				},
			}
			for ii, ins := range b.Instructions {
				ci := Instruction{
					Op:       ins.Op,
					Dest:     ins.Dest,
					Args:     append([]int(nil), ins.Args...),
					Callee:   ins.Callee,
					MayTrap:  ins.MayTrap,
					Location: ins.Location,
				}
				if ins.Constant != nil {
					lit := *ins.Constant
					ci.Constant = &lit
				}
				cb.Instructions[ii] = ci
			}
			cf.Blocks[bi] = cb
		}
		out.Functions[fi] = cf
	}
	return out
}

// ResolveBytes validates an opaque bytes descriptor against this executable's
// immutable module arena and returns an owned copy. Callers never receive a raw
// pointer or mutable alias into executable state.
func (e *Executable) ResolveBytes(v Value) ([]byte, error) {
	if e == nil {
		return nil, diagnostic("invalid_ir", "nil executable")
	}
	if v.typ != Bytes {
		return nil, diagnostic("type_mismatch", "value is not bytes")
	}
	offset, length, err := e.byteSpanBounds(v.u)
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), e.data[offset:offset+length]...), nil
}

func (e *Executable) byteSpanBounds(raw uint64) (offset, length int, err error) {
	if e == nil {
		return 0, 0, diagnostic("invalid_ir", "nil executable")
	}
	o := uint64(uint32(raw >> 32))
	l := uint64(uint32(raw))
	end := o + l
	if o > uint64(len(e.data)) || end > uint64(len(e.data)) {
		return 0, 0, diagnostic("invalid_bytespan", "bytes descriptor is outside executable arena")
	}
	return int(o), int(l), nil
}

func (m *machine) bytesLenValue(view Value) (Value, error) {
	if view.typ != Bytes {
		return Value{}, diagnostic("type_mismatch", "bytes.len requires bytes")
	}
	_, length, err := m.executable.byteSpanBounds(view.u)
	if err != nil {
		return Value{}, err
	}
	return Uint(uint64(length)), nil
}

func (m *machine) bytesGetValue(view, index Value) (Value, error) {
	if view.typ != Bytes || index.typ != U64 {
		return Value{}, diagnostic("type_mismatch", "bytes.get requires bytes and u64")
	}
	value, err := m.bytesGetRaw(view.u, index.u)
	if err != nil {
		return Value{}, err
	}
	return Uint(value), nil
}

func (m *machine) bytesLenRaw(raw uint64) (uint64, error) {
	_, length, err := m.executable.byteSpanBounds(raw)
	if err != nil {
		return 0, err
	}
	return uint64(length), nil
}

func (m *machine) bytesGetRaw(raw, index uint64) (uint64, error) {
	offset, length, err := m.executable.byteSpanBounds(raw)
	if err != nil {
		return 0, err
	}
	if index >= uint64(length) {
		return 0, diagnostic("bounds", fmt.Sprintf("bytes index %d outside length %d", index, length))
	}
	return uint64(m.executable.data[offset+int(index)]), nil
}

func (e *Executable) Parameters(entry string) ([]Parameter, Type, error) {
	if e == nil {
		return nil, "", diagnostic("invalid_ir", "nil executable")
	}
	f, ok := e.functions[entry]
	if !ok {
		return nil, "", diagnostic("unknown_function", entry)
	}
	return append([]Parameter(nil), f.Params...), f.Result, nil
}

// Semantics returns the prepared function's immutable pure/effectful profile.
// Capability requirements are declarative names only; opaque authority remains
// outside Core IR and is owned by the SwypikOS capability broker.
func (e *Executable) Semantics(entry string) (FunctionSemantics, error) {
	if e == nil {
		return FunctionSemantics{}, diagnostic("invalid_ir", "nil executable")
	}
	f, ok := e.functions[entry]
	if !ok {
		return FunctionSemantics{}, diagnostic("unknown_function", entry)
	}
	return semanticsForFunction(f.Function), nil
}

type machine struct {
	executable  *Executable
	ctx         context.Context
	limit, used int
	fast        bool
}

func (m *machine) tick(loc Location) error {
	select {
	case <-m.ctx.Done():
		code := "cancelled"
		if errors.Is(m.ctx.Err(), context.DeadlineExceeded) {
			code = "timeout"
		}
		return &Diagnostic{Code: code, Message: m.ctx.Err().Error(), Location: loc}
	default:
	}
	if m.used >= m.limit {
		return &Diagnostic{Code: "fuel_exhausted", Message: "host instruction budget exhausted", Location: loc}
	}
	m.used++
	return nil
}

// Run counts one unit per function entry, instruction, and terminator. Budgets
// are host supplied and independent of the AST and STV2 accounting schemes.
func (e *Executable) Run(ctx context.Context, entry string, args []Value, fuel int) (RunResult, error) {
	return e.run(ctx, entry, args, fuel, false)
}

// RunFast preserves successful Core value semantics but uses coarse fuel
// accounting suitable for latency-sensitive embedded execution: one tick per
// function entry and one tick whenever control flow takes a loop backedge.
// Verification and exact-fuel claims must continue to use Run.
func (e *Executable) RunFast(ctx context.Context, entry string, args []Value, fuel int) (RunResult, error) {
	return e.run(ctx, entry, args, fuel, true)
}

func (e *Executable) run(ctx context.Context, entry string, args []Value, fuel int, fast bool) (RunResult, error) {
	if ctx == nil || fuel < 1 || fuel > MaxFuel {
		return RunResult{}, diagnostic("invalid_budget", "context and fuel 1..1000000 required")
	}
	if e == nil {
		return RunResult{}, diagnostic("invalid_ir", "nil executable")
	}
	f, ok := e.functions[entry]
	if !ok {
		return RunResult{}, diagnostic("unknown_function", entry)
	}
	params := f.Params
	semantics := semanticsForFunction(f.Function)
	if semantics.Purity != "pure" {
		return RunResult{}, diagnostic("effectful_program", "Core executor does not execute host effects; submit an EffectRequest to the SwypikOS capability broker")
	}
	if len(args) != len(params) {
		return RunResult{}, diagnostic("arity", "incorrect entry argument count")
	}
	for i, a := range args {
		if a.typ != params[i].Type {
			return RunResult{}, diagnostic("type_mismatch", fmt.Sprintf("entry argument %d requires %s", i, params[i].Type))
		}
	}
	m := machine{executable: e, ctx: ctx, limit: fuel, fast: fast}
	value, err := m.call(entry, args, 1)
	return RunResult{Value: value, Steps: m.used}, err
}
func (m *machine) call(name string, args []Value, depth int) (Value, error) {
	if depth > MaxCallDepth {
		return Value{}, diagnostic("call_depth", fmt.Sprintf("call depth exceeds %d", MaxCallDepth))
	}
	if err := m.tick(Location{}); err != nil {
		return Value{}, err
	}
	f := m.executable.functions[name]
	const stackSlotLimit = 128
	var localSlots [stackSlotLimit]Value
	var slots []Value
	if len(f.Slots) <= stackSlotLimit {
		slots = localSlots[:len(f.Slots)]
	} else {
		slots = make([]Value, len(f.Slots))
	}
	copy(slots, args)
	block := 0
	for {
		b := f.Blocks[block]
		for ii, ins := range b.Instructions {
			if !m.fast {
				if err := m.tick(ins.Location); err != nil {
					return Value{}, err
				}
			}
			var value Value
			var err error
			if m.fast {
				value, err = m.executeFastInstruction(f.fastBlocks[block][ii], slots, depth)
			} else {
				switch ins.Op {
				case "const":
					value = f.constants[block][ii]
				case "move":
					value = slots[ins.Args[0]]
				case "call":
					var small [16]Value
					inputs := small[:len(ins.Args)]
					for i, a := range ins.Args {
						inputs[i] = slots[a]
					}
					value, err = m.call(ins.Callee, inputs, depth+1)
				case "bytes.len":
					value, err = m.bytesLenValue(slots[ins.Args[0]])
				case "bytes.get":
					value, err = m.bytesGetValue(slots[ins.Args[0]], slots[ins.Args[1]])
				default:
					switch len(ins.Args) {
					case 1:
						value, err = Apply(ins.Op, slots[ins.Args[0]])
					case 2:
						value, err = Apply(ins.Op, slots[ins.Args[0]], slots[ins.Args[1]])
					default:
						return Value{}, &Diagnostic{
							Code:     "invalid_ir",
							Message:  "prepared non-call instruction has unsupported arity",
							Location: ins.Location,
						}
					}
				}
			}
			if err != nil {
				var d *Diagnostic
				if errors.As(err, &d) && d.Location.Line == 0 {
					copy := *d
					copy.Location = ins.Location
					err = &copy
				}
				return Value{}, err
			}
			if ins.Dest >= 0 {
				slots[ins.Dest] = value
			}
		}
		t := b.Terminator
		if !m.fast {
			if err := m.tick(t.Location); err != nil {
				return Value{}, err
			}
		}
		switch t.Op {
		case "return":
			if t.Value < 0 {
				return Value{typ: Void}, nil
			}
			return slots[t.Value], nil
		case "jump":
			target := t.Targets[0]
			if m.fast && target <= block {
				if err := m.tick(t.Location); err != nil {
					return Value{}, err
				}
			}
			block = target
		case "branch":
			target := t.Targets[1]
			if slots[t.Value].b {
				target = t.Targets[0]
			}
			if m.fast && target <= block {
				if err := m.tick(t.Location); err != nil {
					return Value{}, err
				}
			}
			block = target
		case "unreachable":
			return Value{}, &Diagnostic{Code: "unreachable", Message: "unreachable terminator executed", Location: t.Location}
		}
	}
}
