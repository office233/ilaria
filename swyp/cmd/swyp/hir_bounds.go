package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/hir"
)

func hirBoundsCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-bounds", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	output := flags.String("o", "", "optional new bounds evidence JSON file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-bounds requires -root DIR [-o report.json] root.swyp")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	report, err := hir.AnalyzeBounds(bundle)
	if err != nil {
		return err
	}
	payload, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		if _, err := fmt.Fprintln(out, "Created HIR bounds evidence", *output); err != nil {
			return err
		}
	} else if _, err := out.Write(payload); err != nil {
		return err
	}
	if report.Status != "ok" {
		return fmt.Errorf("HIR bounds check failed with %d diagnostic(s)", len(report.Diagnostics))
	}
	return nil
}
