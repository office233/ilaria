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

// compileModuleCommand compiles only: no argument values or guest execution are
// needed, and a program that would exhaust fuel may still be compiled.
func compileModuleCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("compile", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	target := flags.String("target", "stv2", "module target (stv2)")
	output := flags.String("o", "", "new .swypb destination (must not exist)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *target != "stv2" {
		return fmt.Errorf("compile: unsupported target %q; only stv2 is supported", *target)
	}
	if flags.NArg() != 1 || *output == "" {
		return fmt.Errorf("usage: swyp compile --target stv2 -o new.swypb source.swyp")
	}
	source, err := readModuleInput(flags.Arg(0), 1<<20)
	if err != nil {
		return err
	}
	p, err := swyplang.Parse(flags.Arg(0), string(source))
	if err != nil {
		return err
	}
	m, err := p.CompileSTV2()
	if err != nil {
		return err
	}
	data, err := m.MarshalBinary()
	if err != nil {
		return err
	}
	if err := writeNewModule(*output, data); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "Compiled %s (%d bytes, STV2)\n", *output, len(data))
	return err
}

func execModuleCommand(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("exec", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	fuel := flags.Int("steps", vm.MaxFuel, "maximum executed STV2 instructions")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() < 1 {
		return fmt.Errorf("usage: swyp exec [-steps N] module.swypb [integer arguments]")
	}
	if *fuel < 1 || *fuel > vm.MaxFuel {
		return fmt.Errorf("exec: steps must be 1..%d", vm.MaxFuel)
	}
	data, err := readModuleInput(flags.Arg(0), swyplang.MaxSWYPBBytes)
	if err != nil {
		return err
	}
	m, err := swyplang.LoadSWYPB(data)
	if err != nil {
		return err
	}
	if flags.NArg()-1 != m.ArgumentCount() {
		return fmt.Errorf("exec: expected %d integer arguments", m.ArgumentCount())
	}
	inputs := make([]int64, m.ArgumentCount())
	for i, s := range flags.Args()[1:] {
		inputs[i], err = strconv.ParseInt(s, 10, 64)
		if err != nil {
			return fmt.Errorf("exec: argument %d must be a decimal int64", i)
		}
	}
	r, err := m.Run(inputs, *fuel)
	if err != nil {
		return err
	}
	var value any = r.Value
	if m.ResultType() == "bool" {
		value = r.Value == 1
	}
	return json.NewEncoder(out).Encode(struct {
		Format       string `json:"format"`
		Version      int    `json:"version"`
		Target       string `json:"target"`
		Profile      string `json:"profile"`
		ResultType   string `json:"result_type"`
		Value        any    `json:"value"`
		Steps        int    `json:"steps"`
		Instructions int    `json:"instructions"`
		ModuleBytes  int    `json:"module_bytes"`
	}{"SWYPB", swyplang.SWYPBVersion, "stv2", "swyp-safe-integer", m.ResultType(), value, r.Steps, m.InstructionCount(), len(data)})
}

func readModuleInput(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("input exceeds %d-byte limit", limit)
	}
	return data, nil
}

// O_EXCL prevents overwriting a source, existing module or symlink. An ordinary
// write/close failure removes the new incomplete file. This is not a guarantee
// of crash-atomic publication; the module checksum rejects truncated files.
func writeNewModule(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	n, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr == nil && n != len(data) {
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
