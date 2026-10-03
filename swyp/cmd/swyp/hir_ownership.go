package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/hir"
)

func hirOwnershipCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-ownership", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	output := flags.String("o", "", "optional new ownership report JSON file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-ownership requires -root DIR [-o report.json] root.swyp")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	report, err := hir.AnalyzeOwnership(bundle)
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
	} else if _, err := out.Write(payload); err != nil {
		return err
	}
	if report.Status != "ok" {
		return fmt.Errorf("ownership check failed with %d diagnostic(s)", len(report.Diagnostics))
	}
	if *output != "" {
		_, err = fmt.Fprintln(out, "Created ownership report", *output)
		return err
	}
	return nil
}
