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
	var module coreir.X64Module
	var code []byte
	var leafErr error
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
		code, err = coreir.EmitX64CFGMachineModule(artifact.Functions, artifact.Plans, *entry)
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
		return fmt.Errorf("x64 pack: leaf backend: %v; cfg backend: %w", leafErr, err)
	}
	encoded, err := coreir.EncodeX64Module(module)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		_ = os.Remove(*output)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(*output)
		return err
	}
	fmt.Fprintf(out, "Created x86-64 module %s (code=%d bytes sha256=%s abi=%s)\n",
		*output, len(module.Code), module.Header.CodeSHA256, module.Header.ABI)
	return nil
}
