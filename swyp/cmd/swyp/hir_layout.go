package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/hir"
)

func hirLayoutCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-layout", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	typeText := flags.String("type", "", "root-module-visible fixed-layout type")
	output := flags.String("o", "", "optional new layout JSON file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *typeText == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-layout requires -root DIR -type TYPE [-o layout.json] root.swyp")
	}
	typ, err := hir.ParseTypeRef(*typeText)
	if err != nil {
		return fmt.Errorf("invalid layout type %q: %w", *typeText, err)
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	layout, err := hir.PlanFixedLayout(bundle, bundle.Root, typ)
	if err != nil {
		return err
	}
	payload, err := json.MarshalIndent(layout, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, "Created fixed HIR layout", *output)
		return err
	}
	_, err = out.Write(payload)
	return err
}
