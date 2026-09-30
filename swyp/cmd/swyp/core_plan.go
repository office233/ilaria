package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

type corePlanFunction struct {
	Name       string                     `json:"name"`
	Slots      int                        `json:"slots"`
	GPRUsed    int                        `json:"gpr_used"`
	FPUsed     int                        `json:"fp_used"`
	Spills     int                        `json:"spills"`
	SSAValues  int                        `json:"ssa_values"`
	SSAGPRUsed int                        `json:"ssa_gpr_used"`
	SSAFPUsed  int                        `json:"ssa_fp_used"`
	SSASpills  int                        `json:"ssa_spills"`
	Location   []corePlanRegisterLocation `json:"locations"`
}

type corePlanRegisterLocation struct {
	Slot     int    `json:"slot"`
	Type     string `json:"type"`
	Class    string `json:"class"`
	Register int    `json:"register"`
	Spill    int    `json:"spill"`
}

func corePlanCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-plan", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function used for lowering/optimization")
	gprs := flags.Int("gprs", 10, "available general-purpose registers")
	fps := flags.Int("fps", 8, "available floating-point/vector registers")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("usage: swyp core-plan [-entry fn] [-gprs N] [-fps N] file.swyp")
	}
	if *gprs < 0 || *gprs > 64 || *fps < 0 || *fps > 64 {
		return fmt.Errorf("register counts must be in 0..64")
	}
	input, err := readModuleInput(flags.Arg(0), coreir.MaxBytes)
	if err != nil {
		return err
	}
	p, err := swyplang.ParseCore(flags.Arg(0), string(input))
	if err != nil {
		return err
	}
	m, err := p.CoreIR(*entry)
	if err != nil {
		return err
	}
	m, optimization, err := coreir.Optimize(m)
	if err != nil {
		return err
	}

	report := struct {
		Version      int                       `json:"version"`
		Optimization coreir.OptimizationReport `json:"optimization"`
		Functions    []corePlanFunction        `json:"functions"`
	}{Version: 1, Optimization: optimization}
	for _, f := range m.Functions {
		plan, err := coreir.AllocateRegisters(f, *gprs, *fps)
		if err != nil {
			return fmt.Errorf("plan %s: %w", f.Name, err)
		}
		ssa, err := coreir.BuildSSA(f)
		if err != nil {
			return fmt.Errorf("ssa %s: %w", f.Name, err)
		}
		ssaPlan, err := coreir.AllocateSSARegisters(ssa, *gprs, *fps)
		if err != nil {
			return fmt.Errorf("ssa plan %s: %w", f.Name, err)
		}
		row := corePlanFunction{
			Name:       f.Name,
			Slots:      len(f.Slots),
			GPRUsed:    plan.GPRUsed,
			FPUsed:     plan.FPUsed,
			Spills:     plan.Spills,
			SSAValues:  len(ssa.ValueTypes),
			SSAGPRUsed: ssaPlan.GPRUsed,
			SSAFPUsed:  ssaPlan.FPUsed,
			SSASpills:  ssaPlan.Spills,
		}
		for slot, loc := range plan.Locations {
			class := "gpr"
			if loc.Class == coreir.RegisterFP {
				class = "fp"
			}
			row.Location = append(row.Location, corePlanRegisterLocation{
				Slot:     slot,
				Type:     string(f.Slots[slot]),
				Class:    class,
				Register: loc.Register,
				Spill:    loc.Spill,
			})
		}
		report.Functions = append(report.Functions, row)
	}
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}
