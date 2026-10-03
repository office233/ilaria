package coreir

import (
	"context"
	"errors"
	"math"
	"math/big"
	"math/rand"
	"strings"
)

const MaxCases = 10000
const MaxTotalFuel = 10000000

type VerifyOptions struct {
	MaxCases    int   `json:"max_cases"`
	FuelPerCase int   `json:"fuel_per_case"`
	TotalFuel   int   `json:"total_fuel"`
	Seed        int64 `json:"seed"`
}

func DefaultVerifyOptions() VerifyOptions {
	return VerifyOptions{MaxCases: 256, FuelPerCase: 100000, TotalFuel: MaxTotalFuel, Seed: 1}
}

type NamedValue struct {
	Name  string `json:"name"`
	Value Value  `json:"value"`
}
type Witness struct {
	Inputs        []NamedValue `json:"inputs,omitempty"`
	Result        *Value       `json:"result,omitempty"`
	Diagnostic    *Diagnostic  `json:"diagnostic,omitempty"`
	Postcondition int          `json:"postcondition"`
}
type Verification struct {
	Version              int                     `json:"version"`
	Status               string                  `json:"status"`
	Method               string                  `json:"method"`
	Entry                string                  `json:"entry"`
	Purity               string                  `json:"purity,omitempty"`
	EffectVersion        int                     `json:"effect_version,omitempty"`
	Effects              []string                `json:"effects,omitempty"`
	RequiredCapabilities []CapabilityRequirement `json:"required_capabilities,omitempty"`
	DomainSize           string                  `json:"domain_size,omitempty"`
	Exhaustive           bool                    `json:"exhaustive"`
	CasesExamined        int                     `json:"cases_examined"`
	CasesChecked         int                     `json:"cases_checked"`
	CasesSkipped         int                     `json:"cases_skipped"`
	StepsConsumed        int                     `json:"steps_consumed"`
	Budgets              VerifyOptions           `json:"budgets"`
	Reason               string                  `json:"reason,omitempty"`
	Witness              *Witness                `json:"witness,omitempty"`
	SourceSHA256         string                  `json:"source_sha256,omitempty"`
	IRSHA256             string                  `json:"ir_sha256,omitempty"`
	ContractSHA256       string                  `json:"contract_sha256,omitempty"`
}

// Verify is bounded testing, not an SMT proof. "exhaustive" means all tuples in
// a finite i64 domain were enumerated; "tested" means sampled evidence only.
// Empty admissible domains and resource exhaustion never produce success.
func Verify(ctx context.Context, e *Executable, c Contract, options VerifyOptions) (Verification, error) {
	r := Verification{Version: 1, Status: "unknown", Entry: c.Entry, Budgets: options}
	if ctx == nil || options.MaxCases < 1 || options.MaxCases > MaxCases || options.FuelPerCase < 1 || options.FuelPerCase > MaxFuel || options.TotalFuel < 1 || options.TotalFuel > MaxTotalFuel {
		return r, diagnostic("invalid_budget", "verification host budgets out of range")
	}
	semantics, err := e.Semantics(c.Entry)
	if err != nil {
		return r, err
	}
	r.Purity = semantics.Purity
	r.EffectVersion = semantics.EffectVersion
	r.Effects = append([]string(nil), semantics.Effects...)
	r.RequiredCapabilities = append([]CapabilityRequirement(nil), semantics.RequiredCapabilities...)
	bounds, err := c.validate(e)
	if err != nil {
		return r, err
	}
	if semantics.Purity != "pure" {
		r.Method = "effect-contract-validation"
		r.Reason = "effectful_execution_not_supported"
		return r, nil
	}
	if r.Budgets.FuelPerCase > c.MaxSteps {
		r.Budgets.FuelPerCase = c.MaxSteps
	}
	allInteger := true
	total := big.NewInt(1)
	for _, b := range bounds {
		if b.low.typ != I64 && b.low.typ != U64 {
			allInteger = false
			continue
		}
		var low, high *big.Int
		if b.low.typ == I64 {
			low = big.NewInt(b.low.i)
			high = big.NewInt(b.high.i)
		} else {
			low = new(big.Int).SetUint64(b.low.u)
			high = new(big.Int).SetUint64(b.high.u)
		}
		width := new(big.Int).Sub(high, low)
		width.Add(width, big.NewInt(1))
		total.Mul(total, width)
	}
	if allInteger {
		r.DomainSize = total.String()
	}
	enumerate := allInteger && total.Cmp(big.NewInt(int64(options.MaxCases))) <= 0
	limit := options.MaxCases
	r.Method = "boundary-and-seeded-sampling"
	if enumerate {
		limit = int(total.Int64())
		r.Method = "integer-cartesian-enumeration"
	}
	rng := rand.New(rand.NewSource(options.Seed))
	seen := map[string]bool{}
	makeWitness := func(args []Value) *Witness {
		w := &Witness{Postcondition: -1}
		for i, v := range args {
			w.Inputs = append(w.Inputs, NamedValue{Name: c.Inputs[i].Name, Value: v})
		}
		return w
	}
	cancelled := func() bool {
		if ctx.Err() == nil {
			return false
		}
		r.Status = "unknown"
		r.Reason = "cancelled"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			r.Status = "timeout"
			r.Reason = "deadline_exceeded"
		}
		return true
	}
	for attempt := 0; attempt < limit*16 && r.CasesExamined < limit; attempt++ {
		if cancelled() {
			return r, nil
		}
		var args []Value
		if enumerate {
			args = enumeratedCase(bounds, r.CasesExamined)
		} else {
			args = sampledCase(bounds, attempt, rng)
		}
		var key strings.Builder
		for _, a := range args {
			lit := a.Literal()
			key.WriteString(string(lit.Type))
			key.WriteByte(':')
			key.WriteString(lit.Value)
			key.WriteByte(';')
		}
		if seen[key.String()] {
			continue
		}
		seen[key.String()] = true
		r.CasesExamined++
		env := map[string]Value{}
		for i, a := range args {
			env[c.Inputs[i].Name] = a
		}
		admissible := true
		for _, p := range c.Requires {
			v, err := evalPredicate(p, env)
			if err != nil {
				r.Reason = "contract_evaluation"
				r.Witness = makeWitness(args)
				r.Witness.Diagnostic = contractDiagnostic("requires", err)
				return r, nil
			}
			if !v.b {
				admissible = false
				break
			}
		}
		if !admissible {
			r.CasesSkipped++
			continue
		}
		remaining := options.TotalFuel - r.StepsConsumed
		if remaining <= 0 {
			r.Reason = "total_fuel_exhausted"
			return r, nil
		}
		fuel := r.Budgets.FuelPerCase
		if remaining < fuel {
			fuel = remaining
		}
		r.CasesChecked++
		out, err := e.Run(ctx, c.Entry, args, fuel)
		r.StepsConsumed += out.Steps
		if err != nil {
			var d *Diagnostic
			if !errors.As(err, &d) {
				d = diagnostic("runtime_error", err.Error())
			}
			r.Witness = makeWitness(args)
			copy := *d
			r.Witness.Diagnostic = &copy
			switch d.Code {
			case "timeout":
				r.Status = "timeout"
				r.Reason = "deadline_exceeded"
			case "cancelled":
				r.Reason = "cancelled"
			case "fuel_exhausted", "call_depth":
				r.Reason = d.Code
			default:
				r.Status = "counterexample"
				r.Reason = "runtime_error"
			}
			return r, nil
		}
		env["result"] = out.Value
		for i, p := range c.Ensures {
			v, err := evalPredicate(p, env)
			if err != nil {
				r.Reason = "contract_evaluation"
				r.Witness = makeWitness(args)
				r.Witness.Result = &out.Value
				r.Witness.Diagnostic = contractDiagnostic("ensures", err)
				r.Witness.Postcondition = i
				return r, nil
			}
			if !v.b {
				r.Status = "counterexample"
				r.Reason = "postcondition_failed"
				r.Witness = makeWitness(args)
				r.Witness.Result = &out.Value
				r.Witness.Postcondition = i
				return r, nil
			}
		}
	}
	if cancelled() {
		return r, nil
	}
	if r.CasesChecked == 0 {
		r.Reason = "no_admissible_inputs"
		return r, nil
	}
	r.Status = "tested"
	if enumerate && r.CasesExamined == limit {
		r.Status = "exhaustive"
		r.Exhaustive = true
	}
	return r, nil
}
func enumeratedCase(bounds []interval, index int) []Value {
	values := make([]Value, len(bounds))
	for i := len(bounds) - 1; i >= 0; i-- {
		// This path is used only after proving that the entire product <= 10000.
		if bounds[i].low.typ == U64 {
			width := bounds[i].high.u - bounds[i].low.u + 1
			values[i] = Uint(bounds[i].low.u + uint64(index%int(width)))
			index /= int(width)
			continue
		}
		width := int(bounds[i].high.i - bounds[i].low.i + 1)
		values[i] = Int(bounds[i].low.i + int64(index%width))
		index /= width
	}
	return values
}
func middle(b interval) Value {
	if b.low.typ == I64 {
		z := new(big.Int).Add(big.NewInt(b.low.i), big.NewInt(b.high.i))
		z.Quo(z, big.NewInt(2))
		return Int(z.Int64())
	}
	if b.low.typ == U64 {
		z := new(big.Int).Add(new(big.Int).SetUint64(b.low.u), new(big.Int).SetUint64(b.high.u))
		z.Quo(z, big.NewInt(2))
		return Uint(z.Uint64())
	}
	x := b.low.f/2 + b.high.f/2
	// Halving subnormals can underflow; never sample outside the declared interval.
	if x < b.low.f {
		return b.low
	}
	if x > b.high.f {
		return b.high
	}
	return Value{typ: b.low.typ, f: x}
}
func within(v Value, b interval) bool {
	lo, _ := Apply("le", b.low, v)
	hi, _ := Apply("le", v, b.high)
	return lo.b && hi.b
}
func sampledCase(bounds []interval, index int, rng *rand.Rand) []Value {
	values := make([]Value, len(bounds))
	for i, b := range bounds {
		values[i] = middle(b)
	}
	if index == 0 {
		return values
	}
	if index == 1 || index == 2 {
		for i, b := range bounds {
			values[i] = b.low
			if index == 2 {
				values[i] = b.high
			}
		}
		return values
	}
	if n := index - 3; n < len(bounds)*5 {
		axis, which := n/5, n%5
		b := bounds[axis]
		v := b.low
		switch which {
		case 1:
			v = b.high
		case 2, 3, 4:
			k := int64(which - 3)
			v = Int(k)
			if b.low.typ == U64 {
				if k >= 0 {
					v = Uint(uint64(k))
				}
			} else if b.low.typ != I64 {
				v = Value{typ: b.low.typ, f: float64(k)}
			}
		}
		if within(v, b) {
			values[axis] = v
		}
		return values
	}
	for i, b := range bounds {
		if b.low.typ == I64 {
			width := uint64(b.high.i) - uint64(b.low.i) + 1
			offset := rng.Uint64()
			if width != 0 {
				offset %= width
			}
			values[i] = Int(int64(uint64(b.low.i) + offset))
		} else if b.low.typ == U64 {
			width := b.high.u - b.low.u + 1
			offset := rng.Uint64()
			if width != 0 {
				offset %= width
			}
			values[i] = Uint(b.low.u + offset)
		} else {
			t := rng.Float64()
			x := float64(b.low.f*(1-t)) + float64(b.high.f*t)
			if math.IsInf(x, 0) || math.IsNaN(x) {
				values[i] = middle(b)
			} else if x < b.low.f {
				values[i] = b.low
			} else if x > b.high.f {
				values[i] = b.high
			} else {
				values[i] = Value{typ: b.low.typ, f: x}
			}
		}
	}
	return values
}
