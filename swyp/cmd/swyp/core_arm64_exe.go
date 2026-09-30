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
	usesProcessIO := arm64ArtifactUsesProcessIO(artifact)
	var code []byte
	var processCode coreir.ARM64ProcessMachineCode
	if usesProcessIO {
		processCode, err = coreir.EmitARM64CFGMachineProcessModule(artifact.Functions, artifact.Plans, artifact.EntrySSA.Name)
		processCode.Data = append([]byte(nil), artifact.Module.Data...)
		if moduleUsesEffect(artifact.Module, coreir.EffectFSRead) || moduleUsesEffect(artifact.Module, coreir.EffectNetFetch) {
			processCode.RuntimeDataBytes = coreir.DefaultProcessRuntimeArenaBytes
		}
		code = processCode.Code
	} else {
		code, err = emitARM64PackedCode(artifact)
	}
	if err != nil {
		return err
	}
	var image []byte
	if usesProcessIO {
		image, err = coreir.EncodeARM64ELFProcessExecutable(artifact.EntrySSA, processCode, *pie)
	} else if *pie {
		image, err = coreir.EncodeARM64ELFPIEExecutable(artifact.EntrySSA, code)
	} else {
		image, err = coreir.EncodeARM64ELFExecutable(artifact.EntrySSA, code)
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
	mode := "ELF64/AArch64"
	if *pie {
		mode += " PIE"
	}
	fmt.Fprintf(out, "Created standalone %s executable %s (text=%d bytes entry=%s)\n", mode, *output, len(code), coreir.ARM64LeafSymbol(*entry))
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
