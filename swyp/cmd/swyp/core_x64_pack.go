package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"swyp-lang/internal/coreir"
)

func coreX64PackCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-x64-pack", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "leaf entry function")
	output := flags.String("o", "", "new .swx64 module destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-x64-pack -entry fn -o module.swx64 file.swyp")
	}
	if _, err := os.Stat(*output); err == nil {
		return fmt.Errorf("output already exists: %s", *output)
	} else if !os.IsNotExist(err) {
		return err
	}
	artifact, err := compileX64PackModuleIR(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	module, encoded, err := encodeX64PackArtifact(artifact, *entry)
	if err != nil {
		return err
	}
	if err := writeNewModule(*output, encoded); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created x86-64 module %s (code=%d bytes sha256=%s abi=%s)\n",
		*output, len(module.Code), module.Header.CodeSHA256, module.Header.ABI)
	return nil
}

func encodeX64PackArtifact(artifact x64ModuleIRArtifact, entry string) (coreir.X64Module, []byte, error) {
	var module coreir.X64Module
	var code []byte
	var leafErr error
	var err error
	if len(artifact.Functions) == 1 {
		code, leafErr = coreir.EmitX64LeafMachineCode(artifact.EntrySSA, artifact.EntryPlan)
		if leafErr == nil {
			module, err = coreir.NewX64Module(artifact.EntrySSA, code)
		} else {
			code, err = coreir.EmitX64CFGMachineCode(artifact.EntrySSA, artifact.EntryPlan)
			if err == nil {
				module, err = coreir.NewX64CFGModule(artifact.EntrySSA, code)
			}
		}
	} else {
		leafErr = fmt.Errorf("entry retains %d reachable functions", len(artifact.Functions))
		code, err = coreir.EmitX64CFGMachineModule(artifact.Functions, artifact.Plans, entry)
		if err == nil {
			usesFP := false
			for _, function := range artifact.Functions {
				for _, typ := range function.ValueTypes {
					if typ == coreir.IEEE64 {
						usesFP = true
						break
					}
				}
				if usesFP {
					break
				}
			}
			if usesFP {
				module, err = coreir.NewX64CFGFPCallsModule(artifact.EntrySSA, code)
			} else {
				module, err = coreir.NewX64CFGCallsModule(artifact.EntrySSA, code)
			}
		}
	}
	if err != nil {
		return coreir.X64Module{}, nil, fmt.Errorf("x64 pack: leaf backend: %v; cfg backend: %w", leafErr, err)
	}
	encoded, err := coreir.EncodeX64Module(module)
	if err != nil {
		return coreir.X64Module{}, nil, err
	}
	return module, encoded, nil
}
