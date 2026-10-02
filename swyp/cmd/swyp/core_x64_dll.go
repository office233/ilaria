package main

import (
	"flag"
	"fmt"
	"io"

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
	if err := writeNewModule(*output, image); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created PE32+/AMD64 DLL %s (text=%d bytes export=%s)\n", *output, len(code), coreir.X64LeafSymbol(*entry))
	return nil
}
