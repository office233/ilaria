package main

import (
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/componentspec"
	"swyp-lang/internal/hir"
	"swyp-lang/internal/sourcefront"
	"swyp-lang/internal/swyplang"
)

var componentDeclarationKinds = map[string]bool{
	"component": true, "capability": true, "effect": true, "contract": true,
	"task": true, "agent": true, "driver": true, "model": true, "expert": true,
	"dataset": true, "train": true, "verify": true, "record": true,
}

func executableHIRDeclarationKind(kind string) bool {
	switch kind {
	case "fn", "struct", "enum":
		return true
	default:
		return false
	}
}

func hirCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	output := flags.String("o", "", "optional new HIR JSON output file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("hir requires exactly one Swyp source file")
	}
	path := flags.Arg(0)
	source, err := readModuleInput(path, 1<<20)
	if err != nil {
		return err
	}
	first, err := sourcefront.FirstBodyToken(path, string(source))
	if err != nil {
		return err
	}
	var module hir.Module
	switch {
	case executableHIRDeclarationKind(first):
		// Prefer the compatibility frontend when the source is valid there so
		// inferred legacy signatures keep their established semantics. Core is
		// the superset fallback for explicit systems types/effects/operators.
		if legacy, legacyParseErr := swyplang.ParseModule(path, string(source)); legacyParseErr == nil {
			if legacyHIR, legacyErr := legacy.HIRModule(nil); legacyErr == nil {
				module = legacyHIR
				break
			}
		}
		p, coreErr := swyplang.ParseCoreModule(path, string(source))
		if coreErr != nil {
			return coreErr
		}
		module, coreErr = p.HIRModule(nil)
		if coreErr != nil {
			return coreErr
		}
	case componentDeclarationKinds[first]:
		manifest, err := componentspec.Parse(path, string(source))
		if err != nil {
			return err
		}
		module, err = manifest.HIRDeclarations()
		if err != nil {
			return err
		}
	default:
		return fmt.Errorf("HIR frontend cannot classify first declaration %q", first)
	}
	payload, err := module.CanonicalJSON()
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if *output != "" {
		if err := writeNewModule(*output, payload); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, "Created HIR", *output)
		return err
	}
	_, err = out.Write(payload)
	return err
}
