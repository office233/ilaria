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
		case "ir", "core-run", "core-exec", "verify":
			return coreCommand(args[0], args[1:], os.Stdout)
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
		fmt.Println("Swyp Lang 0.5.0-experimental (non-LLM refinement, operation graphs, Nexus worker, STV2 ternary VM)")
		return nil
	}
	if len(args) < 2 || (args[0] != "run" && args[0] != "check" && args[0] != "build" && args[0] != "emit-c" && args[0] != "web") {
		return fmt.Errorf("usage: swyp ir [-entry fn] [-o new.json] file.swyp | core-run [-entry fn] file.swyp [typed values] | core-exec [-entry fn] core.json [typed values] | verify -contract contract.json file.swyp | compile --target stv2 -o new.swypb file.swyp | exec [-steps N] module.swypb [integers] | worker < spec.json | synth -o new.swyp spec.json | run [-steps N] file.swyp [numbers] | check file.swyp | build -o app.exe file.swyp | web -o app.html file.swyp | emit-c file.swyp | ternary [-steps N] file.tasm [initial-r0] | draft -prompt task.txt -o new.swyp | expand/repair -o new.swyp [-response fixture] input.swyp | version")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	steps := flags.Int("steps", 1_000_000, "interpreter evaluation budget")
	output := flags.String("o", "", "native executable destination")
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
		file, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, writeErr := file.WriteString(html)
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Println("Created offline web runner", *output)
		return nil
	}
	if args[0] == "build" || args[0] == "emit-c" {
		c, err := program.EmitC()
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
		cmd := exec.Command(compiler, "-std=c11", "-O2", "-ffp-contract=off", input, "-o", out, "-lm")
		result, err := cmd.CombinedOutput()
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
	return program.RunArgs(os.Stdout, *steps, values)
}
