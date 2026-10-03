package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

type warningReceiver interface {
	SetWarning(string)
}

func reportCoreBuildWarning(out io.Writer, message string) {
	if wr, ok := out.(warningReceiver); ok {
		wr.SetWarning(message)
	} else {
		fmt.Fprintf(out, "warning: %s\n", message)
	}
}

func coreBuildCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-build", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "selected pure function")
	output := flags.String("o", "", "new native executable destination")
	profileName := flags.String("profile", "fast", "native AOT profile: safe or fast")
	cpu := flags.String("cpu", "portable", "CPU target: portable or native")
	lto := flags.Bool("lto", false, "enable GCC link-time optimization")
	strip := flags.Bool("strip", false, "strip symbols from the final executable")
	cacheDir := flags.String("cache-dir", "auto", "AOT cache directory; auto uses the user cache, off disables caching")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-build [-entry fn] [-profile safe|fast] [-cpu portable|native] [-lto] [-strip] [-cache-dir auto|off|DIR] -o new.exe file.swyp")
	}
	profile := coreir.NativeProfile(*profileName)
	if profile != coreir.NativeSafe && profile != coreir.NativeFast {
		return fmt.Errorf("unknown native profile %q; expected safe or fast", *profileName)
	}
	if *cpu != "portable" && *cpu != "native" {
		return fmt.Errorf("unknown CPU target %q; expected portable or native", *cpu)
	}
	if _, err := os.Stat(*output); err == nil {
		return fmt.Errorf("output already exists: %s", *output)
	} else if !os.IsNotExist(err) {
		return err
	}
	input, err := readModuleInput(flags.Arg(0), coreir.MaxBytes)
	if err != nil {
		return err
	}
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		return fmt.Errorf("core-build requires gcc on PATH: %w", err)
	}
	resolvedCacheDir := *cacheDir
	if resolvedCacheDir == "auto" {
		resolvedCacheDir, err = defaultCoreCacheDir()
		if err != nil {
			return fmt.Errorf("resolve Core AOT cache: %w", err)
		}
	}
	cacheEnabled := resolvedCacheDir != "off" && resolvedCacheDir != ""
	p, err := swyplang.ParseCore(flags.Arg(0), string(input))
	if err != nil {
		return err
	}
	m, err := p.CoreIR(*entry)
	if err != nil {
		return err
	}
	var optimization coreir.OptimizationReport
	if profile == coreir.NativeFast {
		m, optimization, err = coreir.Optimize(m)
		if err != nil {
			return err
		}
	}
	source, err := coreir.EmitNativeC(m, *entry, profile)
	if err != nil {
		return err
	}
	compilerFlags := nativeCompilerArgs(profile, *cpu, *lto, *strip, "", "")
	cacheKey := coreAOTCacheKey(source, compilerIdentity(gcc), *entry, string(profile), *cpu, *lto, *strip, compilerFlags...)
	cacheArtifact := ""
	if cacheEnabled {
		cacheArtifact = filepath.Join(resolvedCacheDir, cacheKey+".exe")
		if info, statErr := os.Stat(cacheArtifact); statErr == nil && info.Mode().IsRegular() {
			if err := copyFileExclusive(cacheArtifact, *output, 0700); err != nil {
				return fmt.Errorf("restore Core AOT cache artifact: %w", err)
			}
			fmt.Fprintf(out, "Built Core AOT %s (%s; cache hit %s)\n", *output, profile, cacheKey[:12])
			return nil
		} else if statErr != nil && !os.IsNotExist(statErr) {
			// The cache is optional. Unix reports ENOTDIR for a cache root
			// beneath a regular file, whereas Windows may classify the same
			// path as missing. Both must allow a fresh, uncached build.
			reportCoreBuildWarning(out, fmt.Sprintf("inspect Core AOT cache: %v", statErr))
			cacheEnabled = false
		}
	}
	dir, err := os.MkdirTemp("", "swyp-core-build-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	cfile := filepath.Join(dir, "program.c")
	if err := os.WriteFile(cfile, source, 0600); err != nil {
		return err
	}
	// The helper owns -o and exclusively publishes a completed artifact.
	compilerArgs := nativeCompilerArgs(profile, *cpu, *lto, *strip, cfile, "")
	if result, err := runNativeCompilerExclusive(gcc, *output, compilerArgs...); err != nil {
		return fmt.Errorf("Core AOT C compiler failed: %w\n%s", err, result)
	}
	if cacheEnabled {
		if err := installCacheArtifact(*output, cacheArtifact); err != nil {
			reportCoreBuildWarning(out, fmt.Sprintf("store Core AOT cache artifact: %v", err))
		}
	}
	if profile == coreir.NativeFast {
		fmt.Fprintf(out, "Built Core AOT %s (%s; inlined=%d folded=%d simplified=%d copies=%d branches=%d threaded=%d dead=%d blocks=%d slots=%d; cache=%s)\n",
			*output, profile,
			optimization.InlinedCalls,
			optimization.FoldedConstants,
			optimization.SimplifiedOps,
			optimization.PropagatedCopies,
			optimization.SimplifiedBranches,
			optimization.ThreadedJumps,
			optimization.DeadInstructions,
			optimization.RemovedBlocks,
			optimization.CompactedSlots,
			cacheKey[:12],
		)
	} else {
		fmt.Fprintf(out, "Built Core AOT %s (%s)\n", *output, profile)
	}
	return nil
}

func nativeCompilerArgs(profile coreir.NativeProfile, cpu string, lto, strip bool, cfile, output string) []string {
	opt := "-O2"
	if profile == coreir.NativeFast {
		opt = "-O3"
	}
	args := []string{
		"-std=c11",
		opt,
		"-ffp-contract=off",
		"-fomit-frame-pointer",
		"-fno-semantic-interposition",
	}
	if cpu == "native" {
		args = append(args, "-march=native", "-mtune=native")
	}
	if lto {
		args = append(args, "-flto")
	}
	if strip {
		args = append(args, "-s")
	}
	args = append(args, cfile)
	if output != "" {
		args = append(args, "-o", output)
	}
	return append(args, "-lm")
}
