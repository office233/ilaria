package ternaryvm

import (
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode"
)

const v2TritsPerInstruction = 28

// V2Op is the three-trit opcode space used by STV2. All 27 values are assigned.
type V2Op uint8

const (
	V2Nop V2Op = iota
	V2Const
	V2Mov
	V2Add
	V2Sub
	V2Mul
	V2Div
	V2Mod
	V2Eq
	V2Ne
	V2Lt
	V2Le
	V2Gt
	V2Ge
	V2Neg
	V2Abs
	V2Min
	V2Max
	V2BitAnd
	V2BitOr
	V2BitXor
	V2BitNot
	V2Jz
	V2Jnz
	V2Jmp
	V2Addi
	V2Halt
)

type V2Instruction struct {
	Op        V2Op
	A, B      uint8
	Immediate int32
}

type V2Program []V2Instruction

func (p V2Program) Validate() error {
	if len(p) == 0 || len(p) > MaxInstructions {
		return fmt.Errorf("instruction count must be 1..%d", MaxInstructions)
	}
	for pc, i := range p {
		if i.Op > V2Halt || i.A >= 8 || i.B >= 8 {
			return fmt.Errorf("invalid opcode/register at %d", pc)
		}
		if (i.Op == V2Jz || i.Op == V2Jnz || i.Op == V2Jmp) && (i.Immediate < 0 || int(i.Immediate) >= len(p)) {
			return fmt.Errorf("invalid jump at %d", pc)
		}
		switch i.Op {
		case V2Nop:
			if i.A != 0 || i.B != 0 || i.Immediate != 0 {
				return fmt.Errorf("noncanonical nop")
			}
		case V2Const, V2Addi, V2Jz, V2Jnz:
			if i.B != 0 {
				return fmt.Errorf("unused B must be zero at %d", pc)
			}
		case V2Mov, V2Add, V2Sub, V2Mul, V2Div, V2Mod, V2Eq, V2Ne, V2Lt, V2Le, V2Gt, V2Ge, V2Min, V2Max, V2BitAnd, V2BitOr, V2BitXor:
			if i.Immediate != 0 {
				return fmt.Errorf("unused immediate must be zero at %d", pc)
			}
		case V2Neg, V2Abs, V2BitNot, V2Halt:
			if i.B != 0 || i.Immediate != 0 {
				return fmt.Errorf("unused fields must be zero at %d", pc)
			}
		case V2Jmp:
			if i.A != 0 || i.B != 0 {
				return fmt.Errorf("unused registers must be zero at %d", pc)
			}
		}
	}
	return nil
}

type v2AsmLine struct {
	line int
	text string
}

func validV2Label(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		if r != '_' && !unicode.IsLetter(r) && !(i > 0 && unicode.IsDigit(r)) {
			return false
		}
	}
	return true
}

// AssembleV2 accepts labels, one instruction per line, decimal operands and # comments.
// Labels resolve to zero-based instruction indices. Numeric jump targets remain accepted.
func AssembleV2(source string) (V2Program, error) {
	if len(source) > 1<<20 {
		return nil, fmt.Errorf("source too large")
	}
	labels := map[string]int{}
	var lines []v2AsmLine
	pc := 0
	for n, raw := range strings.Split(source, "
") {
		text := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if text == "" {
			continue
		}
		if idx := strings.IndexByte(text, ':'); idx >= 0 {
			name := strings.TrimSpace(text[:idx])
			if !validV2Label(name) {
				return nil, fmt.Errorf("line %d: invalid label %q", n+1, name)
			}
			if _, exists := labels[name]; exists {
				return nil, fmt.Errorf("line %d: duplicate label %q", n+1, name)
			}
			labels[name] = pc
			text = strings.TrimSpace(text[idx+1:])
			if text == "" {
				continue
			}
			if strings.Contains(text, ":") {
				return nil, fmt.Errorf("line %d: multiple labels are not allowed", n+1)
			}
		}
		lines = append(lines, v2AsmLine{line: n + 1, text: text})
		pc++
	}
	if len(lines) == 0 {
		return nil, fmt.Errorf("instruction count must be 1..%d", MaxInstructions)
	}
	if len(lines) > MaxInstructions {
		return nil, fmt.Errorf("instruction count must be 1..%d", MaxInstructions)
	}

	names := map[string]V2Op{
		"nop": V2Nop, "const": V2Const, "mov": V2Mov, "add": V2Add, "sub": V2Sub,
		"mul": V2Mul, "div": V2Div, "mod": V2Mod, "eq": V2Eq, "ne": V2Ne,
		"lt": V2Lt, "le": V2Le, "gt": V2Gt, "ge": V2Ge, "neg": V2Neg,
		"abs": V2Abs, "min": V2Min, "max": V2Max, "and": V2BitAnd, "or": V2BitOr,
		"xor": V2BitXor, "not": V2BitNot, "jz": V2Jz, "jnz": V2Jnz, "jmp": V2Jmp,
		"addi": V2Addi, "halt": V2Halt,
	}
	reg := func(s string) (uint8, error) {
		if len(s) != 2 || s[0] != 'r' || s[1] < '0' || s[1] > '7' {
			return 0, fmt.Errorf("invalid register %q", s)
		}
		return s[1] - '0', nil
	}
	resolveTarget := func(s string) (int32, error) {
		if v, err := strconv.ParseInt(s, 10, 32); err == nil {
			return int32(v), nil
		}
		v, ok := labels[s]
		if !ok {
			return 0, fmt.Errorf("unknown label %q", s)
		}
		return int32(v), nil
	}

	p := make(V2Program, 0, len(lines))
	for _, src := range lines {
		f := strings.Fields(src.text)
		op, ok := names[f[0]]
		if !ok {
			return nil, fmt.Errorf("line %d: unknown opcode %q", src.line, f[0])
		}
		want := 3
		switch op {
		case V2Nop:
			want = 1
		case V2Jmp, V2Neg, V2Abs, V2BitNot, V2Halt:
			want = 2
		}
		if len(f) != want {
			return nil, fmt.Errorf("line %d: wrong operand count", src.line)
		}
		ins := V2Instruction{Op: op}
		var err error
		switch op {
		case V2Nop, V2Jmp:
		default:
			ins.A, err = reg(f[1])
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", src.line, err)
			}
		}
		switch op {
		case V2Mov, V2Add, V2Sub, V2Mul, V2Div, V2Mod, V2Eq, V2Ne, V2Lt, V2Le, V2Gt, V2Ge, V2Min, V2Max, V2BitAnd, V2BitOr, V2BitXor:
			ins.B, err = reg(f[2])
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", src.line, err)
			}
		case V2Const, V2Addi:
			v, e := strconv.ParseInt(f[2], 10, 32)
			if e != nil {
				return nil, fmt.Errorf("line %d: invalid immediate %q", src.line, f[2])
			}
			ins.Immediate = int32(v)
		case V2Jz, V2Jnz:
			ins.Immediate, err = resolveTarget(f[2])
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", src.line, err)
			}
		case V2Jmp:
			ins.Immediate, err = resolveTarget(f[1])
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", src.line, err)
			}
		}
		p = append(p, ins)
	}
	return p, p.Validate()
}

// EncodeV2 stores STV2 instructions as 28 trits: opcode(3), A(2), B(2), immediate(21).
// Five trits are packed into one byte. The int32 immediate uses the same 2^31 bias as STV1.
func EncodeV2(p V2Program) ([]byte, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	out := make([]byte, 8+(len(p)*v2TritsPerInstruction+4)/5)
	copy(out, "STV2")
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
		put(uint64(i.Op), 3)
		put(uint64(i.A), 2)
		put(uint64(i.B), 2)
		put(uint64(int64(i.Immediate)+(1<<31)), 21)
	}
	return out, nil
}

func DecodeV2(data []byte) (V2Program, error) {
	if len(data) < 8 || string(data[:4]) != "STV2" {
		return nil, fmt.Errorf("invalid STV2 header")
	}
	n := int(binary.LittleEndian.Uint32(data[4:8]))
	if n < 1 || n > MaxInstructions || len(data) != 8+(n*v2TritsPerInstruction+4)/5 {
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
	p := make(V2Program, n)
	for j := range p {
		p[j].Op = V2Op(get(3))
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

func checkedAddV2(a, b int64) (int64, bool) {
	if (b > 0 && a > math.MaxInt64-b) || (b < 0 && a < math.MinInt64-b) {
		return 0, false
	}
	return a + b, true
}

func checkedSubV2(a, b int64) (int64, bool) {
	if (b < 0 && a > math.MaxInt64+b) || (b > 0 && a < math.MinInt64+b) {
		return 0, false
	}
	return a - b, true
}

func checkedMulV2(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	if (a == math.MinInt64 && b == -1) || (b == math.MinInt64 && a == -1) {
		return 0, false
	}
	v := a * b
	if v/b != a {
		return 0, false
	}
	return v, true
}

func boolIntV2(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

// RunV2 executes STV2 deterministically using checked signed arithmetic.
func RunV2(p V2Program, initial [8]int64, fuel int) (Result, error) {
	if err := p.Validate(); err != nil {
		return Result{}, err
	}
	if fuel < 1 || fuel > MaxFuel {
		return Result{}, fmt.Errorf("fuel must be 1..%d", MaxFuel)
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
		case V2Nop:
		case V2Const:
			r[i.A] = int64(i.Immediate)
		case V2Mov:
			r[i.A] = b
		case V2Add:
			v, ok := checkedAddV2(a, b)
			if !ok {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = v
		case V2Sub:
			v, ok := checkedSubV2(a, b)
			if !ok {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = v
		case V2Mul:
			v, ok := checkedMulV2(a, b)
			if !ok {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = v
		case V2Div:
			if b == 0 {
				return Result{}, fmt.Errorf("division by zero")
			}
			if a == math.MinInt64 && b == -1 {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = a / b
		case V2Mod:
			if b == 0 {
				return Result{}, fmt.Errorf("remainder by zero")
			}
			if a == math.MinInt64 && b == -1 {
				r[i.A] = 0
			} else {
				r[i.A] = a % b
			}
		case V2Eq:
			r[i.A] = boolIntV2(a == b)
		case V2Ne:
			r[i.A] = boolIntV2(a != b)
		case V2Lt:
			r[i.A] = boolIntV2(a < b)
		case V2Le:
			r[i.A] = boolIntV2(a <= b)
		case V2Gt:
			r[i.A] = boolIntV2(a > b)
		case V2Ge:
			r[i.A] = boolIntV2(a >= b)
		case V2Neg:
			if a == math.MinInt64 {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = -a
		case V2Abs:
			if a == math.MinInt64 {
				return Result{}, fmt.Errorf("integer overflow")
			}
			if a < 0 {
				r[i.A] = -a
			}
		case V2Min:
			if b < a {
				r[i.A] = b
			}
		case V2Max:
			if b > a {
				r[i.A] = b
			}
		case V2BitAnd:
			r[i.A] = a & b
		case V2BitOr:
			r[i.A] = a | b
		case V2BitXor:
			r[i.A] = a ^ b
		case V2BitNot:
			r[i.A] = ^a
		case V2Jz:
			if a == 0 {
				pc = int(i.Immediate)
			}
		case V2Jnz:
			if a != 0 {
				pc = int(i.Immediate)
			}
		case V2Jmp:
			pc = int(i.Immediate)
		case V2Addi:
			v, ok := checkedAddV2(a, int64(i.Immediate))
			if !ok {
				return Result{}, fmt.Errorf("integer overflow")
			}
			r[i.A] = v
		case V2Halt:
			return Result{Value: r[i.A], Steps: step, Registers: r}, nil
		}
	}
	return Result{}, fmt.Errorf("execution fuel exhausted")
}
