package synthesis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

const (
	MaxContractPoints      = 64
	MaxContractRounds      = 32
	MaxContractEvaluations = 10_000_000
	MaxContractPool        = 8192
)

var ErrContractIncomplete = errors.New("contract synthesis did not establish acceptance")

// Decimal strings preserve i64 values without any float64 intermediate.
// Examples are optional. Without examples, only the contract constrains search.
type ContractExample struct {
	X string `json:"x"`
	Y string `json:"y"`
}
type ContractSpec struct {
	Version        int               `json:"version"`
	Examples       []ContractExample `json:"examples,omitempty"`
	Constants      []string          `json:"constants,omitempty"`
	MaxNodes       int               `json:"max_nodes,omitempty"`
	MaxCandidates  int               `json:"max_candidates,omitempty"`
	MaxEvaluations int               `json:"max_evaluations,omitempty"`
}
type ContractOptions struct {
	Verify       coreir.VerifyOptions `json:"verify"`
	MaxRounds    int                  `json:"max_rounds"`
	TotalCases   int                  `json:"total_cases"`
	AllowSampled bool                 `json:"allow_sampled"`
	SourceName   string               `json:"source_name"`
}

func DefaultContractOptions() ContractOptions {
	return ContractOptions{Verify: coreir.DefaultVerifyOptions(), MaxRounds: 16, TotalCases: coreir.MaxCases, SourceName: "synthesized.swyp"}
}

type ContractRound struct {
	Round        int                 `json:"round"`
	Expression   string              `json:"expression"`
	Candidates   int                 `json:"cumulative_candidates"`
	TrainingRuns int                 `json:"training_runs"`
	Verification coreir.Verification `json:"verification"`
}
type ContractResult struct {
	Result
	Version        int             `json:"version"`
	Mode           string          `json:"mode"`
	Status         string          `json:"status"`
	Reason         string          `json:"reason,omitempty"`
	Entry          string          `json:"entry"`
	Type           coreir.Type     `json:"type"`
	Rounds         int             `json:"rounds"`
	AddedInputs    int             `json:"added_inputs"`
	Evaluations    int             `json:"evaluations"`
	CasesConsumed  int             `json:"cases_consumed"`
	StepsConsumed  int             `json:"steps_consumed"`
	MaxCandidates  int             `json:"max_candidates"`
	MaxEvaluations int             `json:"max_evaluations"`
	MaxNodes       int             `json:"max_nodes"`
	Options        ContractOptions `json:"options"`
	SourceSHA256   string          `json:"source_sha256,omitempty"`
	ContractSHA256 string          `json:"contract_sha256,omitempty"`
	SpecSHA256     string          `json:"spec_sha256,omitempty"`
	History        []ContractRound `json:"history,omitempty"`
}

func DecodeContractSpec(data []byte) (ContractSpec, error) {
	var s ContractSpec
	if len(data) == 0 || len(data) > 65536 {
		return s, fmt.Errorf("%w: contract synthesis spec must be 1..65536 bytes", ErrInvalidSpec)
	}
	if err := coreir.DecodeStrict(data, &s); err != nil {
		return s, err
	}
	return s, nil
}
func contractHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func contractSource(c coreir.Contract, expression string) string {
	d := c.Inputs[0]
	return fmt.Sprintf("fn %s(%s: %s) -> %s {\n    return %s;\n}\nfn main() {}\n", c.Entry, d.Name, d.Type, d.Type, expression)
}
func contractProgram(name, source, entry string) (coreir.Module, *coreir.Executable, error) {
	p, err := swyplang.ParseCore(name, source)
	if err != nil {
		return coreir.Module{}, nil, err
	}
	m, err := p.CoreIR(entry)
	if err != nil {
		return m, nil, err
	}
	e, err := coreir.Prepare(m)
	return m, e, err
}
func contractName(name string) bool {
	if len(name) < 1 || len(name) > 128 {
		return false
	}
	for i, b := range []byte(name) {
		if b != '_' && !(b >= 'a' && b <= 'z') && !(b >= 'A' && b <= 'Z') && !(i > 0 && b >= '0' && b <= '9') {
			return false
		}
	}
	return true
}
func contractEqual(a, b coreir.Value) bool {
	v, err := coreir.Apply("eq", a, b)
	ok, _ := v.Boolean()
	return err == nil && ok
}

// SynthesizeContract performs bounded counterexample-guided refinement, not SMT
// solving. Each witness adds an INPUT constraint, not an invented target output.
// Candidate, evaluation, case, instruction, round and context budgets are shared
// across restarts. Source is returned only for accepted verification evidence.
func SynthesizeContract(ctx context.Context, c coreir.Contract, spec ContractSpec, options ContractOptions) (ContractResult, error) {
	r := ContractResult{Version: 1, Mode: "contract-cegis", Status: "unknown", Entry: c.Entry, Options: options}
	fail := func(reason string, err error) (ContractResult, error) {
		r.Reason = reason
		if errors.Is(err, context.DeadlineExceeded) {
			r.Status, r.Reason = "timeout", "deadline_exceeded"
		}
		if errors.Is(err, context.Canceled) {
			r.Reason = "cancelled"
		}
		return r, err
	}
	invalid := func(message string) (ContractResult, error) {
		return fail("invalid_input", fmt.Errorf("%w: %s", ErrInvalidSpec, message))
	}
	v := options.Verify
	if ctx == nil || v.MaxCases < 1 || v.MaxCases > coreir.MaxCases || v.TotalFuel < 1 || v.TotalFuel > coreir.MaxTotalFuel || v.FuelPerCase < 1 || v.FuelPerCase > coreir.MaxFuel || options.MaxRounds < 1 || options.MaxRounds > MaxContractRounds || options.TotalCases < 1 || options.TotalCases > coreir.MaxCases || len(options.SourceName) == 0 || len(options.SourceName) > 1024 {
		return invalid("invalid host budgets, context or source name")
	}
	if err := ctx.Err(); err != nil {
		return fail("cancelled", err)
	}
	if len(c.Inputs) != 1 || (c.Inputs[0].Type != coreir.I64 && c.Inputs[0].Type != coreir.F64) || !contractName(c.Entry) || c.Entry == "main" || !contractName(c.Inputs[0].Name) {
		return invalid("contract synthesis supports one i64/f64 input, a same-type result, and safe non-main source entry names")
	}
	r.Type = c.Inputs[0].Type
	_, prototype, err := contractProgram(options.SourceName, contractSource(c, c.Inputs[0].Name), c.Entry)
	if err != nil {
		return fail("invalid_contract", err)
	}
	constraints, err := coreir.PrepareConstraints(prototype, c)
	if err != nil {
		return fail("invalid_contract", err)
	}
	// Freeze contract and spec data; generated candidates cannot modify their evaluator.
	contractBytes, err := json.Marshal(c)
	if err != nil {
		return fail("invalid_contract", err)
	}
	c, err = coreir.DecodeContract(contractBytes)
	if err != nil {
		return fail("invalid_contract", err)
	}
	r.ContractSHA256 = contractHash(contractBytes)
	specBytes, err := json.Marshal(spec)
	if err != nil {
		return fail("invalid_spec", err)
	}
	r.SpecSHA256 = contractHash(specBytes)
	if spec.Version != 1 || len(spec.Examples) > MaxContractPoints || len(spec.Constants) > 16 {
		return invalid("spec version must be 1, with at most 64 examples and 16 constants")
	}
	if spec.MaxNodes == 0 {
		spec.MaxNodes = 7
	}
	if spec.MaxCandidates == 0 {
		spec.MaxCandidates = 20000
	}
	if spec.MaxEvaluations == 0 {
		spec.MaxEvaluations = 1_000_000
	}
	if spec.MaxNodes < 1 || spec.MaxNodes > 9 || spec.MaxCandidates < 1 || spec.MaxCandidates > 100000 || spec.MaxEvaluations < 1 || spec.MaxEvaluations > MaxContractEvaluations {
		return invalid("invalid search budgets")
	}
	r.MaxNodes, r.MaxCandidates, r.MaxEvaluations = spec.MaxNodes, spec.MaxCandidates, spec.MaxEvaluations
	constants := append([]string(nil), spec.Constants...)
	if len(constants) == 0 {
		constants = []string{"-1", "0", "1", "2"}
	}
	values := make([]coreir.Value, len(constants))
	for i, text := range constants {
		values[i], err = coreir.ParseValue(r.Type, text)
		if err != nil {
			return fail("invalid_constant", fmt.Errorf("%w: %v", ErrInvalidSpec, err))
		}
	}
	points := make([]contractPoint, 0, MaxContractPoints)
	for i, ex := range spec.Examples {
		x, err := coreir.ParseValue(r.Type, ex.X)
		if err != nil {
			return fail("invalid_example", fmt.Errorf("%w: example %d x: %v", ErrInvalidSpec, i, err))
		}
		y, err := coreir.ParseValue(r.Type, ex.Y)
		if err != nil {
			return fail("invalid_example", fmt.Errorf("%w: example %d y: %v", ErrInvalidSpec, i, err))
		}
		ok, err := constraints.Check([]coreir.Value{x}, y)
		if err != nil || !ok {
			return invalid(fmt.Sprintf("example %d is not admissible or contradicts the contract: %v", i, err))
		}
		duplicate := false
		for _, prior := range points {
			if contractEqual(prior.input, x) && !contractEqual(*prior.expected, y) {
				return invalid("contradictory example outputs")
			}
			if prior.input.Literal() == x.Literal() {
				duplicate = true
			}
		}
		if !duplicate {
			copy := y
			points = append(points, contractPoint{input: x, expected: &copy})
		}
	}
	for r.Rounds < options.MaxRounds {
		if err := ctx.Err(); err != nil {
			return fail("cancelled", err)
		}
		if r.Candidates >= spec.MaxCandidates {
			return fail("candidate_budget", ErrExhausted)
		}
		if r.CasesConsumed >= options.TotalCases {
			return fail("total_cases_exhausted", ErrContractIncomplete)
		}
		if r.StepsConsumed >= v.TotalFuel {
			return fail("total_fuel_exhausted", ErrContractIncomplete)
		}
		r.Rounds++
		search := contractSearch{ctx: ctx, spec: spec, points: points, constants: values, constraints: constraints, report: &r, variable: c.Inputs[0].Name}
		candidate, err := search.run()
		if err != nil {
			return fail("search_exhausted", err)
		}
		source := contractSource(c, candidate.text)
		m, e, err := contractProgram(options.SourceName, source, c.Entry)
		if err != nil {
			return fail("generated_source_rejected", err)
		}
		history := ContractRound{Round: r.Rounds, Expression: candidate.text, Candidates: r.Candidates}
		// Verify emitted source on all accumulated points, not just cached search vectors.
		for i, point := range points {
			fuel := minContract(v.FuelPerCase, c.MaxSteps, v.TotalFuel-r.StepsConsumed)
			if fuel < 1 || r.CasesConsumed >= options.TotalCases {
				return fail("training_budget_exhausted", ErrContractIncomplete)
			}
			out, err := e.Run(ctx, c.Entry, []coreir.Value{point.input}, fuel)
			r.CasesConsumed++
			history.TrainingRuns++
			r.StepsConsumed += out.Steps
			if err != nil {
				return fail("training_execution", err)
			}
			// Literal equality also checks signed zero; numeric examples use language equality.
			if out.Value.Literal() != candidate.outputs[i].Literal() {
				return fail("search_runtime_mismatch", ErrContractIncomplete)
			}
			ok, err := constraints.Check([]coreir.Value{point.input}, out.Value)
			if err != nil || !ok {
				return fail("search_contract_mismatch", ErrContractIncomplete)
			}
		}
		remainingCases := options.TotalCases - r.CasesConsumed
		verifyOptions := v
		verifyOptions.TotalFuel = v.TotalFuel - r.StepsConsumed
		verifyOptions.MaxCases = minContract(v.MaxCases, remainingCases)
		if verifyOptions.TotalFuel < 1 || verifyOptions.MaxCases < 1 {
			return fail("verification_budget_exhausted", ErrContractIncomplete)
		}
		verification, err := coreir.Verify(ctx, e, c, verifyOptions)
		r.CasesConsumed += verification.CasesExamined
		r.StepsConsumed += verification.StepsConsumed
		irBytes, marshalErr := json.Marshal(m)
		if marshalErr != nil {
			return fail("invalid_ir", marshalErr)
		}
		verification.SourceSHA256 = contractHash([]byte(source))
		verification.IRSHA256 = contractHash(irBytes)
		verification.ContractSHA256 = r.ContractSHA256
		history.Verification = verification
		r.History = append(r.History, history)
		if err != nil {
			return fail("verification_error", err)
		}
		if err := ctx.Err(); err != nil {
			return fail("cancelled", err)
		}
		switch verification.Status {
		case "exhaustive", "tested":
			if verification.Status == "tested" && verifyOptions.MaxCases < v.MaxCases {
				return fail("total_cases_exhausted", ErrContractIncomplete)
			}
			if verification.Status == "tested" && !options.AllowSampled {
				return fail("exhaustive_required", ErrContractIncomplete)
			}
			r.Status = verification.Status
			r.Expression, r.Source, r.SourceSHA256 = candidate.text, source, verification.SourceSHA256
			return r, nil
		case "counterexample":
			w := verification.Witness
			if w == nil || len(w.Inputs) != 1 {
				return fail("invalid_witness", ErrContractIncomplete)
			}
			x := w.Inputs[0].Value
			ok, err := constraints.Admissible([]coreir.Value{x})
			if err != nil || !ok {
				return fail("invalid_witness", ErrContractIncomplete)
			}
			for _, point := range points {
				if point.input.Literal() == x.Literal() {
					return fail("repeated_counterexample", ErrContractIncomplete)
				}
			}
			if len(points) >= MaxContractPoints {
				return fail("point_limit", ErrExhausted)
			}
			points = append(points, contractPoint{input: x})
			r.AddedInputs++
		default:
			if verification.Status == "timeout" {
				r.Status = "timeout"
			}
			return fail(verification.Reason, ErrContractIncomplete)
		}
	}
	return fail("round_limit", ErrExhausted)
}

func minContract(values ...int) int {
	x := values[0]
	for _, v := range values[1:] {
		if v < x {
			x = v
		}
	}
	return x
}
