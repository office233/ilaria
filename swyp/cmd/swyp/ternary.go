package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"swyp-lang/internal/stv2"
)

func ternaryCommand(args []string) error {
	flags := flag.NewFlagSet("ternary", flag.ContinueOnError)
	steps := flags.Int("steps", stv2.MaxFuel, "STV2 execution fuel")
	if err := flags.Parse(args); err != nil {
		return err
	}
	rest := flags.Args()
	if len(rest) < 1 || len(rest) > 2 {
		return fmt.Errorf("usage: swyp ternary [-steps N] file.tasm [initial-r0]")
	}
	source, err := os.ReadFile(rest[0])
	if err != nil {
		return err
	}
	if len(source) > 1<<20 {
		return fmt.Errorf("source exceeds 1 MiB limit")
	}
	program, err := stv2.AssembleV2(string(source))
	if err != nil {
		return err
	}
	packed, err := stv2.EncodeV2(program)
	if err != nil {
		return err
	}
	decoded, err := stv2.DecodeV2(packed)
	if err != nil {
		return err
	}
	var registers [8]int64
	if len(rest) == 2 {
		registers[0], err = strconv.ParseInt(rest[1], 10, 64)
		if err != nil {
			return fmt.Errorf("invalid initial r0 %q", rest[1])
		}
	}
	result, err := stv2.RunV2(decoded, registers, *steps)
	if err != nil {
		return err
	}
	fmt.Printf("format=STV2 value=%d steps=%d instructions=%d packed_bytes=%d\n", result.Value, result.Steps, len(program), len(packed))
	return nil
}
