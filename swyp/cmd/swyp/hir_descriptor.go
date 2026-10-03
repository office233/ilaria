package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/hir"
)

func hirDescriptorCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-descriptor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	typeText := flags.String("type", "", "root-module-visible descriptor type")
	output := flags.String("o", "", "optional new descriptor JSON file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *typeText == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-descriptor requires -root DIR -type TYPE [-o descriptor.json] root.swyp")
	}
	typ, err := hir.ParseTypeRef(*typeText)
	if err != nil {
		return fmt.Errorf("invalid descriptor type %q: %w", *typeText, err)
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	plan, err := hir.PlanDescriptor(bundle, bundle.Root, typ)
	if err != nil {
		return err
	}
	payload, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, "Created HIR descriptor plan", *output)
		return err
	}
	_, err = out.Write(payload)
	return err
}
