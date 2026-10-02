package main

import (
	"flag"
	"fmt"
	"io"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/hircore"
)

func hirX64ExeCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-x64-exe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	entry := flags.String("entry", "main", "root-module function entry")
	format := flags.String("format", "pe", "executable format: pe or elf")
	pie := flags.Bool("pie", false, "emit static position-independent ELF ET_DYN")
	allowFSRead := flags.Bool("allow-fs-read", false, "grant standalone fs.read authority")
	allowFSWrite := flags.Bool("allow-fs-write", false, "grant standalone fs.write authority")
	allowNetConnect := flags.Bool("allow-net-connect", false, "grant standalone IPv4 TCP connect authority")
	allowNetFetch := flags.Bool("allow-net-fetch", false, "grant standalone plaintext HTTP fetch authority to IPv4 literals")
	allowProcessExec := flags.Bool("allow-process-exec", false, "grant standalone process.exec authority (runtime remains fail-closed until executable policy is configured)")
	output := flags.String("o", "", "new standalone x86-64 executable")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *entry == "" || *output == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-x64-exe requires -root DIR [-entry fn] [-format pe|elf] [-pie] -o program root.swyp")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	lowered, err := hircore.Lower(bundle, *entry)
	if err != nil {
		return err
	}
	artifact, err := prepareX64ModuleIR(lowered.Module, lowered.Entry, true, true)
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
	_, err = fmt.Fprintf(out, "Created linked-HIR standalone %s executable %s (text=%d bytes entry=%s)\n",
		formatName, *output, textBytes, coreir.X64LeafSymbol(lowered.Entry))
	return err
}

func hirARM64ExeCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("hir-arm64-exe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "explicit module root")
	entry := flags.String("entry", "main", "root-module function entry")
	pie := flags.Bool("pie", false, "emit static position-independent ELF ET_DYN")
	allowFSRead := flags.Bool("allow-fs-read", false, "grant standalone fs.read authority")
	allowFSWrite := flags.Bool("allow-fs-write", false, "grant standalone fs.write authority")
	allowNetConnect := flags.Bool("allow-net-connect", false, "grant standalone IPv4 TCP connect authority")
	allowNetFetch := flags.Bool("allow-net-fetch", false, "grant standalone plaintext HTTP fetch authority to IPv4 literals")
	allowProcessExec := flags.Bool("allow-process-exec", false, "grant standalone process.exec authority (runtime remains fail-closed until executable policy is configured)")
	output := flags.String("o", "", "new standalone ELF64/AArch64 executable")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *root == "" || *entry == "" || *output == "" || flags.NArg() != 1 {
		return fmt.Errorf("hir-arm64-exe requires -root DIR [-entry fn] [-pie] -o program root.swyp")
	}
	bundle, err := buildHIRBundle(flags.Arg(0), *root)
	if err != nil {
		return err
	}
	lowered, err := hircore.Lower(bundle, *entry)
	if err != nil {
		return err
	}
	artifact, err := prepareARM64ModuleIR(lowered.Module, lowered.Entry, true)
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
	_, err = fmt.Fprintf(out, "Created linked-HIR standalone %s executable %s (text=%d bytes entry=%s)\n",
		mode, *output, textBytes, coreir.ARM64LeafSymbol(lowered.Entry))
	return err
}
