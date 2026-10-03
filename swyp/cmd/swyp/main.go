package main

import (
	"context"
	"flag"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"swyp-lang/internal/swyplang"
	"time"
)

func main() {
	if err := execute(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func execute(args []string) error {
	if len(args) > 0 {
		switch args[0] {
		case "language-manifest":
			return languageManifestCommand(os.Stdout)
		case "module-graph":
			return moduleGraphCommand(args[1:], os.Stdout)
		case "hir":
			return hirCommand(args[1:], os.Stdout)
		case "hir-link":
			return hirLinkCommand(args[1:], os.Stdout)
		case "hir-layout":
			return hirLayoutCommand(args[1:], os.Stdout)
		case "hir-descriptor":
			return hirDescriptorCommand(args[1:], os.Stdout)
		case "hir-bounds":
			return hirBoundsCommand(args[1:], os.Stdout)
		case "hir-ownership":
			return hirOwnershipCommand(args[1:], os.Stdout)
		case "hir-core":
			return hirCoreCommand(args[1:], os.Stdout)
		case "hir-x64-pack":
			return hirX64PackCommand(args[1:], os.Stdout)
		case "hir-arm64-pack":
			return hirARM64PackCommand(args[1:], os.Stdout)
		case "hir-x64-exe":
			return hirX64ExeCommand(args[1:], os.Stdout)
		case "hir-arm64-exe":
			return hirARM64ExeCommand(args[1:], os.Stdout)
		case "ir", "core-run", "core-exec", "verify":
			return coreCommand(args[0], args[1:], os.Stdout)
		case "core-broker":
			return coreBrokerCommand(args[1:], os.Stdin, os.Stdout)
		case "core-preflight":
			return corePreflightCommand(args[1:], os.Stdout)
		case "core-build":
			return coreBuildCommand(args[1:], os.Stdout)
		case "core-plan":
			return corePlanCommand(args[1:], os.Stdout)
		case "core-x64":
			return coreX64Command(args[1:], os.Stdout)
		case "core-x64-build":
			return coreX64BuildCommand(args[1:], os.Stdout)
		case "core-x64-pack":
			return coreX64PackCommand(args[1:], os.Stdout)
		case "core-x64-object":
			return coreX64ObjectCommand(args[1:], os.Stdout)
		case "core-x64-dll":
			return coreX64DLLCommand(args[1:], os.Stdout)
		case "core-x64-exe":
			return coreX64ExeCommand(args[1:], os.Stdout)
		case "core-arm64":
			return coreARM64Command(args[1:], os.Stdout)
		case "core-arm64-pack":
			return coreARM64PackCommand(args[1:], os.Stdout)
		case "core-arm64-object":
			return coreARM64ObjectCommand(args[1:], os.Stdout)
		case "core-arm64-exe":
			return coreARM64ExeCommand(args[1:], os.Stdout)
		case "component":
			return componentCommand(args[1:], os.Stdout)
		}
	}
	if len(args) > 0 && args[0] == "compile" {
		return compileModuleCommand(args[1:], os.Stdout)
	}
	if len(args) > 0 && args[0] == "exec" {
		return execModuleCommand(args[1:], os.Stdout)
	}
	if len(args) > 0 && args[0] == "worker" {
		if len(args) != 1 {
			return fmt.Errorf("worker accepts one JSON specification on stdin, no arguments")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return worker(ctx, os.Stdin, os.Stdout)
	}
	if len(args) > 0 && args[0] == "core-server" {
		if len(args) != 1 {
			return fmt.Errorf("core-server accepts JSONL on stdin and no arguments")
		}
		return coreServer(os.Stdin, os.Stdout, coreBuildCommand, coreCommand)
	}
	if len(args) > 0 && args[0] == "judge" {
		if len(args) != 1 {
			return fmt.Errorf("judge accepts one JSON request on stdin, no arguments")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return judge(ctx, os.Stdin, os.Stdout)
	}
	if len(args) > 0 && args[0] == "synth" {
		return synthCommand(args[1:])
	}
	if len(args) > 0 && (args[0] == "expand" || args[0] == "repair") {
		return intentCommand(args[0], args[1:])
	}
	if len(args) > 0 && args[0] == "draft" {
		return draftCommand(args[1:])
	}
	if len(args) > 0 && args[0] == "ternary" {
		return ternaryCommand(args[1:])
	}
	if len(args) == 1 && args[0] == "version" {
		fmt.Println("Swyp Lang " + swypLanguageVersion)
		return nil
	}
	if len(args) < 2 || (args[0] != "run" && args[0] != "check" && args[0] != "build" && args[0] != "emit-c" && args[0] != "web") {
		return fmt.Errorf("usage: swyp language-manifest | module-graph -root DIR [-o graph.json] root.swyp | hir [-o module.hir.json] file.swyp | hir-link -root DIR [-o bundle.hir.json] root.swyp | hir-layout -root DIR -type TYPE [-o layout.json] root.swyp | hir-descriptor -root DIR -type TYPE [-o descriptor.json] root.swyp | hir-bounds -root DIR [-o report.json] root.swyp | hir-ownership -root DIR [-o report.json] root.swyp | hir-core -root DIR [-entry fn] [-o core.json] root.swyp | hir-x64-pack -root DIR [-entry fn] -o module.swx64 root.swyp | hir-arm64-pack -root DIR [-entry fn] -o module.swa64 root.swyp | hir-x64-exe -root DIR [-entry fn] [-format pe|elf] [-pie] -o program root.swyp | hir-arm64-exe -root DIR [-entry fn] [-pie] -o program root.swyp | component check file.swyp | component compile -o manifest.json file.swyp | component go -package pkg -o types_gen.go file.swyp | core-build [-entry fn] [-profile safe|fast] [-cpu portable|native] [-lto] [-strip] -o new.exe file.swyp | core-plan [-entry fn] [-gprs N] [-fps N] file.swyp | core-x64 -entry fn -o new.s file.swyp | core-x64-build -entry fn -o new.exe file.swyp | core-x64-pack -entry fn -o module.swx64 file.swyp | core-x64-object [-format coff|elf|macho] -entry fn -o module.o file.swyp | core-x64-dll -entry fn -o module.dll file.swyp | core-x64-exe [-format pe|elf] [-pie] -entry fn -o program file.swyp | core-arm64 -entry fn -o new.s file.swyp | core-arm64-pack -entry fn -o module.swa64 file.swyp | core-arm64-object [-format elf|coff|macho] -entry fn -o module.o file.swyp | core-arm64-exe [-pie] -entry fn -o program file.swyp | core-preflight [-entry fn] [-o snapshot.core.json] file.swyp | core-broker [--ir] --run-id ID [-entry fn] [-steps N] [-timeout D] [-max-bytes N] file.swyp [typed values] | core-server < requests.jsonl | ir [-entry fn] [-o new.json] file.swyp | core-run [-profile safe|fast|turbo] [-entry fn] file.swyp [typed values] | core-exec [-profile safe|fast|turbo] [-entry fn] core.json [typed values] | verify -contract contract.json file.swyp | compile --target stv2 -o new.swypb file.swyp | exec [-steps N] module.swypb [integers] | judge < request.json | worker < spec.json | synth -o new.swyp spec.json | run [-steps N] file.swyp [numbers] | check file.swyp | build -o app.exe file.swyp | web -o app.html file.swyp | emit-c file.swyp | ternary [-steps N] file.tasm [initial-r0] | draft -prompt task.txt -o new.swyp | expand/repair -o new.swyp [-response fixture] input.swyp | version")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	steps := flags.Int("steps", 1_000_000, "interpreter evaluation budget")
	output := flags.String("o", "", "native executable destination")
	profile := flags.String("profile", "safe", "native build profile: safe or fast")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	rest := flags.Args()
	if len(rest) == 0 {
		return fmt.Errorf("source file is required")
	}
	if args[0] != "run" && len(rest) != 1 {
		return fmt.Errorf("unexpected positional arguments")
	}
	source, err := readModuleInput(rest[0], 1<<20)
	if err != nil {
		return err
	}
	if strings.Contains(string(source), "#natural") || strings.Contains(string(source), "#limbaj_natural") {
		intents, err := swyplang.Intents(rest[0], string(source))
		if err != nil {
			return err
		}
		if len(intents) > 0 {
			return fmt.Errorf("source has %d unexpanded intents; use swyp expand -o expanded.swyp %s, then check/run/build that file", len(intents), rest[0])
		}
	}
	program, err := swyplang.Parse(rest[0], string(source))
	if err != nil {
		return err
	}
	if err := program.Check(); err != nil {
		return err
	}
	if args[0] == "check" {
		fmt.Println("Syntax, names, types, and return paths OK")
		return nil
	}
	if args[0] == "web" {
		if *output == "" {
			return fmt.Errorf("web requires -o new-file.html")
		}
		html, err := program.EmitHTML()
		if err != nil {
			return err
		}
		if err := writeNewModule(*output, []byte(html)); err != nil {
			return err
		}
		fmt.Println("Created offline web runner", *output)
		return nil
	}
	if args[0] == "build" || args[0] == "emit-c" {
		if *profile != "safe" && *profile != "fast" {
			return fmt.Errorf("unknown native profile %q; expected safe or fast", *profile)
		}
		var c string
		var err error
		if *profile == "fast" {
			c, err = program.EmitCFast()
		} else {
			c, err = program.EmitC()
		}
		if err != nil {
			return err
		}
		if args[0] == "emit-c" {
			fmt.Print(c)
			return nil
		}
		compiler, err := exec.LookPath("gcc")
		if err != nil {
			return fmt.Errorf("native build requires gcc on PATH: %w", err)
		}
		dir, err := os.MkdirTemp("", "swyp-build-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		input := filepath.Join(dir, "program.c")
		if err := os.WriteFile(input, []byte(c), 0600); err != nil {
			return err
		}
		out := *output
		if out == "" {
			out = "swyp-program.exe"
		}
		out, err = filepath.Abs(out)
		if err != nil {
			return err
		}
		srcPath, err := filepath.Abs(rest[0])
		if err != nil {
			return err
		}
		if strings.EqualFold(filepath.Clean(out), filepath.Clean(srcPath)) {
			return fmt.Errorf("output must not replace the source file")
		}
		opt := "-O2"
		if *profile == "fast" {
			opt = "-O3"
		}
		result, err := runNativeCompilerExclusive(compiler, out, "-std=c11", opt, "-ffp-contract=off", input, "-lm")
		if err != nil {
			return fmt.Errorf("C compiler failed: %w\n%s", err, result)
		}
		fmt.Println("Built", out)
		return nil
	}
	var values []float64
	for _, s := range rest[1:] {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
			return fmt.Errorf("invalid numeric argument %q", s)
		}
		values = append(values, v)
	}
	return program.RunArgsIO(os.Stdout, os.Stderr, *steps, values)
}
