package coreir

import (
	"fmt"
	"math"
)

// Contract v1 describes scalar functions. Effect metadata may describe a
// brokered effect profile, but verification never executes those host effects.
// Numeric intervals are inclusive; predicates are a typed expression tree,
// never host code or natural language. MaxSteps is a verification bound, not a
// proof of a program's complexity.
type Contract struct {
	Version       int         `json:"version"`
	Entry         string      `json:"entry"`
	Inputs        []Domain    `json:"inputs,omitempty"`
	Requires      []Predicate `json:"requires,omitempty"`
	Ensures       []Predicate `json:"ensures"`
	EffectVersion int         `json:"effect_version,omitempty"`
	Effects       []string    `json:"effects,omitempty"`
	MaxSteps      int         `json:"max_steps"`
}
type Domain struct {
	Name string `json:"name"`
	Type Type   `json:"type"`
	Min  string `json:"min"`
	Max  string `json:"max"`
}
type Predicate struct {
	Variable string      `json:"var,omitempty"`
	Constant *Literal    `json:"const,omitempty"`
	Op       string      `json:"op,omitempty"`
	Args     []Predicate `json:"args,omitempty"`
}
type interval struct{ low, high Value }

func DecodeContract(data []byte) (Contract, error) {
	var c Contract
	if err := DecodeStrict(data, &c); err != nil {
		return Contract{}, err
	}
	return c, nil
}
func (c Contract) validate(e *Executable) ([]interval, error) {
	bad := func(s string) error { return diagnostic("invalid_contract", s) }
	if c.Version != 1 || c.Entry == "" || len(c.Inputs) > 4 || len(c.Ensures) < 1 || len(c.Ensures) > 16 || len(c.Requires) > 16 || c.MaxSteps < 1 || c.MaxSteps > MaxFuel {
		return nil, bad("version, entry, predicate count or step bound invalid")
	}
	if err := validateCanonicalEffects(c.EffectVersion, c.Effects); err != nil {
		return nil, bad(err.Error())
	}
	semantics, err := e.Semantics(c.Entry)
	if err != nil {
		return nil, err
	}
	if !effectsEqual(c.Effects, semantics.Effects) {
		return nil, bad("contract effects do not exactly match executable effects")
	}
	params, result, err := e.Parameters(c.Entry)
	if err != nil {
		return nil, err
	}
	if result == Void || len(params) != len(c.Inputs) {
		return nil, bad("contract requires a scalar result and matching input arity")
	}
	env := map[string]Type{}
	bounds := make([]interval, len(params))
	for i, p := range params {
		d := c.Inputs[i]
		if p.Name == "result" || d.Name != p.Name || d.Type != p.Type || !d.Type.numeric() {
			return nil, bad("input name/type mismatch or reserved parameter result")
		}
		low, err := ParseValue(d.Type, d.Min)
		if err != nil {
			return nil, bad(err.Error())
		}
		high, err := ParseValue(d.Type, d.Max)
		if err != nil {
			return nil, bad(err.Error())
		}
		if d.Type == IEEE64 && (math.IsNaN(low.f) || math.IsInf(low.f, 0) || math.IsNaN(high.f) || math.IsInf(high.f, 0)) {
			return nil, bad("ieee64 contract bounds must be finite")
		}
		le, _ := Apply("le", low, high)
		if !le.b {
			return nil, bad("minimum exceeds maximum")
		}
		bounds[i] = interval{low: low, high: high}
		env[d.Name] = d.Type
	}
	nodes := 0
	for _, p := range c.Requires {
		t, err := predicateType(p, env, 0, &nodes)
		if err != nil {
			return nil, err
		}
		if t != Bool {
			return nil, bad("requires must be boolean")
		}
	}
	env["result"] = result
	for _, p := range c.Ensures {
		t, err := predicateType(p, env, 0, &nodes)
		if err != nil {
			return nil, err
		}
		if t != Bool {
			return nil, bad("ensures must be boolean")
		}
	}
	return bounds, nil
}
func predicateType(p Predicate, env map[string]Type, depth int, nodes *int) (Type, error) {
	bad := func(s string) (Type, error) { return "", diagnostic("invalid_contract", s) }
	*nodes++
	if depth > 32 || *nodes > 256 {
		return bad("predicate depth/node limit exceeded")
	}
	kinds := 0
	if p.Variable != "" {
		kinds++
	}
	if p.Constant != nil {
		kinds++
	}
	if p.Op != "" {
		kinds++
	}
	if kinds != 1 {
		return bad("predicate requires exactly one of var, const, op")
	}
	if p.Variable != "" {
		if len(p.Args) != 0 {
			return bad("variable has operands")
		}
		t, ok := env[p.Variable]
		if !ok {
			return bad("unknown predicate variable " + p.Variable)
		}
		return t, nil
	}
	if p.Constant != nil {
		if len(p.Args) != 0 {
			return bad("constant has operands")
		}
		v, err := ParseValue(p.Constant.Type, p.Constant.Value)
		if err != nil {
			return bad(err.Error())
		}
		return v.typ, nil
	}
	if len(p.Args) > 2 {
		return bad("predicate arity exceeds two")
	}
	types := make([]Type, len(p.Args))
	for i, a := range p.Args {
		var err error
		types[i], err = predicateType(a, env, depth+1, nodes)
		if err != nil {
			return "", err
		}
	}
	if p.Op == "and" || p.Op == "or" {
		if len(types) != 2 || types[0] != Bool || types[1] != Bool {
			return bad("boolean connective requires two booleans")
		}
		return Bool, nil
	}
	t, _, err := resultType(p.Op, types)
	if err != nil {
		return bad(err.Error())
	}
	return t, nil
}
func evalPredicate(p Predicate, env map[string]Value) (Value, error) {
	if p.Variable != "" {
		return env[p.Variable], nil
	}
	if p.Constant != nil {
		return ParseValue(p.Constant.Type, p.Constant.Value)
	}
	left, err := evalPredicate(p.Args[0], env)
	if err != nil {
		return Value{}, err
	}
	if p.Op == "and" && !left.b || p.Op == "or" && left.b {
		return left, nil
	}
	if len(p.Args) == 1 {
		return Apply(p.Op, left)
	}
	right, err := evalPredicate(p.Args[1], env)
	if err != nil {
		return Value{}, err
	}
	if p.Op == "and" || p.Op == "or" {
		return right, nil
	}
	return Apply(p.Op, left, right)
}
func contractDiagnostic(phase string, err error) *Diagnostic {
	return diagnostic("contract_evaluation", fmt.Sprintf("%s could not be evaluated: %v", phase, err))
}
