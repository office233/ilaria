package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"swyp-lang/experiments/ternaryvm"
)

func run() error {
	if len(os.Args) != 2 && len(os.Args) != 3 {
		return fmt.Errorf("usage: ternary-vm source.tasm [initial-r0]")
	}
	f, e := os.Open(os.Args[1])
	if e != nil {
		return e
	}
	defer f.Close()
	data, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if e != nil {
		return e
	}
	p, e := ternaryvm.Assemble(string(data))
	if e != nil {
		return e
	}
	packed, e := ternaryvm.Encode(p)
	if e != nil {
		return e
	}
	decoded, e := ternaryvm.Decode(packed)
	if e != nil {
		return e
	}
	var regs [8]int64
	if len(os.Args) == 3 {
		regs[0], e = strconv.ParseInt(os.Args[2], 10, 64)
		if e != nil {
			return e
		}
	}
	r, e := ternaryvm.Run(decoded, regs, ternaryvm.MaxFuel)
	if e != nil {
		return e
	}
	fmt.Printf("value=%d steps=%d instructions=%d packed_bytes=%d\n", r.Value, r.Steps, len(p), len(packed))
	return nil
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
