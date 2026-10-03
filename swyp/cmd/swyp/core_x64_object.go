package main

import (
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/coreir"
)

func coreX64ObjectCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-x64-object", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function")
	format := flags.String("format", "coff", "object format: coff, elf or macho")
	output := flags.String("o", "", "new x86-64 relocatable object destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-x64-object [-format coff|elf|macho] -entry fn -o module.o file.swyp")
	}
	artifact, err := compileX64PackModuleIR(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	code, err := emitX64PackedCode(artifact)
	if err != nil {
		return err
	}

	var object []byte
	var formatName string
	switch *format {
	case "coff":
		object, err = coreir.EncodeX64COFFObject(*entry, code)
		formatName = "COFF/AMD64"
	case "elf":
		wrapped, wrapErr := coreir.WrapX64SysVEntry(artifact.EntrySSA, code)
		if wrapErr != nil {
			return wrapErr
		}
		object, err = coreir.EncodeX64ELFObject(*entry, wrapped)
		formatName = "ELF64/x86-64"
	case "macho":
		wrapped, wrapErr := coreir.WrapX64SysVEntry(artifact.EntrySSA, code)
		if wrapErr != nil {
			return wrapErr
		}
		object, err = coreir.EncodeX64MachOObject(*entry, wrapped)
		formatName = "Mach-O/x86-64"
	default:
		return fmt.Errorf("unsupported x86-64 object format %q", *format)
	}
	if err != nil {
		return err
	}

	if err := writeNewModule(*output, object); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created %s object %s (text=%d bytes entry=%s)\n", formatName, *output, len(code), coreir.X64LeafSymbol(*entry))
	return nil
}

func emitX64PackedCode(artifact x64ModuleIRArtifact) ([]byte, error) {
	if len(artifact.Functions) == 0 || artifact.EntrySSA.Name == "" {
		return nil, fmt.Errorf("x64 object: empty compiled artifact")
	}
	if len(artifact.Functions) == 1 {
		if code, err := coreir.EmitX64LeafMachineCode(artifact.EntrySSA, artifact.EntryPlan); err == nil {
			return code, nil
		}
		code, err := coreir.EmitX64CFGMachineCode(artifact.EntrySSA, artifact.EntryPlan)
		if err != nil {
			return nil, fmt.Errorf("x64 object: cfg machine code: %w", err)
		}
		return code, nil
	}
	code, err := coreir.EmitX64CFGMachineModule(artifact.Functions, artifact.Plans, artifact.EntrySSA.Name)
	if err != nil {
		return nil, fmt.Errorf("x64 object: module machine code: %w", err)
	}
	return code, nil
}
