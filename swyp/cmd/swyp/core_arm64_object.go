package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"swyp-lang/internal/coreir"
)

func coreARM64ObjectCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-arm64-object", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function")
	format := flags.String("format", "elf", "object format: elf, coff or macho")
	output := flags.String("o", "", "new AArch64 relocatable object destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-arm64-object [-format elf|coff|macho] -entry fn -o module.o file.swyp")
	}
	if _, err := os.Stat(*output); err == nil {
		return fmt.Errorf("output already exists: %s", *output)
	} else if !os.IsNotExist(err) {
		return err
	}

	artifact, err := compileARM64PackModuleIR(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	code, err := emitARM64PackedCode(artifact)
	if err != nil {
		return err
	}
	var object []byte
	var formatName string
	switch *format {
	case "elf":
		object, err = coreir.EncodeARM64ELFObject(*entry, code)
		formatName = "ELF64/AArch64"
	case "coff":
		object, err = coreir.EncodeARM64COFFObject(*entry, code)
		formatName = "COFF/ARM64"
	case "macho":
		object, err = coreir.EncodeARM64MachOObject(*entry, code)
		formatName = "Mach-O/ARM64"
	default:
		return fmt.Errorf("unsupported ARM64 object format %q", *format)
	}
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := file.Write(object); err != nil {
		_ = file.Close()
		_ = os.Remove(*output)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(*output)
		return err
	}
	fmt.Fprintf(out, "Created %s object %s (text=%d bytes entry=%s)\n", formatName, *output, len(code), coreir.ARM64LeafSymbol(*entry))
	return nil
}

func emitARM64PackedCode(artifact arm64PackIRArtifact) ([]byte, error) {
	if len(artifact.Functions) == 0 || artifact.EntrySSA.Name == "" {
		return nil, fmt.Errorf("arm64 object: empty compiled artifact")
	}
	if len(artifact.Functions) == 1 {
		if code, err := coreir.EmitARM64LeafMachineCode(artifact.EntrySSA, artifact.EntryPlan); err == nil {
			return code, nil
		}
		code, err := coreir.EmitARM64CFGMachineCode(artifact.EntrySSA, artifact.EntryPlan)
		if err != nil {
			return nil, fmt.Errorf("arm64 object: cfg machine code: %w", err)
		}
		return code, nil
	}
	code, err := coreir.EmitARM64CFGMachineModule(artifact.Functions, artifact.Plans, artifact.EntrySSA.Name)
	if err != nil {
		return nil, fmt.Errorf("arm64 object: module machine code: %w", err)
	}
	return code, nil
}
