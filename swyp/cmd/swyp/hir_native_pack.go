package main

import (
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/hircore"
)

func hirX64PackCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-x64-pack", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	entry := flags.String("entry", "main", "root-module function entry")
	output := flags.String("o", "", "new .swx64 module destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *entry == "" || *output == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-x64-pack requires -root DIR [-entry fn] -o module.swx64 root.swyp")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	lowered, err := hircore.Lower(bundle, *entry)
	if err != nil {
		return err
	}
	artifact, err := prepareX64ModuleIR(lowered.Module, lowered.Entry, true, false)
	if err != nil {
		return err
	}
	module, encoded, err := encodeX64PackArtifact(artifact, lowered.Entry)
	if err != nil {
		return err
	}
	if err := writeNewModule(*output, encoded); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "Created linked-HIR x86-64 module %s (code=%d bytes sha256=%s abi=%s entry=%s)\n",
		*output, len(module.Code), module.Header.CodeSHA256, module.Header.ABI, module.Header.Entry)
	return err
}

func hirARM64PackCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-arm64-pack", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	entry := flags.String("entry", "main", "root-module function entry")
	output := flags.String("o", "", "new .swa64 module destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *entry == "" || *output == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-arm64-pack requires -root DIR [-entry fn] -o module.swa64 root.swyp")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	lowered, err := hircore.Lower(bundle, *entry)
	if err != nil {
		return err
	}
	artifact, err := prepareARM64ModuleIR(lowered.Module, lowered.Entry, false)
	if err != nil {
		return err
	}
	module, encoded, err := encodeARM64PackArtifact(artifact, lowered.Entry)
	if err != nil {
		return err
	}
	if err := writeNewModule(*output, encoded); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "Created linked-HIR ARM64 module %s (code=%d bytes sha256=%s abi=%s entry=%s)\n",
		*output, len(module.Code), module.Header.CodeSHA256, module.Header.ABI, module.Header.Entry)
	return err
}
