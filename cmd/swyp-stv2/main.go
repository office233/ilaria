// swyp-stv2 is the experimental Swyp safe-integer backend CLI.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"

	vm "swyp-lang/experiments/ternaryvm"
	"swyp-lang/internal/swyplang"
)

func run(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("swyp-stv2", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	fuel := flags.Int("steps", vm.MaxFuel, "maximum executed STV2 instructions")
	output := flags.String("o", "", "optional new STV2 bytecode file")
	if e := flags.Parse(args); e != nil {
		return e
	}
	rest := flags.Args()
	if len(rest) < 1 {
		return fmt.Errorf("usage: swyp-stv2 [-steps N] [-o new.stv2] source.swyp [integer arguments]")
	}
	if *fuel < 1 || *fuel > vm.MaxFuel {
		return fmt.Errorf("steps must be 1..%d", vm.MaxFuel)
	}
	f, e := os.Open(rest[0])
	if e != nil {
		return e
	}
	source, readErr := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	closeErr := f.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	if len(source) > 1<<20 {
		return fmt.Errorf("source exceeds 1 MiB limit")
	}
	p, e := swyplang.Parse(rest[0], string(source))
	if e != nil {
		return e
	}
	module, e := p.CompileSTV2()
	if e != nil {
		return e
	}
	if len(rest)-1 != module.ArgumentCount() {
		return fmt.Errorf("expected %d integer arguments", module.ArgumentCount())
	}
	inputs := make([]int64, len(rest)-1)
	for i, s := range rest[1:] {
		inputs[i], e = strconv.ParseInt(s, 10, 64)
		if e != nil {
			return fmt.Errorf("argument %d must be a decimal int64", i)
		}
	}
	result, e := module.Run(inputs, *fuel)
	if e != nil {
		return e
	}
	data := module.Bytecode()
	if *output != "" {
		f, e := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		_, we := f.Write(data)
		ce := f.Close()
		if we != nil {
			_ = os.Remove(*output)
			return we
		}
		if ce != nil {
			_ = os.Remove(*output)
			return ce
		}
	}
	var value any = result.Value
	if module.ResultType() == "bool" {
		value = result.Value == 1
	}
	return json.NewEncoder(out).Encode(struct {
		Format       string `json:"format"`
		Profile      string `json:"profile"`
		ResultType   string `json:"result_type"`
		Value        any    `json:"value"`
		Steps        int    `json:"steps"`
		Instructions int    `json:"instructions"`
		PackedBytes  int    `json:"packed_bytes"`
	}{"STV2", "swyp-safe-integer", module.ResultType(), value, result.Steps, module.InstructionCount(), len(data)})
}
func main() {
	if e := run(os.Args[1:], os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
