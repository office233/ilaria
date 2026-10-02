package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"swyp-lang/internal/coreir"
)

const nativeCompilerTimeout = 2 * time.Minute

func runNativeCompiler(name string, args ...string) ([]byte, error) {
	return runNativeCompilerWithTimeout(nativeCompilerTimeout, name, args...)
}

func runNativeCompilerWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if ctx.Err() != nil {
		return output, fmt.Errorf("compiler timed out: %w", ctx.Err())
	}
	return output, err
}

// runNativeCompilerExclusive keeps partial compiler output in a private
// directory and publishes the completed executable with O_EXCL. A compiler
// never receives the user's destination, so it cannot overwrite a file that
// appears between the preflight check and compilation.
func runNativeCompilerExclusive(name, destination string, args ...string) ([]byte, error) {
	if _, err := os.Lstat(destination); err == nil {
		return nil, fmt.Errorf("output already exists: %s", destination)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "swyp-native-output-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	compiled := filepath.Join(dir, "program.exe")
	compilerArgs := append(append([]string(nil), args...), "-o", compiled)
	output, err := runNativeCompiler(name, compilerArgs...)
	if err != nil {
		return output, err
	}
	if err := copyFileExclusive(compiled, destination, 0o700); err != nil {
		return output, fmt.Errorf("publish native executable: %w", err)
	}
	return output, nil
}

func validateStandaloneSensitiveGrants(m coreir.Module, allowFSRead, allowFSWrite, allowNetConnect, allowNetFetch, allowProcessExec bool) error {
	if moduleUsesEffect(m, coreir.EffectFSWrite) && !allowFSWrite {
		return fmt.Errorf("entry requires capability workspace_write; rerun with -allow-fs-write to grant standalone filesystem write authority")
	}
	if moduleUsesEffect(m, coreir.EffectFSRead) && !allowFSRead {
		return fmt.Errorf("entry requires capability workspace_read; rerun with -allow-fs-read to grant standalone filesystem read authority")
	}
	if moduleUsesEffect(m, coreir.EffectNetConnect) && !allowNetConnect {
		return fmt.Errorf("entry requires capability network_connect; rerun with -allow-net-connect to grant standalone TCP connect authority")
	}
	if moduleUsesEffect(m, coreir.EffectNetFetch) && !allowNetFetch {
		return fmt.Errorf("entry requires capability network_fetch; rerun with -allow-net-fetch to grant standalone plaintext HTTP fetch authority")
	}
	if moduleUsesEffect(m, coreir.EffectProcessExec) && !allowProcessExec {
		return fmt.Errorf("entry requires capability process_exec; rerun with -allow-process-exec to grant standalone process execution authority")
	}
	return nil
}

func encodeX64StandaloneArtifact(artifact x64ModuleIRArtifact, format string, pie bool) ([]byte, int, string, error) {
	usesStorage := moduleUsesInstruction(artifact.Module, "storage.alloc_u64") ||
		moduleUsesInstruction(artifact.Module, "storage.load_u64") ||
		moduleUsesInstruction(artifact.Module, "storage.store_u64") ||
		moduleUsesInstruction(artifact.Module, "storage.free")
	usesProcessIO := len(artifact.Entry.Effects) != 0 || moduleUsesInstruction(artifact.Module, "bytes.get") || usesStorage
	var code []byte
	var processCode coreir.X64ProcessMachineCode
	var err error
	if usesProcessIO {
		processCode, err = coreir.EmitX64CFGMachineProcessModule(artifact.Functions, artifact.Plans, artifact.EntrySSA.Name)
		processCode.Data = append([]byte(nil), artifact.Module.Data...)
		if moduleUsesEffect(artifact.Module, coreir.EffectFSRead) || moduleUsesEffect(artifact.Module, coreir.EffectNetFetch) {
			processCode.RuntimeDataBytes = coreir.DefaultProcessRuntimeArenaBytes
		}
		if usesStorage {
			processCode.StorageDataBytes = coreir.DefaultNativeStorageArenaBytes
			processCode.RuntimeDataBytes += processCode.StorageDataBytes
		}
		code = processCode.Code
	} else {
		code, err = emitX64PackedCode(artifact)
	}
	if err != nil {
		return nil, 0, "", err
	}
	var image []byte
	var formatName string
	switch format {
	case "pe":
		if pie {
			return nil, 0, "", fmt.Errorf("-pie is only supported with -format elf")
		}
		if usesProcessIO {
			image, err = coreir.EncodeX64PEProcessExecutable(artifact.EntrySSA, processCode)
		} else {
			image, err = coreir.EncodeX64PEExecutable(artifact.EntrySSA, code)
		}
		formatName = "PE32+/AMD64"
	case "elf":
		if usesProcessIO {
			image, err = coreir.EncodeX64ELFProcessExecutable(artifact.EntrySSA, processCode, pie)
			if pie {
				formatName = "ELF64/x86-64 PIE"
			} else {
				formatName = "ELF64/x86-64"
			}
		} else if pie {
			image, err = coreir.EncodeX64ELFPIEExecutable(artifact.EntrySSA, code)
			formatName = "ELF64/x86-64 PIE"
		} else {
			image, err = coreir.EncodeX64ELFExecutable(artifact.EntrySSA, code)
			formatName = "ELF64/x86-64"
		}
	default:
		return nil, 0, "", fmt.Errorf("unsupported x86-64 executable format %q", format)
	}
	if err != nil {
		return nil, 0, "", err
	}
	return image, len(code), formatName, nil
}

func encodeARM64StandaloneArtifact(artifact arm64PackIRArtifact, pie bool) ([]byte, int, string, error) {
	usesStorage := moduleUsesInstruction(artifact.Module, "storage.alloc_u64") ||
		moduleUsesInstruction(artifact.Module, "storage.load_u64") ||
		moduleUsesInstruction(artifact.Module, "storage.store_u64") ||
		moduleUsesInstruction(artifact.Module, "storage.free")
	usesProcessIO := arm64ArtifactUsesProcessIO(artifact) || usesStorage
	var code []byte
	var processCode coreir.ARM64ProcessMachineCode
	var err error
	if usesProcessIO {
		processCode, err = coreir.EmitARM64CFGMachineProcessModule(artifact.Functions, artifact.Plans, artifact.EntrySSA.Name)
		processCode.Data = append([]byte(nil), artifact.Module.Data...)
		if moduleUsesEffect(artifact.Module, coreir.EffectFSRead) || moduleUsesEffect(artifact.Module, coreir.EffectNetFetch) {
			processCode.RuntimeDataBytes = coreir.DefaultProcessRuntimeArenaBytes
		}
		if usesStorage {
			processCode.StorageDataBytes = coreir.DefaultNativeStorageArenaBytes
			processCode.RuntimeDataBytes += processCode.StorageDataBytes
		}
		code = processCode.Code
	} else {
		code, err = emitARM64PackedCode(artifact)
	}
	if err != nil {
		return nil, 0, "", err
	}
	var image []byte
	if usesProcessIO {
		image, err = coreir.EncodeARM64ELFProcessExecutable(artifact.EntrySSA, processCode, pie)
	} else if pie {
		image, err = coreir.EncodeARM64ELFPIEExecutable(artifact.EntrySSA, code)
	} else {
		image, err = coreir.EncodeARM64ELFExecutable(artifact.EntrySSA, code)
	}
	if err != nil {
		return nil, 0, "", err
	}
	mode := "ELF64/AArch64"
	if pie {
		mode += " PIE"
	}
	return image, len(code), mode, nil
}

func writeExecutable(path string, image []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return err
	}
	n, writeErr := file.Write(image)
	closeErr := file.Close()
	if writeErr == nil && n != len(image) {
		writeErr = io.ErrShortWrite
	}
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(path)
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	}
	return nil
}
