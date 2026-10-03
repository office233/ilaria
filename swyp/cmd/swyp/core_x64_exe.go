package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"swyp-lang/internal/coreir"
)

func coreX64ExeCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-x64-exe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function (up to 4 i64/u64/bool/ieee64 parameters)")
	format := flags.String("format", "pe", "executable format: pe or elf")
	pie := flags.Bool("pie", false, "emit a static position-independent ELF ET_DYN image")
	allowFSRead := flags.Bool("allow-fs-read", false, "grant standalone fs.read authority")
	allowFSWrite := flags.Bool("allow-fs-write", false, "grant standalone fs.write authority")
	allowNetConnect := flags.Bool("allow-net-connect", false, "grant standalone IPv4 TCP connect authority")
	allowNetFetch := flags.Bool("allow-net-fetch", false, "grant standalone plaintext HTTP fetch authority to IPv4 literals")
	allowProcessExec := flags.Bool("allow-process-exec", false, "grant standalone process.exec authority (runtime remains fail-closed until executable policy is configured)")
	output := flags.String("o", "", "new standalone x86-64 executable destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-x64-exe [-format pe|elf] [-pie] -entry fn -o program file.swyp")
	}
	if _, err := os.Stat(*output); err == nil {
		return fmt.Errorf("output already exists: %s", *output)
	} else if !os.IsNotExist(err) {
		return err
	}

	artifact, err := compileX64ExeModuleIR(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	if err := validateStandaloneSensitiveGrants(artifact.Module, *allowFSRead, *allowFSWrite, *allowNetConnect, *allowNetFetch, *allowProcessExec); err != nil {
		return err
	}
	image, textBytes, formatName, err := encodeX64StandaloneArtifact(artifact, *format, *pie)
	if err != nil {
		return err
	}
	if err := writeExecutable(*output, image); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created standalone %s executable %s (text=%d bytes entry=%s)\n", formatName, *output, textBytes, coreir.X64LeafSymbol(*entry))
	return nil
}

func moduleUsesEffect(m coreir.Module, effect string) bool {
	for _, f := range m.Functions {
		for _, candidate := range f.Effects {
			if candidate == effect {
				return true
			}
		}
	}
	return false
}

func moduleUsesInstruction(m coreir.Module, op string) bool {
	for _, f := range m.Functions {
		for _, block := range f.Blocks {
			for _, ins := range block.Instructions {
				if ins.Op == op {
					return true
				}
			}
		}
	}
	return false
}
