package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"swyp-lang/internal/coreir"
)

func coreX64DLLCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-x64-dll", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "exported entry function")
	output := flags.String("o", "", "new PE32+ AMD64 DLL destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-x64-dll -entry fn -o module.dll file.swyp")
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
	code, err := emitX64PackedCode(artifact)
	if err != nil {
		return err
	}
	image, err := coreir.EncodeX64PEDLL(*entry, code)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := file.Write(image); err != nil {
		_ = file.Close()
		_ = os.Remove(*output)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(*output)
		return err
	}
	fmt.Fprintf(out, "Created PE32+/AMD64 DLL %s (text=%d bytes export=%s)\n", *output, len(code), coreir.X64LeafSymbol(*entry))
	return nil
}
