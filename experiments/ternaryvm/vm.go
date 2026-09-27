// Package ternaryvm defines a deterministic, bounded ternary bytecode machine.
package ternaryvm

import (
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const MaxInstructions = 4096
const MaxFuel = 1000000
const tritsPerInstruction = 27

type Op uint8

const (
	Nop Op = iota
	Const
	Mov
	Add
	Sub
	Eq
	Jz
	Jmp
	Halt
)

type Instruction struct {
	Op        Op
	A, B      uint8
	Immediate int32
}
type Program []Instruction
type Result struct {
	Value     int64
	Steps     int
	Registers [8]int64
}

func (p Program) Validate() error {
	if len(p) == 0 || len(p) > MaxInstructions {
		return fmt.Errorf("instruction count must be 1..%d", MaxInstructions)
	}
	for pc, i := range p {
		if i.Op > Halt || i.A >= 8 || i.B >= 8 {
			return fmt.Errorf("invalid opcode/register at %d", pc)
		}
		if (i.Op == Jz || i.Op == Jmp) && (i.Immediate < 0 || int(i.Immediate) >= len(p)) {
			return fmt.Errorf("invalid jump at %d", pc)
		}
		switch i.Op {
		case Nop:
			if i.A != 0 || i.B != 0 || i.Immediate != 0 {
				return fmt.Errorf("noncanonical nop")
			}
		case Const, Jz:
			if i.B != 0 {
				return fmt.Errorf("unused B must be zero")
			}
		case Mov, Add, Sub, Eq:
			if i.Immediate != 0 {
				return fmt.Errorf("unused immediate must be zero")
			}
		case Jmp:
			if i.A != 0 || i.B != 0 {
				return fmt.Errorf("unused registers must be zero")
			}
		case Halt:
			if i.B != 0 || i.Immediate != 0 {
				return fmt.Errorf("unused halt fields must be zero")
			}
		}
	}
	return nil
}

// Assemble accepts one instruction per line, decimal operands, and # comments.
// Jump targets are zero-based instruction indices (not source line numbers).
func Assemble(source string) (Program, error) {
	if len(source) > 1<<20 {
		return nil, fmt.Errorf("source too large")
	}
	var p Program
	names := map[string]Op{"nop": Nop, "const": Const, "mov": Mov, "add": Add, "sub": Sub, "eq": Eq, "jz": Jz, "jmp": Jmp, "halt": Halt}
	for line, s := range strings.Split(source, "\n") {
		f := strings.Fields(strings.SplitN(s, "#", 2)[0])
		if len(f) == 0 {
			continue
		}
		op, ok := names[f[0]]
		if !ok {
			return nil, fmt.Errorf("line %d: unknown opcode", line+1)
		}
		want := 3
		if op == Nop {
			want = 1
		}
		if op == Jmp || op == Halt {
			want = 2
		}
		if len(f) != want {
			return nil, fmt.Errorf("line %d: wrong operand count", line+1)
		}
		ins := Instruction{Op: op}
		reg := func(s string) (uint8, error) {
			if len(s) != 2 || s[0] != 'r' || s[1] < '0' || s[1] > '7' {
				return 0, fmt.Errorf("invalid register %q", s)
			}
			return s[1] - '0', nil
		}
		var err error
		if op != Nop && op != Jmp {
			ins.A, err = reg(f[1])
			if err != nil {
				return nil, err
			}
		}
		if op == Mov || op == Add || op == Sub || op == Eq {
			ins.B, err = reg(f[2])
			if err != nil {
				return nil, err
			}
		}
		if op == Const || op == Jz || op == Jmp {
			idx := 2
			if op == Jmp {
				idx = 1
			}
			v, e := strconv.ParseInt(f[idx], 10, 32)
			if e != nil {
				return nil, e
			}
			ins.Immediate = int32(v)
		}
		p = append(p, ins)
	}
	return p, p.Validate()
}

// Encode uses two trits each for opcode/A/B and 21 for the biased int32 immediate.
// Logical trits -1,0,+1 are stored as base-3 digits 0,1,2; five digits per byte.
func Encode(p Program) ([]byte, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	out := make([]byte, 8+(len(p)*tritsPerInstruction+4)/5)
	copy(out, "STV1")
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(p)))
	k := 0
	put := func(value uint64, n int) {
		for j := 0; j < n; j++ {
			power := byte(1)
			for m := 0; m < k%5; m++ {
				power *= 3
			}
			out[8+k/5] += byte(value%3) * power
			value /= 3
			k++
		}
	}
	for _, i := range p {
		put(uint64(i.Op), 2)
		put(uint64(i.A), 2)
		put(uint64(i.B), 2)
		put(uint64(int64(i.Immediate)+(1<<31)), 21)
	}
	return out, nil
}

func Decode(data []byte) (Program, error) {
	if len(data) < 8 || string(data[:4]) != "STV1" {
		return nil, fmt.Errorf("invalid header")
	}
	n := int(binary.LittleEndian.Uint32(data[4:8]))
	if n < 1 || n > MaxInstructions || len(data) != 8+(n*tritsPerInstruction+4)/5 {
		return nil, fmt.Errorf("invalid bytecode length")
	}
	for _, b := range data[8:] {
		if b >= 243 {
			return nil, fmt.Errorf("invalid packed trits")
		}
	}
	k := 0
	get := func(count int) uint64 {
		var value, power uint64 = 0, 1
		for j := 0; j < count; j++ {
			b := data[8+k/5]
			for m := 0; m < k%5; m++ {
				b /= 3
			}
			value += uint64(b%3) * power
			power *= 3
			k++
		}
		return value
	}
	p := make(Program, n)
	for j := range p {
		p[j].Op = Op(get(2))
		p[j].A = uint8(get(2))
		p[j].B = uint8(get(2))
		v := get(21)
		if v > math.MaxUint32 {
			return nil, fmt.Errorf("immediate out of range")
		}
		p[j].Immediate = int32(int64(v) - (1 << 31))
	}
	for k%5 != 0 {
		if get(1) != 0 {
			return nil, fmt.Errorf("nonzero padding")
		}
	}
	return p, p.Validate()
}

func Run(p Program, initial [8]int64, fuel int) (Result, error) {
	var result Result
	if err := p.Validate(); err != nil {
		return result, err
	}
	if fuel < 1 || fuel > MaxFuel {
		return result, fmt.Errorf("fuel must be 1..%d", MaxFuel)
	}
	r := initial
	pc := 0
	for step := 1; step <= fuel; step++ {
		if pc < 0 || pc >= len(p) {
			return Result{}, fmt.Errorf("program fell off end")
		}
		i := p[pc]
		pc++
		a, b := r[i.A], r[i.B]
		switch i.Op {
		case Nop:
		case Const:
			r[i.A] = int64(i.Immediate)
		case Mov:
			r[i.A] = b
		case Add:
			if (b > 0 && a > math.MaxInt64-b) || (b < 0 && a < math.MinInt64-b) {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = a + b
		case Sub:
			if (b < 0 && a > math.MaxInt64+b) || (b > 0 && a < math.MinInt64+b) {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = a - b
		case Eq:
			r[i.A] = 0
			if a == b {
				r[i.A] = 1
			}
		case Jz:
			if a == 0 {
				pc = int(i.Immediate)
			}
		case Jmp:
			pc = int(i.Immediate)
		case Halt:
			return Result{r[i.A], step, r}, nil
		}
	}
	return Result{}, fmt.Errorf("execution fuel exhausted")
}
