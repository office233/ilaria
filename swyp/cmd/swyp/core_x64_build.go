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
	if result, err := runNativeCompilerExclusive(gcc, *output, "-O1", "-fno-lto", asmPath, cPath); err != nil {
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
			parsers[i] = fmt.Sprintf("int64_t p%d=swyp_parse_i64(argv[%d]);", i, i+1)
		case coreir.U64:
			parsers[i] = fmt.Sprintf("uint64_t p%d=swyp_parse_u64(argv[%d]);", i, i+1)
		case coreir.Bool:
			parsers[i] = fmt.Sprintf("uint64_t p%d=swyp_parse_bool(argv[%d]);", i, i+1)
		case coreir.F64, coreir.IEEE64:
			finite := 0
			if p.Type == coreir.F64 {
				finite = 1
			}
			parsers[i] = fmt.Sprintf("double p%d=swyp_parse_float(argv[%d],%d);", i, i+1, finite)
		}
	}
	prototypeArgs := append([]string{}, params...)
	prototypeArgs = append(prototypeArgs, "uint64_t *status")
	callArgs := append([]string{}, args...)
	callArgs = append(callArgs, "&status")

	var b strings.Builder
	b.WriteString(x64HarnessArgumentRuntime)
	// Swyp's internal machine ABI is Win64 on every host. GCC on Linux
	// otherwise calls this declaration using SysV registers and stack layout.
	fmt.Fprintf(&b, "extern %s __attribute__((ms_abi)) %s(%s);\n", resultType, artifact.Symbol, strings.Join(prototypeArgs, ","))
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

const x64HarnessArgumentRuntime = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <math.h>
#include <ctype.h>
static void swyp_invalid_arg(void){fputs("invalid typed argument\n",stderr);exit(2);}
static int64_t swyp_parse_i64(const char *s){
  const char *digits=s;if(*digits=='+'||*digits=='-')++digits;
  if(*digits<'0'||*digits>'9')swyp_invalid_arg();
  char *end=NULL;errno=0;long long value=strtoll(s,&end,10);
  if(errno||end==s||*end)swyp_invalid_arg();return (int64_t)value;
}
static uint64_t swyp_parse_u64(const char *s){
  if(*s<'0'||*s>'9')swyp_invalid_arg();
  char *end=NULL;errno=0;unsigned long long value=strtoull(s,&end,10);
  if(errno||end==s||*end)swyp_invalid_arg();return (uint64_t)value;
}
static uint64_t swyp_parse_bool(const char *s){
  if(strcmp(s,"true")==0||strcmp(s,"1")==0)return 1;
  if(strcmp(s,"false")==0||strcmp(s,"0")==0)return 0;
  swyp_invalid_arg();return 0;
}
static double swyp_parse_float(const char *s,int finite){
  if(!*s||isspace((unsigned char)*s))swyp_invalid_arg();
  char *end=NULL;errno=0;double value=strtod(s,&end);
  if((errno&&!(errno==ERANGE&&isfinite(value)))||end==s||*end||(finite&&!isfinite(value)))swyp_invalid_arg();
  return value;
}
`
