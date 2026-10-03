package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
	"swyp-lang/protocol/effects"
)

// corePreflightCommand compiles and validates one snapshot without executing
// guest instructions. An optional snapshot is published exclusively, as exact
// compact canonical JSON, before the authority-free plan is emitted.
func corePreflightCommand(args []string, out io.Writer) (err error) {
	emitted := false
	defer func() {
		if err == nil || emitted {
			return
		}
		if writeErr := json.NewEncoder(out).Encode(struct {
			ProtocolVersion uint64             `json:"protocol_version"`
			Status          string             `json:"status"`
			Diagnostic      *coreir.Diagnostic `json:"diagnostic"`
		}{effects.Version, "failed", compilerDiagnostic(err)}); writeErr != nil {
			err = errors.Join(err, writeErr)
		}
	}()
	flags := flag.NewFlagSet("core-preflight", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := "main"
	output := ""
	flags.StringVar(&entry, "entry", "main", "selected Core function")
	flags.StringVar(&output, "o", "", "new canonical Core IR snapshot; must not exist")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("core-preflight requires one source file")
	}
	input, err := readModuleInput(flags.Arg(0), coreir.MaxBytes)
	if err != nil {
		return err
	}
	program, err := swyplang.ParseCore(flags.Arg(0), string(input))
	if err != nil {
		return err
	}
	module, err := program.CoreIR(entry)
	if err != nil {
		return err
	}
	canonical, err := json.Marshal(module)
	if err != nil {
		return err
	}
	if len(canonical) > coreir.MaxBytes {
		return &coreir.Diagnostic{Code: "invalid_snapshot", Message: fmt.Sprintf("canonical Core IR snapshot exceeds %d-byte limit", coreir.MaxBytes)}
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		return err
	}
	preflight, err := executable.PreflightEffects(entry)
	if err != nil {
		return err
	}
	plan := effects.EffectPlan{
		ProtocolVersion: effects.Version, ModuleHash: coreHash(canonical), Entry: preflight.Entry,
		Effects: preflight.Effects, CapabilityBindings: preflight.CapabilityBindings,
	}
	if err := effects.ValidatePlan(plan); err != nil {
		return &coreir.Diagnostic{Code: "invalid_effect_plan", Message: err.Error()}
	}
	if output != "" {
		if err := writeNewModule(output, canonical); err != nil {
			return err
		}
	}
	emitted = true
	return json.NewEncoder(out).Encode(plan)
}
