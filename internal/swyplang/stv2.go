package swyplang

import (
	"fmt"
	"math"
	"text/scanner"

	vm "swyp-lang/experiments/ternaryvm"
)

// STV2Module is an immutable compiled safe-integer subset of Swyp.
// It has no host calls. Each Run creates fresh registers; concurrent runs are safe.
// Source must define only main, returning a number or bool. Inputs are arg(0)..arg(3).
// All initial and intermediate numbers must remain within +/- (2^53 - 1).
// Division, strings, clock, print and user calls are deliberately unsupported.
type STV2Module struct {
	code       vm.V2Program
	packed     []byte
	arguments  int
	resultType string
}

func (m *STV2Module) ArgumentCount() int    { return m.arguments }
func (m *STV2Module) ResultType() string    { return m.resultType }
func (m *STV2Module) InstructionCount() int { return len(m.code) }

// Bytecode returns a copy. STV2 itself does not store arity, result type, or the
// exact-integer execution profile; hosts loading these bytes must supply them.
func (m *STV2Module) Bytecode() []byte { return append([]byte(nil), m.packed...) }

func (m *STV2Module) Run(args []int64, fuel int) (vm.Result, error) {
	if m == nil {
		return vm.Result{}, fmt.Errorf("nil STV2 module")
	}
	if len(args) != m.arguments {
		return vm.Result{}, fmt.Errorf("STV2 expects %d arguments, got %d", m.arguments, len(args))
	}
	var initial [8]int64
	copy(initial[:], args)
	return vm.RunV2Exact(m.code, initial, fuel)
}

type stv2CompileError struct{ err error }
type stv2Lowerer struct {
	code      vm.V2Program
	checked   *checked
	used      [8]bool
	scopes    []map[string]uint8
	arguments int
}

func stv2Bad(pos scanner.Position, message string, args ...any) {
	panic(stv2CompileError{failure(pos, "STV2: "+message, args...)})
}

// CompileSTV2 checks the original AST, validates the whole supported subset
// (including unreachable code), lowers to register instructions, and round-trips
// through canonical STV2 bytes before returning an executable module.
func (p *Program) CompileSTV2() (module *STV2Module, err error) {
	if p == nil {
		return nil, fmt.Errorf("nil Swyp program")
	}
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(stv2CompileError); ok {
				module = nil
				err = e.err
			} else {
				panic(r)
			}
		}
	}()
	c, err := p.check()
	if err != nil {
		return nil, err
	}
	f, ok := p.functions["main"]
	if !ok {
		return nil, fmt.Errorf("STV2 requires main")
	}
	if len(p.functions) != 1 {
		return nil, fmt.Errorf("STV2 currently accepts only fn main; user functions are unsupported")
	}
	kind := c.signatures["main"].result.root().mask
	if kind != numType && kind != boolType {
		return nil, fmt.Errorf("STV2 main must return number or bool")
	}
	l := &stv2Lowerer{checked: c}
	l.preflight(f.body)
	// Reserve immutable input registers. Copying arg() prevents assignments to
	// locals from changing later reads of the same external argument.
	for i := 0; i < l.arguments; i++ {
		l.used[i] = true
	}
	l.block(f.body)
	// Branches targeting the end (even unreachable ones) must target an actual
	// instruction. The checker has already established main's return coverage.
	l.emit(vm.V2Instruction{Op: vm.V2Halt}, f.pos)
	packed, err := vm.EncodeV2(l.code)
	if err != nil {
		return nil, err
	}
	decoded, err := vm.DecodeV2(packed)
	if err != nil {
		return nil, err
	}
	return &STV2Module{code: decoded, packed: packed, arguments: l.arguments, resultType: typeLabel(kind)}, nil
}

func stv2Literal(e *expr) (int32, bool) {
	if e.kind == "literal" {
		v, ok := e.value.(float64)
		if ok && !math.IsNaN(v) && !math.IsInf(v, 0) && math.Trunc(v) == v && v >= math.MinInt32 && v <= math.MaxInt32 {
			return int32(v), true
		}
	}
	// The parser stores -2147483648 as unary minus applied to +2147483648.
	if e.kind == "unary" && e.name == "-" && e.args[0].kind == "literal" {
		if v, ok := e.args[0].value.(float64); ok && v == 2147483648 {
			return math.MinInt32, true
		}
	}
	return 0, false
}

func (l *stv2Lowerer) preflight(body []*stmt) {
	for _, s := range body {
		l.checkExpr(s.value)
		l.preflight(s.body)
		l.preflight(s.other)
	}
}

func (l *stv2Lowerer) checkExpr(e *expr) {
	kind := l.checked.expressions[e].root().mask
	if kind != numType && kind != boolType {
		stv2Bad(e.pos, "only numbers and booleans are supported")
	}
	if _, ok := stv2Literal(e); ok {
		return
	}
	switch e.kind {
	case "literal":
		if _, ok := e.value.(bool); !ok {
			stv2Bad(e.pos, "numeric literals must be signed int32 integers")
		}
	case "variable":
	case "call":
		if e.name != "arg" || len(e.args) != 1 {
			stv2Bad(e.pos, "unsupported call %s", e.name)
		}
		index, ok := stv2Literal(e.args[0])
		if !ok || index < 0 || index > 3 {
			stv2Bad(e.pos, "arg index must be a literal 0..3")
		}
		if int(index)+1 > l.arguments {
			l.arguments = int(index) + 1
		}
	case "unary":
		l.checkExpr(e.args[0])
	case "binary":
		if e.name == "/" {
			stv2Bad(e.pos, "/ is unsupported: Swyp division is not integer division")
		}
		l.checkExpr(e.args[0])
		l.checkExpr(e.args[1])
	default:
		stv2Bad(e.pos, "unsupported expression %s", e.kind)
	}
}

func (l *stv2Lowerer) alloc(pos scanner.Position) uint8 {
	for r := range l.used {
		if !l.used[r] {
			l.used[r] = true
			return uint8(r)
		}
	}
	stv2Bad(pos, "register pressure exceeds eight registers; reduce live variables or expression depth")
	return 0
}
func (l *stv2Lowerer) free(r uint8) { l.used[r] = false }
func (l *stv2Lowerer) lookup(name string, pos scanner.Position) uint8 {
	for i := len(l.scopes) - 1; i >= 0; i-- {
		if r, ok := l.scopes[i][name]; ok {
			return r
		}
	}
	stv2Bad(pos, "unknown variable %s", name)
	return 0
}
func (l *stv2Lowerer) emit(i vm.V2Instruction, pos scanner.Position) int {
	if len(l.code) >= vm.MaxInstructions {
		stv2Bad(pos, "instruction limit exceeded")
	}
	pc := len(l.code)
	l.code = append(l.code, i)
	return pc
}
func (l *stv2Lowerer) jump(op vm.V2Op, reg uint8, pos scanner.Position) int {
	return l.emit(vm.V2Instruction{Op: op, A: reg}, pos)
}
func (l *stv2Lowerer) patch(pc int) { l.code[pc].Immediate = int32(len(l.code)) }

func (l *stv2Lowerer) block(body []*stmt) {
	locals := map[string]uint8{}
	l.scopes = append(l.scopes, locals)
	defer func() {
		for _, r := range locals {
			l.free(r)
		}
		l.scopes = l.scopes[:len(l.scopes)-1]
	}()
	for _, s := range body {
		switch s.kind {
		case "let":
			locals[s.name] = l.expression(s.value)
		case "assign":
			r := l.expression(s.value)
			target := l.lookup(s.name, s.pos)
			l.emit(vm.V2Instruction{Op: vm.V2Mov, A: target, B: r}, s.pos)
			l.free(r)
		case "expr":
			l.free(l.expression(s.value))
		case "return":
			r := l.expression(s.value)
			l.emit(vm.V2Instruction{Op: vm.V2Halt, A: r}, s.pos)
			l.free(r)
		case "if":
			r := l.expression(s.value)
			no := l.jump(vm.V2Jz, r, s.pos)
			l.free(r)
			l.block(s.body)
			end := l.jump(vm.V2Jmp, 0, s.pos)
			l.patch(no)
			l.block(s.other)
			l.patch(end)
		case "while":
			start := len(l.code)
			r := l.expression(s.value)
			end := l.jump(vm.V2Jz, r, s.pos)
			l.free(r)
			l.block(s.body)
			l.emit(vm.V2Instruction{Op: vm.V2Jmp, Immediate: int32(start)}, s.pos)
			l.patch(end)
		default:
			stv2Bad(s.pos, "unsupported statement %s", s.kind)
		}
	}
}

// expression always returns an owned temporary, never a live variable register.
func (l *stv2Lowerer) expression(e *expr) uint8 {
	if v, ok := stv2Literal(e); ok {
		r := l.alloc(e.pos)
		l.emit(vm.V2Instruction{Op: vm.V2Const, A: r, Immediate: v}, e.pos)
		return r
	}
	switch e.kind {
	case "literal":
		r := l.alloc(e.pos)
		var v int32
		if e.value.(bool) {
			v = 1
		}
		l.emit(vm.V2Instruction{Op: vm.V2Const, A: r, Immediate: v}, e.pos)
		return r
	case "variable", "call":
		var from uint8
		if e.kind == "variable" {
			from = l.lookup(e.name, e.pos)
		} else {
			v, _ := stv2Literal(e.args[0])
			from = uint8(v)
		}
		r := l.alloc(e.pos)
		l.emit(vm.V2Instruction{Op: vm.V2Mov, A: r, B: from}, e.pos)
		return r
	case "unary":
		r := l.expression(e.args[0])
		if e.name == "-" {
			l.emit(vm.V2Instruction{Op: vm.V2Neg, A: r}, e.pos)
		} else {
			zero := l.alloc(e.pos)
			l.emit(vm.V2Instruction{Op: vm.V2Const, A: zero}, e.pos)
			l.emit(vm.V2Instruction{Op: vm.V2Eq, A: r, B: zero}, e.pos)
			l.free(zero)
		}
		return r
	case "binary":
		left := l.expression(e.args[0])
		if e.name == "&&" || e.name == "||" {
			op := vm.V2Jz
			if e.name == "||" {
				op = vm.V2Jnz
			}
			end := l.jump(op, left, e.pos)
			right := l.expression(e.args[1])
			l.emit(vm.V2Instruction{Op: vm.V2Mov, A: left, B: right}, e.pos)
			l.free(right)
			l.patch(end)
			return left
		}
		right := l.expression(e.args[1])
		if (e.name == "==" || e.name == "!=") && l.checked.expressions[e.args[0]].root().mask != l.checked.expressions[e.args[1]].root().mask {
			// Swyp's true is not the number 1. Both operands still evaluate.
			var v int32
			if e.name == "!=" {
				v = 1
			}
			l.emit(vm.V2Instruction{Op: vm.V2Const, A: left, Immediate: v}, e.pos)
		} else {
			ops := map[string]vm.V2Op{"+": vm.V2Add, "-": vm.V2Sub, "*": vm.V2Mul, "%": vm.V2Mod, "==": vm.V2Eq, "!=": vm.V2Ne, "<": vm.V2Lt, "<=": vm.V2Le, ">": vm.V2Gt, ">=": vm.V2Ge}
			op, ok := ops[e.name]
			if !ok {
				stv2Bad(e.pos, "unsupported operator %s", e.name)
			}
			l.emit(vm.V2Instruction{Op: op, A: left, B: right}, e.pos)
		}
		l.free(right)
		return left
	}
	stv2Bad(e.pos, "unsupported expression %s", e.kind)
	return 0
}
