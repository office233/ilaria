package synthesis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"swyp-lang/internal/coreir"
)

func synthContractFixture(typ coreir.Type, min, max string) coreir.Contract {
	return coreir.Contract{Version: 1, Entry: "predict", Inputs: []coreir.Domain{{Name: "x", Type: typ, Min: min, Max: max}}, MaxSteps: 100,
		Ensures: []coreir.Predicate{{Op: "eq", Args: []coreir.Predicate{{Variable: "result"}, {Op: "mul", Args: []coreir.Predicate{{Variable: "x"}, {Variable: "x"}}}}}}}
}
func synthIdentity(c *coreir.Contract) { c.Ensures[0].Args[1] = coreir.Predicate{Variable: "x"} }
func contractTestRun(t *testing.T, r ContractResult, input string) coreir.Value {
	t.Helper()
	_, e, err := contractProgram(r.Options.SourceName, r.Source, r.Entry)
	if err != nil {
		t.Fatal(err)
	}
	x, err := coreir.ParseValue(r.Type, input)
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.Run(context.Background(), r.Entry, []coreir.Value{x}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return out.Value
}
func assertContractFailure(t *testing.T, r ContractResult, err error) {
	t.Helper()
	if err == nil || r.Source != "" || r.Status == "exhaustive" || r.Status == "tested" {
		t.Fatalf("failure published success: %+v / %v", r, err)
	}
	if r.Candidates > r.MaxCandidates || r.Evaluations > r.MaxEvaluations || r.Rounds > r.Options.MaxRounds || r.CasesConsumed > r.Options.TotalCases || r.StepsConsumed > r.Options.Verify.TotalFuel {
		t.Fatalf("budget exceeded: %+v", r)
	}
}

func TestContractSynthesisCounterexampleTrace(t *testing.T) {
	c := synthContractFixture(coreir.I64, "-100", "100")
	s := ContractSpec{Version: 1, Examples: []ContractExample{{X: "0", Y: "0"}, {X: "1", Y: "1"}}}
	r, err := SynthesizeContract(context.Background(), c, s, DefaultContractOptions())
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != "exhaustive" || r.Expression != "(x * x)" || r.Rounds != 2 || r.AddedInputs != 1 || len(r.History) != 2 {
		t.Fatalf("bad refinement: %+v", r)
	}
	first, final := r.History[0], r.History[1]
	if first.Expression != "x" || first.Verification.Status != "counterexample" || first.Verification.Witness.Inputs[0].Value.Literal().Value != "-100" {
		t.Fatalf("missing real counterexample: %+v", first)
	}
	if final.Verification.CasesChecked != 201 || !final.Verification.Exhaustive || r.SourceSHA256 != contractHash([]byte(r.Source)) {
		t.Fatalf("bad final evidence: %+v", r)
	}
	if r.Candidates != 57 || r.Evaluations != 249 || r.CasesConsumed != 207 || r.StepsConsumed != 618 {
		t.Fatalf("unexpected accounting: %+v", r)
	}
}

func TestContractSynthesisI64BoundariesAndTrapPreservation(t *testing.T) {
	for _, value := range []string{"-9223372036854775808", "9223372036854775807", "9007199254740993"} {
		c := synthContractFixture(coreir.I64, value, value)
		synthIdentity(&c)
		r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, DefaultContractOptions())
		if err != nil {
			t.Fatal(err)
		}
		if got := contractTestRun(t, r, value).Literal().Value; got != value {
			t.Fatalf("rounded %s to %s", value, got)
		}
	}
	c := synthContractFixture(coreir.I64, "9223372036854775807", "9223372036854775807")
	c.Ensures[0].Args[1] = coreir.Predicate{Constant: &coreir.Literal{Type: coreir.I64, Value: "-9223372036854775808"}}
	s := ContractSpec{Version: 1, Constants: []string{"1"}, MaxNodes: 3, Examples: []ContractExample{{X: "9223372036854775807", Y: "-9223372036854775808"}}}
	r, err := SynthesizeContract(context.Background(), c, s, DefaultContractOptions())
	assertContractFailure(t, r, err)
	if !errors.Is(err, ErrExhausted) {
		t.Fatalf("expected bounded grammar exhaustion, not integer wrapping: %v", err)
	}
	// Negative minimum-i64 constants must survive source emission as exact literals.
	s.Constants = []string{"-9223372036854775808"}
	r, err = SynthesizeContract(context.Background(), c, s, DefaultContractOptions())
	if err != nil {
		t.Fatal(err)
	}
	if got := contractTestRun(t, r, "9223372036854775807").Literal().Value; got != "-9223372036854775808" {
		t.Fatal(got)
	}
}

func TestContractSynthesisSamplePolicyAndSignedZero(t *testing.T) {
	c := synthContractFixture(coreir.F64, "-2", "2")
	synthIdentity(&c)
	opts := DefaultContractOptions()
	r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, opts)
	assertContractFailure(t, r, err)
	if r.Reason != "exhaustive_required" {
		t.Fatalf("%+v", r)
	}
	opts.AllowSampled = true
	r, err = SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, opts)
	if err != nil || r.Status != "tested" {
		t.Fatalf("%+v %v", r, err)
	}
	if got := contractTestRun(t, r, "-0").Literal().Value; got != "-0" {
		t.Fatalf("lost signed zero: %s", got)
	}
	negativeZero, _ := coreir.ParseValue(coreir.F64, "-0")
	positiveZero, _ := coreir.ParseValue(coreir.F64, "0")
	if contractVectorKey([]coreir.Value{negativeZero}) == contractVectorKey([]coreir.Value{positiveZero}) {
		t.Fatal("dedup conflates signed zero")
	}
	c = synthContractFixture(coreir.F64, "-2", "2")
	r, err = SynthesizeContract(context.Background(), c, ContractSpec{Version: 1, Examples: []ContractExample{{"0", "0"}, {"1", "1"}}}, opts)
	if err != nil || r.Status != "tested" {
		t.Fatalf("f64 square: %+v %v", r, err)
	}
	if got := contractTestRun(t, r, "1.5").Literal().Value; got != "2.25" {
		t.Fatal(got)
	}
}

func TestContractSynthesisSharedBudgets(t *testing.T) {
	for _, name := range []string{"candidates", "evaluations", "rounds", "fuel", "per-case", "cases", "grammar"} {
		t.Run(name, func(t *testing.T) {
			c := synthContractFixture(coreir.I64, "-100", "100")
			s := ContractSpec{Version: 1, Examples: []ContractExample{{"0", "0"}, {"1", "1"}}}
			o := DefaultContractOptions()
			switch name {
			case "candidates":
				s.MaxCandidates = 2
			case "evaluations":
				s.MaxEvaluations = 2
			case "rounds":
				o.MaxRounds = 1
			case "fuel":
				o.Verify.TotalFuel = 7
			case "per-case":
				o.Verify.FuelPerCase = 1
			case "cases":
				o.TotalCases = 4
			case "grammar":
				s.MaxNodes = 1
			}
			r, err := SynthesizeContract(context.Background(), c, s, o)
			assertContractFailure(t, r, err)
		})
	}
	c := synthContractFixture(coreir.I64, "-1000", "1000")
	synthIdentity(&c)
	o := DefaultContractOptions()
	o.AllowSampled = true
	o.TotalCases = 1
	r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, o)
	assertContractFailure(t, r, err)
	if r.Reason != "total_cases_exhausted" {
		t.Fatalf("silently reduced requested evidence: %+v", r)
	}
	c.Inputs[0].Min, c.Inputs[0].Max = "0", "0"
	r, err = SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, o)
	if err != nil || r.Status != "exhaustive" {
		t.Fatalf("exactly sufficient finite budget: %+v %v", r, err)
	}
}

func TestContractSynthesisInvalidInputs(t *testing.T) {
	for _, name := range []string{"version", "nodes", "candidates", "evaluations", "constants", "missing-example", "contradiction", "out-of-domain", "entry-injection", "parameter-injection", "main", "result-name", "arity", "bad-predicate", "host-budget"} {
		t.Run(name, func(t *testing.T) {
			c := synthContractFixture(coreir.I64, "-10", "10")
			s := ContractSpec{Version: 1}
			o := DefaultContractOptions()
			switch name {
			case "version":
				s.Version = 0
			case "nodes":
				s.MaxNodes = 10
			case "candidates":
				s.MaxCandidates = -1
			case "evaluations":
				s.MaxEvaluations = MaxContractEvaluations + 1
			case "constants":
				s.Constants = []string{"9223372036854775808"}
			case "missing-example":
				s.Examples = []ContractExample{{X: "0"}}
			case "contradiction":
				s.Examples = []ContractExample{{"2", "3"}}
			case "out-of-domain":
				s.Examples = []ContractExample{{"11", "121"}}
			case "entry-injection":
				c.Entry = "p() {} fn injected"
			case "parameter-injection":
				c.Inputs[0].Name = "x) {}"
			case "main":
				c.Entry = "main"
			case "result-name":
				c.Inputs[0].Name = "result"
			case "arity":
				c.Inputs = nil
			case "bad-predicate":
				c.Ensures[0].Op = "exec"
			case "host-budget":
				o.MaxRounds = 0
			}
			r, err := SynthesizeContract(context.Background(), c, s, o)
			assertContractFailure(t, r, err)
			if r.Candidates != 0 {
				t.Fatalf("searched before validating input: %+v", r)
			}
		})
	}
}

func TestContractSynthesisNoVacuityAndPredicateErrors(t *testing.T) {
	for _, name := range []string{"empty-admissible", "predicate-overflow", "predicate-zero-divisor"} {
		t.Run(name, func(t *testing.T) {
			c := synthContractFixture(coreir.I64, "-2", "2")
			switch name {
			case "empty-admissible":
				c.Requires = []coreir.Predicate{{Constant: &coreir.Literal{Type: coreir.Bool, Value: "false"}}}
			case "predicate-overflow":
				c.Inputs[0].Min, c.Inputs[0].Max = "9223372036854775807", "9223372036854775807"
			case "predicate-zero-divisor":
				c.Ensures[0].Args[1] = coreir.Predicate{Op: "div", Args: []coreir.Predicate{{Variable: "x"}, {Constant: &coreir.Literal{Type: coreir.I64, Value: "0"}}}}
			}
			r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, DefaultContractOptions())
			assertContractFailure(t, r, err)
			if name == "empty-admissible" && r.Reason != "no_admissible_inputs" {
				t.Fatalf("%+v", r)
			}
		})
	}
	c := synthContractFixture(coreir.I64, "-3", "3")
	synthIdentity(&c)
	c.Requires = []coreir.Predicate{{Op: "ge", Args: []coreir.Predicate{{Variable: "x"}, {Constant: &coreir.Literal{Type: coreir.I64, Value: "0"}}}}}
	r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, DefaultContractOptions())
	if err != nil || r.Status != "exhaustive" || r.History[0].Verification.CasesSkipped != 3 {
		t.Fatalf("preconditions: %+v %v", r, err)
	}
}

func TestContractSynthesisCancellationDeterminismAndConcurrency(t *testing.T) {
	c := synthContractFixture(coreir.I64, "-5", "5")
	s := ContractSpec{Version: 1}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	for _, ctx := range []context.Context{nil, cancelled, expired} {
		r, err := SynthesizeContract(ctx, c, s, DefaultContractOptions())
		assertContractFailure(t, r, err)
		if r.Candidates != 0 {
			t.Fatal("cancelled context searched")
		}
	}
	beforeC, _ := json.Marshal(c)
	beforeS, _ := json.Marshal(s)
	first, err := SynthesizeContract(context.Background(), c, s, DefaultContractOptions())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := SynthesizeContract(context.Background(), c, s, DefaultContractOptions())
			if err != nil || !reflect.DeepEqual(first, r) {
				t.Errorf("nondeterministic result: %+v %v", r, err)
			}
		}()
	}
	wg.Wait()
	afterC, _ := json.Marshal(c)
	afterS, _ := json.Marshal(s)
	if string(beforeC) != string(afterC) || string(beforeS) != string(afterS) {
		t.Fatal("mutated caller inputs")
	}
}

func TestContractSynthesisAffineOracleCorpus(t *testing.T) {
	for a := int64(-3); a <= 3; a++ {
		for b := int64(-3); b <= 3; b++ {
			t.Run(fmt.Sprintf("%d_%d", a, b), func(t *testing.T) {
				c := synthContractFixture(coreir.I64, "-7", "7")
				c.Ensures[0].Args[1] = coreir.Predicate{Op: "add", Args: []coreir.Predicate{{Op: "mul", Args: []coreir.Predicate{{Variable: "x"}, {Constant: &coreir.Literal{Type: coreir.I64, Value: strconv.FormatInt(a, 10)}}}}, {Constant: &coreir.Literal{Type: coreir.I64, Value: strconv.FormatInt(b, 10)}}}}
				s := ContractSpec{Version: 1, Constants: []string{"-3", "-2", "-1", "0", "1", "2", "3"}, MaxNodes: 5}
				r, err := SynthesizeContract(context.Background(), c, s, DefaultContractOptions())
				if err != nil || r.Status != "exhaustive" {
					t.Fatalf("%+v %v", r, err)
				}
				_, e, err := contractProgram(r.Options.SourceName, r.Source, r.Entry)
				if err != nil {
					t.Fatal(err)
				}
				for x := int64(-30); x <= 30; x++ {
					out, err := e.Run(context.Background(), r.Entry, []coreir.Value{coreir.Int(x)}, 100)
					got, exact := out.Value.Int64()
					if err != nil || !exact || got != a*x+b {
						t.Fatalf("independent oracle %d*%d+%d: %v %v", a, x, b, out, err)
					}
				}
			})
		}
	}
}

func TestContractSynthesisRelationalOutputs(t *testing.T) {
	c := synthContractFixture(coreir.I64, "-20", "20")
	c.Ensures = []coreir.Predicate{
		{Op: "gt", Args: []coreir.Predicate{{Variable: "result"}, {Variable: "x"}}},
		{Op: "le", Args: []coreir.Predicate{{Variable: "result"}, {Op: "add", Args: []coreir.Predicate{{Variable: "x"}, {Constant: &coreir.Literal{Type: coreir.I64, Value: "2"}}}}}},
	}
	r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1}, DefaultContractOptions())
	if err != nil || r.Status != "exhaustive" || r.AddedInputs == 0 {
		t.Fatalf("relational synthesis: %+v %v", r, err)
	}
	for x := int64(-20); x <= 20; x++ {
		y, exact := contractTestRun(t, r, strconv.FormatInt(x, 10)).Int64()
		if !exact || y <= x || y > x+2 {
			t.Fatalf("invalid relational result at %d: %d", x, y)
		}
	}
}

func TestContractSynthesisF64ConstantSourceRoundTrip(t *testing.T) {
	for _, literal := range []string{"5e-324", "1.7976931348623157e+308", "-1.7976931348623157e+308"} {
		c := synthContractFixture(coreir.F64, "0", "0")
		c.Ensures[0].Args[1] = coreir.Predicate{Constant: &coreir.Literal{Type: coreir.F64, Value: literal}}
		o := DefaultContractOptions()
		o.AllowSampled = true
		r, err := SynthesizeContract(context.Background(), c, ContractSpec{Version: 1, Constants: []string{literal}}, o)
		if err != nil || r.Status != "tested" {
			t.Fatalf("%s: %+v %v", literal, r, err)
		}
		want, err := coreir.ParseValue(coreir.F64, literal)
		if err != nil {
			t.Fatal(err)
		}
		if got := contractTestRun(t, r, "0"); got.Literal() != want.Literal() {
			t.Fatalf("constant changed from %v to %v", want, got)
		}
	}
}

func TestContractSpecStrictDecoding(t *testing.T) {
	for _, input := range []string{``, `null`, `{"version":1,"Version":1}`, `{"version":1,"constants":[null]}`, `{"version":1,"examples":[{"x":0,"y":1}]}`, `{"version":1,"unknown":true}`, `{"version":1} {}`} {
		if _, err := DecodeContractSpec([]byte(input)); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
}

func FuzzContractSynthesis(f *testing.F) {
	for _, data := range []string{`{"version":1}`, `{"version":1,"examples":[{"x":"0","y":"0"},{"x":"1","y":"1"}]}`, `{"version":1,"constants":["9223372036854775807"]}`} {
		f.Add([]byte(data))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 65536 {
			return
		}
		s, err := DecodeContractSpec(data)
		if err != nil {
			return
		}
		s.MaxNodes, s.MaxCandidates, s.MaxEvaluations = 3, 64, 512
		o := DefaultContractOptions()
		o.MaxRounds = 3
		o.Verify.TotalFuel = 1000
		o.TotalCases = 100
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		c := synthContractFixture(coreir.I64, "-3", "3")
		r, err := SynthesizeContract(ctx, c, s, o)
		if err != nil {
			assertContractFailure(t, r, err)
			return
		}
		if r.Status != "exhaustive" {
			t.Fatalf("unexpected acceptance: %+v", r)
		}
		for x := int64(-3); x <= 3; x++ {
			got, _ := contractTestRun(t, r, strconv.FormatInt(x, 10)).Int64()
			if got != x*x {
				t.Fatalf("incorrect candidate at %d: %d", x, got)
			}
		}
	})
}
