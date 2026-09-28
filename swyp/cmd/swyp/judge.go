package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

const (
	judgeMaxRequest = 64 * 1024
	judgeMaxSource  = 32 * 1024
)

var judgeHasMain = regexp.MustCompile(`\bfn\s+main\s*\(`)

type judgeRequest struct {
	Version  int             `json:"version"`
	Source   string          `json:"source"`
	Contract json.RawMessage `json:"contract"`
}

type judgeResponse struct {
	coreir.Verification
	Summary string `json:"summary"`
}

type judgeError struct {
	Version    int                `json:"version"`
	Status     string             `json:"status"`
	Diagnostic *coreir.Diagnostic `json:"diagnostic"`
	Hint       string             `json:"hint,omitempty"`
	Summary    string             `json:"summary"`
}

// judge is the model-facing verifier: one bounded stdin request with a
// candidate Semantic Core source and a contract, one JSON verdict with a
// one-line summary meant to be fed back to a generator. It never writes
// files, calls a model or runs anything but the fuel-bounded core executor.
func judge(ctx context.Context, input io.Reader, output io.Writer) (err error) {
	emitted := false
	source := ""
	defer func() {
		if err == nil || emitted {
			return
		}
		var d *coreir.Diagnostic
		if !errors.As(err, &d) {
			d = &coreir.Diagnostic{Code: "invalid_input", Message: err.Error()}
		}
		summary, hint := "ERROR "+d.Message, judgeHint(source, d.Message)
		if hint != "" {
			summary += " -- hint: " + hint
		}
		writeErr := json.NewEncoder(output).Encode(judgeError{1, "error", d, hint, summary})
		if writeErr != nil {
			err = errors.Join(err, writeErr)
		}
	}()
	data, err := io.ReadAll(io.LimitReader(input, judgeMaxRequest+1))
	if err != nil {
		return err
	}
	if len(data) > judgeMaxRequest {
		return fmt.Errorf("judge request exceeds %d bytes", judgeMaxRequest)
	}
	var req judgeRequest
	if err := coreir.DecodeStrict(data, &req); err != nil {
		return err
	}
	if req.Version != 1 {
		return fmt.Errorf("judge request version must be 1")
	}
	if strings.TrimSpace(req.Source) == "" || len(req.Source) > judgeMaxSource {
		return fmt.Errorf("source must be non-empty and at most %d bytes", judgeMaxSource)
	}
	contract, err := coreir.DecodeContract(req.Contract)
	if err != nil {
		return err
	}
	source = req.Source
	if !judgeHasMain.MatchString(source) {
		source = strings.TrimRight(source, "\n") + "\nfn main() {}\n"
	}
	p, err := swyplang.ParseCore("candidate.swyp", source)
	if err != nil {
		return err
	}
	m, err := p.CoreIR(contract.Entry)
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(m)
	if err != nil {
		return err
	}
	e, err := coreir.Prepare(m)
	if err != nil {
		return err
	}
	report, err := coreir.Verify(ctx, e, contract, coreir.DefaultVerifyOptions())
	if err != nil {
		return err
	}
	report.SourceSHA256 = coreHash([]byte(source))
	report.IRSHA256 = coreHash(canonical)
	report.ContractSHA256 = coreHash(req.Contract)
	emitted = true
	if err := json.NewEncoder(output).Encode(judgeResponse{report, judgeSummary(report, contract)}); err != nil {
		return err
	}
	if report.Status != "tested" && report.Status != "exhaustive" {
		return fmt.Errorf("verification %s: %s", report.Status, report.Reason)
	}
	return nil
}

func judgeSummary(v coreir.Verification, c coreir.Contract) string {
	switch v.Status {
	case "exhaustive":
		return fmt.Sprintf("PASS exhaustive: %s satisfies the contract on all %d inputs of its domain", v.Entry, v.CasesChecked)
	case "tested":
		return fmt.Sprintf("PASS tested: %s satisfied the contract on %d sampled inputs (not exhaustive)", v.Entry, v.CasesChecked)
	case "counterexample":
		if v.Witness == nil {
			return "FAIL counterexample: " + v.Reason
		}
		args := make([]string, len(v.Witness.Inputs))
		for i, in := range v.Witness.Inputs {
			args[i] = in.Name + "=" + in.Value.Literal().Value
		}
		call := v.Entry + "(" + strings.Join(args, ", ") + ")"
		if v.Witness.Diagnostic != nil {
			return fmt.Sprintf("FAIL counterexample: %s failed: %s", call, v.Witness.Diagnostic.Message)
		}
		if v.Witness.Result != nil {
			i := v.Witness.Postcondition
			if i >= 0 && i < len(c.Ensures) {
				return fmt.Sprintf("FAIL counterexample: %s returned %s, but the contract requires %s (ensures[%d])", call, v.Witness.Result.Literal().Value, judgePredicate(c.Ensures[i], 0), i)
			}
			return fmt.Sprintf("FAIL counterexample: %s returned %s, violating ensures[%d]", call, v.Witness.Result.Literal().Value, i)
		}
		return fmt.Sprintf("FAIL counterexample: %s (%s)", call, v.Reason)
	default:
		return fmt.Sprintf("UNKNOWN %s: %s", v.Status, v.Reason)
	}
}

var judgeInfix = map[string]struct {
	symbol string
	prec   int
}{
	"or": {"||", 1}, "and": {"&&", 2},
	"eq": {"==", 3}, "ne": {"!=", 3},
	"lt": {"<", 4}, "le": {"<=", 4}, "gt": {">", 4}, "ge": {">=", 4},
	"add": {"+", 5}, "sub": {"-", 5},
	"mul": {"*", 6}, "div": {"/", 6}, "rem": {"%", 6},
}

// judgePredicate renders a contract predicate in Swyp's own infix syntax, so
// a model reads the rule it broke ("result >= 0") instead of an index.
func judgePredicate(p coreir.Predicate, parent int) string {
	switch {
	case p.Variable != "":
		return p.Variable
	case p.Constant != nil:
		return p.Constant.Value
	}
	if len(p.Args) == 1 && (p.Op == "neg" || p.Op == "not") {
		symbol := "-"
		if p.Op == "not" {
			symbol = "!"
		}
		return symbol + judgePredicate(p.Args[0], 7)
	}
	op, ok := judgeInfix[p.Op]
	if !ok || len(p.Args) != 2 {
		args := make([]string, len(p.Args))
		for i, a := range p.Args {
			args[i] = judgePredicate(a, 0)
		}
		return p.Op + "(" + strings.Join(args, ", ") + ")"
	}
	text := judgePredicate(p.Args[0], op.prec) + " " + op.symbol + " " + judgePredicate(p.Args[1], op.prec+1)
	if op.prec < parent {
		return "(" + text + ")"
	}
	return text
}
