package coreir

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

type executableFunction struct {
	Function
	constants [][]Value
}

// Executable owns a validated snapshot. Mutating the input Module cannot alter
// its behavior. Concurrent runs use independent slots, stacks and fuel counters.
type Executable struct{ functions map[string]executableFunction }
type RunResult struct {
	Value Value `json:"value"`
	Steps int   `json:"steps"`
}

func Prepare(m Module) (*Executable, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	copy, err := Decode(data)
	if err != nil {
		return nil, err
	}
	e := &Executable{functions: map[string]executableFunction{}}
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
		e.functions[f.Name] = cf
	}
	return e, nil
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
	if ctx == nil || fuel < 1 || fuel > MaxFuel {
		return RunResult{}, diagnostic("invalid_budget", "context and fuel 1..1000000 required")
	}
	params, _, err := e.Parameters(entry)
	if err != nil {
		return RunResult{}, err
	}
	semantics, err := e.Semantics(entry)
	if err != nil {
		return RunResult{}, err
	}
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
	m := machine{executable: e, ctx: ctx, limit: fuel}
	value, err := m.call(entry, args, 1)
	return RunResult{Value: value, Steps: m.used}, err
}
func (m *machine) call(name string, args []Value, depth int) (Value, error) {
	if depth > 128 {
		return Value{}, diagnostic("call_depth", "call depth exceeds 128")
	}
	if err := m.tick(Location{}); err != nil {
		return Value{}, err
	}
	f := m.executable.functions[name]
	slots := make([]Value, len(f.Slots))
	copy(slots, args)
	block := 0
	for {
		b := f.Blocks[block]
		for ii, ins := range b.Instructions {
			if err := m.tick(ins.Location); err != nil {
				return Value{}, err
			}
			var value Value
			var err error
			switch ins.Op {
			case "const":
				value = f.constants[block][ii]
			case "move":
				value = slots[ins.Args[0]]
			default:
				var small [16]Value
				inputs := small[:len(ins.Args)]
				for i, a := range ins.Args {
					inputs[i] = slots[a]
				}
				if ins.Op == "call" {
					value, err = m.call(ins.Callee, inputs, depth+1)
				} else {
					value, err = Apply(ins.Op, inputs...)
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
		if err := m.tick(t.Location); err != nil {
			return Value{}, err
		}
		switch t.Op {
		case "return":
			if t.Value < 0 {
				return Value{typ: Void}, nil
			}
			return slots[t.Value], nil
		case "jump":
			block = t.Targets[0]
		case "branch":
			if slots[t.Value].b {
				block = t.Targets[0]
			} else {
				block = t.Targets[1]
			}
		case "unreachable":
			return Value{}, &Diagnostic{Code: "unreachable", Message: "unreachable terminator executed", Location: t.Location}
		}
	}
}
