package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"swyp-lang/internal/coreir"
)

func coreX64BuildCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("core-x64-build", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	entry := flags.String("entry", "main", "entry function")
	output := flags.String("o", "", "new executable destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp core-x64-build -entry fn -o new.exe file.swyp")
	}
	if _, err := os.Stat(*output); err == nil {
		return fmt.Errorf("output already exists: %s", *output)
	} else if !os.IsNotExist(err) {
		return err
	}
	artifact, err := compileX64CFG(flags.Arg(0), *entry)
	if err != nil {
		return err
	}
	harness, err := x64HarnessC(artifact)
	if err != nil {
		return err
	}
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		return fmt.Errorf("core-x64-build requires gcc as assembler/linker: %w", err)
	}
	dir, err := os.MkdirTemp("", "swyp-x64-build-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	asmPath := filepath.Join(dir, "program.s")
	cPath := filepath.Join(dir, "main.c")
	if err := os.WriteFile(asmPath, artifact.Assembly, 0600); err != nil {
		return err
	}
	if err := os.WriteFile(cPath, []byte(harness), 0600); err != nil {
		return err
	}
	cmd := exec.Command(gcc, "-O1", "-fno-lto", asmPath, cPath, "-o", *output)
	if result, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("x64 assembler/linker failed: %w\n%s", err, result)
	}
	fmt.Fprintf(out, "Built direct x86-64 %s (%s)\n", *output, coreir.X64CFGABI)
	return nil
}

func x64HarnessC(artifact x64LeafArtifact) (string, error) {
	if len(artifact.Function.Params) > 4 {
		return "", fmt.Errorf("x64 harness supports at most four parameters")
	}
	cType := func(t coreir.Type) (string, error) {
		switch t {
		case coreir.I64:
			return "int64_t", nil
		case coreir.U64, coreir.Bool:
			return "uint64_t", nil
		case coreir.F64, coreir.IEEE64:
			return "double", nil
		default:
			return "", fmt.Errorf("x64 harness unsupported type %s", t)
		}
	}
	resultType, err := cType(artifact.Function.Result)
	if err != nil {
		return "", err
	}
	params := make([]string, len(artifact.Function.Params))
	args := make([]string, len(artifact.Function.Params))
	parsers := make([]string, len(artifact.Function.Params))
	for i, p := range artifact.Function.Params {
		t, err := cType(p.Type)
		if err != nil {
			return "", err
		}
		params[i] = fmt.Sprintf("%s p%d", t, i)
		args[i] = fmt.Sprintf("p%d", i)
		switch p.Type {
		case coreir.I64:
			parsers[i] = fmt.Sprintf("int64_t p%d=(int64_t)strtoll(argv[%d],0,10);", i, i+1)
		case coreir.U64:
			parsers[i] = fmt.Sprintf("uint64_t p%d=(uint64_t)strtoull(argv[%d],0,10);", i, i+1)
		case coreir.Bool:
			parsers[i] = fmt.Sprintf("uint64_t p%d=(strcmp(argv[%d],\"true\")==0||strcmp(argv[%d],\"1\")==0);", i, i+1, i+1)
		case coreir.F64, coreir.IEEE64:
			parsers[i] = fmt.Sprintf("double p%d=strtod(argv[%d],0);", i, i+1)
		}
	}
	prototypeArgs := append([]string{}, params...)
	prototypeArgs = append(prototypeArgs, "uint64_t *status")
	callArgs := append([]string{}, args...)
	callArgs = append(callArgs, "&status")

	var b strings.Builder
	b.WriteString("#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n")
	fmt.Fprintf(&b, "extern %s %s(%s);\n", resultType, artifact.Symbol, strings.Join(prototypeArgs, ","))
	b.WriteString("int main(int argc,char**argv){\n")
	fmt.Fprintf(&b, "  if(argc!=%d)return 2;\n", len(params)+1)
	for _, parser := range parsers {
		fmt.Fprintf(&b, "  %s\n", parser)
	}
	b.WriteString("  uint64_t status=0;\n")
	fmt.Fprintf(&b, "  %s value=%s(%s);\n", resultType, artifact.Symbol, strings.Join(callArgs, ","))
	b.WriteString("  if(status!=0){fprintf(stderr,\"backend-status=%llu\\n\",(unsigned long long)status);return 1;}\n")
	switch artifact.Function.Result {
	case coreir.I64:
		b.WriteString("  printf(\"%lld\\n\",(long long)value);\n")
	case coreir.U64:
		b.WriteString("  printf(\"%llu\\n\",(unsigned long long)value);\n")
	case coreir.Bool:
		b.WriteString("  printf(\"%s\\n\",value?\"true\":\"false\");\n")
	case coreir.F64, coreir.IEEE64:
		b.WriteString("  printf(\"%.17g\\n\",value);\n")
	}
	b.WriteString("  return 0;\n}\n")
	return b.String(), nil
}
