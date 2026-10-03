package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"swyp-lang/internal/coreir"
)

func coreARM64ExeCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-arm64-exe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function (AAPCS64 i64/u64/bool/ieee64 parameters)")
	pie := flags.Bool("pie", false, "emit a static position-independent ELF ET_DYN image")
	allowFSRead := flags.Bool("allow-fs-read", false, "grant standalone fs.read authority")
	allowFSWrite := flags.Bool("allow-fs-write", false, "grant standalone fs.write authority")
	allowNetConnect := flags.Bool("allow-net-connect", false, "grant standalone IPv4 TCP connect authority")
	allowNetFetch := flags.Bool("allow-net-fetch", false, "grant standalone plaintext HTTP fetch authority to IPv4 literals")
	allowProcessExec := flags.Bool("allow-process-exec", false, "grant standalone process.exec authority (runtime remains fail-closed until executable policy is configured)")
	output := flags.String("o", "", "new standalone ELF64/AArch64 executable destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-arm64-exe [-pie] -entry fn -o program file.swyp")
	}
	if _, err := os.Stat(*output); err == nil {
		return fmt.Errorf("output already exists: %s", *output)
	} else if !os.IsNotExist(err) {
		return err
	}

	artifact, err := compileARM64ExeModuleIR(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	if err := validateStandaloneSensitiveGrants(artifact.Module, *allowFSRead, *allowFSWrite, *allowNetConnect, *allowNetFetch, *allowProcessExec); err != nil {
		return err
	}
	image, textBytes, mode, err := encodeARM64StandaloneArtifact(artifact, *pie)
	if err != nil {
		return err
	}
	if err := writeExecutable(*output, image); err != nil {
		return err
	}
	fmt.Fprintf(out, "Created standalone %s executable %s (text=%d bytes entry=%s)\n", mode, *output, textBytes, coreir.ARM64LeafSymbol(*entry))
	return nil
}

func arm64ArtifactUsesProcessIO(artifact arm64PackIRArtifact) bool {
	for _, f := range artifact.Functions {
		for _, block := range f.Blocks {
			if !block.Reachable {
				continue
			}
			for _, ins := range block.Instructions {
				if ins.Op == "io.stdout" || ins.Op == "io.stderr" || ins.Op == "clock.read" || ins.Op == "rng.sample" || ins.Op == "fs.read" || ins.Op == "fs.write" || ins.Op == "bytes.get" || ins.Op == "net.connect" || ins.Op == "net.fetch" || ins.Op == "process.exec" {
					return true
				}
			}
		}
	}
	return false
}
