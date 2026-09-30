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
	if moduleUsesEffect(artifact.Module, coreir.EffectFSWrite) && !*allowFSWrite {
		return fmt.Errorf("entry requires capability workspace_write; rerun with -allow-fs-write to grant standalone filesystem write authority")
	}
	if moduleUsesEffect(artifact.Module, coreir.EffectFSRead) && !*allowFSRead {
		return fmt.Errorf("entry requires capability workspace_read; rerun with -allow-fs-read to grant standalone filesystem read authority")
	}
	if moduleUsesEffect(artifact.Module, coreir.EffectNetConnect) && !*allowNetConnect {
		return fmt.Errorf("entry requires capability network_connect; rerun with -allow-net-connect to grant standalone TCP connect authority")
	}
	if moduleUsesEffect(artifact.Module, coreir.EffectNetFetch) && !*allowNetFetch {
		return fmt.Errorf("entry requires capability network_fetch; rerun with -allow-net-fetch to grant standalone plaintext HTTP fetch authority")
	}
	if moduleUsesEffect(artifact.Module, coreir.EffectProcessExec) && !*allowProcessExec {
		return fmt.Errorf("entry requires capability process_exec; rerun with -allow-process-exec to grant standalone process execution authority")
	}
	usesProcessIO := len(artifact.Entry.Effects) != 0 || moduleUsesInstruction(artifact.Module, "bytes.get")
	var code []byte
	var processCode coreir.X64ProcessMachineCode
	if usesProcessIO {
		processCode, err = coreir.EmitX64CFGMachineProcessModule(artifact.Functions, artifact.Plans, artifact.EntrySSA.Name)
		processCode.Data = append([]byte(nil), artifact.Module.Data...)
		if moduleUsesEffect(artifact.Module, coreir.EffectFSRead) || moduleUsesEffect(artifact.Module, coreir.EffectNetFetch) {
			processCode.RuntimeDataBytes = coreir.DefaultProcessRuntimeArenaBytes
		}
		code = processCode.Code
	} else {
		code, err = emitX64PackedCode(artifact)
	}
	if err != nil {
		return err
	}
	var image []byte
	var formatName string
	switch *format {
	case "pe":
		if *pie {
			return fmt.Errorf("-pie is only supported with -format elf")
		}
		if usesProcessIO {
			image, err = coreir.EncodeX64PEProcessExecutable(artifact.EntrySSA, processCode)
		} else {
			image, err = coreir.EncodeX64PEExecutable(artifact.EntrySSA, code)
		}
		formatName = "PE32+/AMD64"
	case "elf":
		if usesProcessIO {
			image, err = coreir.EncodeX64ELFProcessExecutable(artifact.EntrySSA, processCode, *pie)
			if *pie {
				formatName = "ELF64/x86-64 PIE"
			} else {
				formatName = "ELF64/x86-64"
			}
		} else if *pie {
			image, err = coreir.EncodeX64ELFPIEExecutable(artifact.EntrySSA, code)
			formatName = "ELF64/x86-64 PIE"
		} else {
			image, err = coreir.EncodeX64ELFExecutable(artifact.EntrySSA, code)
			formatName = "ELF64/x86-64"
		}
	default:
		return fmt.Errorf("unsupported x86-64 executable format %q", *format)
	}
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
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
	fmt.Fprintf(out, "Created standalone %s executable %s (text=%d bytes entry=%s)\n", formatName, *output, len(code), coreir.X64LeafSymbol(*entry))
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
