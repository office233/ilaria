package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"swyp-lang/internal/swyplang"
	"swyp-lang/internal/synthesis"
)

var synthesizeFn = synthesis.Synthesize

// Pointers prevent missing or null example fields from silently becoming zero.
type numericPair struct {
	X *float64 `json:"x"`
	Y *float64 `json:"y"`
}
type synthInput struct {
	Examples      []numericPair `json:"examples"`
	Validation    []numericPair `json:"validation"`
	Constants     []*float64    `json:"constants"`
	MaxNodes      int           `json:"max_nodes"`
	MaxCandidates int           `json:"max_candidates"`
}

func pairs(values []numericPair) ([]synthesis.Example, error) {
	result := make([]synthesis.Example, len(values))
	for i, v := range values {
		if v.X == nil || v.Y == nil {
			return nil, fmt.Errorf("example %d requires numeric x and y", i)
		}
		result[i] = synthesis.Example{X: *v.X, Y: *v.Y}
	}
	return result, nil
}

func synthCommand(args []string) error {
	f := flag.NewFlagSet("synth", flag.ContinueOnError)
	contractMode := addContractSynthFlags(f)
	out := f.String("o", "", "destination .swyp file")
	timeout := f.Duration("timeout", 5*time.Second, "synthesis search timeout (default 5s, max 60s)")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *out == "" || len(f.Args()) != 1 {
		return fmt.Errorf("usage: swyp synth [-contract contract.json] -o new.swyp [-timeout duration] spec.json")
	}
	if *timeout <= 0 || *timeout > 60*time.Second {
		return fmt.Errorf("timeout must be greater than 0 and at most 60s")
	}
	if contractMode.path != "" {
		return synthContractCommand(*out, f.Arg(0), *timeout, *contractMode, os.Stdout)
	}
	var contractFlag string
	f.Visit(func(value *flag.Flag) {
		if value.Name != "o" && value.Name != "timeout" {
			contractFlag = value.Name
		}
	})
	if contractFlag != "" {
		return fmt.Errorf("-%s requires a non-empty -contract path", contractFlag)
	}

	if _, err := os.Lstat(*out); err == nil {
		return fmt.Errorf("output already exists: %s", *out)
	} else if !os.IsNotExist(err) {
		return err
	}

	specPath := f.Args()[0]
	specFile, err := os.Open(specPath)
	if err != nil {
		return err
	}
	specBytes, readErr := io.ReadAll(io.LimitReader(specFile, 64*1024+1))
	closeReadErr := specFile.Close()
	if readErr != nil {
		return readErr
	}
	if closeReadErr != nil {
		return closeReadErr
	}
	if len(specBytes) == 0 {
		return fmt.Errorf("spec file is empty")
	}
	if len(specBytes) > 64*1024 {
		return fmt.Errorf("spec file exceeds 64 KiB limit")
	}

	spec, validation, err := decodeSynthInput(specBytes)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	var res synthesis.Result
	var refinement synthesis.RefinementResult
	if len(validation) > 0 {
		refinement, err = synthesis.SynthesizeWithValidation(ctx, spec, validation)
		res = refinement.Result
	} else {
		res, err = synthesizeFn(ctx, spec)
	}
	if err != nil {
		return err
	}

	source := res.Source
	if !strings.HasSuffix(source, "\n") {
		source += "\n"
	}

	p, err := swyplang.Parse(*out, source)
	if err != nil {
		return fmt.Errorf("generated source rejected: %w", err)
	}
	if err := p.Check(); err != nil {
		return fmt.Errorf("generated source rejected: %w", err)
	}

	file, err := os.OpenFile(*out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.WriteString(source)
	closeErr := file.Close()
	if writeErr != nil {
		_ = os.Remove(*out)
		return writeErr
	}
	if closeErr != nil {
		_ = os.Remove(*out)
		return closeErr
	}

	fmt.Printf("Synthesized %s (evaluated %d candidates)\n", *out, res.Candidates)
	if len(validation) > 0 {
		fmt.Printf("Validated %d supplied points; %d rounds, %d counterexamples added.\n", refinement.VerifiedPoints, refinement.Rounds, refinement.AddedExamples)
	}
	fmt.Println("Exact float64 equality on supplied examples; no claim of proof or generalization.")
	return nil
}

func decodeSynthInput(data []byte) (synthesis.Spec, []synthesis.Example, error) {
	var spec synthesis.Spec
	var input synthInput
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return spec, nil, fmt.Errorf("invalid spec JSON: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return spec, nil, fmt.Errorf("spec JSON has trailing data")
	}
	examples, err := pairs(input.Examples)
	if err != nil {
		return spec, nil, err
	}
	validation, err := pairs(input.Validation)
	if err != nil {
		return spec, nil, fmt.Errorf("validation: %w", err)
	}
	spec = synthesis.Spec{Examples: examples, MaxNodes: input.MaxNodes, MaxCandidates: input.MaxCandidates}
	for _, c := range input.Constants {
		if c == nil {
			return spec, nil, fmt.Errorf("constants must be numbers, not null")
		}
		spec.Constants = append(spec.Constants, *c)
	}
	return spec, validation, nil
}
