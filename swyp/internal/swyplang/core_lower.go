package swyplang

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"text/scanner"

	"swyp-lang/internal/coreir"
)

func coreLocation(p scanner.Position) coreir.Location {
	return coreir.Location{File: p.Filename, Line: p.Line, Column: p.Column}
}
func coreFail(p scanner.Position, format string, args ...any) {
	panic(&coreir.Diagnostic{Code: "core_lowering", Message: fmt.Sprintf(format, args...), Location: coreLocation(p)})
}
func coreType(name string, fallback coreir.Type, pos scanner.Position) coreir.Type {
	switch name {
	case "":
		return fallback
	case "number", "f64":
		return coreir.F64
	case "i64":
		return coreir.I64
	case "bool":
		return coreir.Bool
	case "void":
		return coreir.Void
	default:
		coreFail(pos, "core v1 does not support type %s", name)
	}
	return ""
}

type coreSignature struct {
	params []coreir.Parameter
	result coreir.Type
}
type coreScope struct {
	slots  map[string]int
	parent *coreScope
}

func (s *coreScope) lookup(name string, pos scanner.Position) int {
	for p := s; p != nil; p = p.parent {
		if slot, ok := p.slots[name]; ok {
			return slot
		}
	}
	coreFail(pos, "unknown variable %q", name)
	return -1
}

// CoreIR lowers the selected entry and its transitive callees, not unrelated
// functions. Core v1 accepts pure scalar functions, typed locals, control flow
// and calls. Parameters must be annotated; unannotated numeric results are f64.
// number stays finite binary64. i64 is opt-in and is never lowered via float64.
func (p *Program) CoreIR(entry string) (module coreir.Module, err error) {
	defer func() {
		if r := recover(); r != nil {
			if d, ok := r.(*coreir.Diagnostic); ok {
				module = coreir.Module{}
				err = d
			} else {
				panic(r)
			}
		}
	}()
	if p == nil {
		return coreir.Module{}, fmt.Errorf("nil source program")
	}
	selected := map[string]bool{}
	var visit func(string, scanner.Position)
	visit = func(name string, pos scanner.Position) {
		if selected[name] {
			return
		}
		f, ok := p.functions[name]
		if !ok {
			coreFail(pos, "unknown function or unsupported effect/builtin %q", name)
		}
		if len(selected) >= coreir.MaxFunctions {
			coreFail(pos, "core function limit exceeded")
		}
		selected[name] = true
		var exprCalls func(*expr)
		exprCalls = func(e *expr) {
			if e == nil {
				return
			}
			if e.kind == "call" {
				visit(e.name, e.pos)
			}
			for _, a := range e.args {
				exprCalls(a)
			}
		}
		var walk func([]*stmt)
		walk = func(body []*stmt) {
			for _, s := range body {
				exprCalls(s.value)
				walk(s.body)
				walk(s.other)
			}
		}
		walk(f.body)
	}
	visit(entry, scanner.Position{})
	order := make([]string, 0, len(selected))
	for name := range selected {
		order = append(order, name)
	}
	sort.Strings(order)
	signatures := map[string]coreSignature{}
	for _, name := range order {
		f := p.functions[name]
		sig := coreSignature{}
		if len(f.params) > 16 {
			coreFail(f.pos, "core accepts at most 16 parameters")
		}
		for i, n := range f.params {
			if f.annotations[i] == "" {
				coreFail(f.pos, "core parameter %s needs an explicit type", n)
			}
			sig.params = append(sig.params, coreir.Parameter{Name: n, Type: coreType(f.annotations[i], "", f.pos)})
		}
		fallback := coreir.Void
		if hasReturn(f.body) {
			fallback = coreir.F64
		}
		sig.result = coreType(f.result, fallback, f.pos)
		if sig.result != coreir.Void && !returns(f.body) {
			coreFail(f.pos, "function %s may finish without returning a value", name)
		}
		signatures[name] = sig
	}
	module.Version = coreir.Version
	for _, name := range order {
		f, sig := p.functions[name], signatures[name]
		b := coreBuilder{f: coreir.Function{Name: name, Params: sig.params, Result: sig.result}, signatures: signatures}
		b.current = b.newBlock(f.pos)
		env := &coreScope{slots: map[string]int{}}
		for _, param := range sig.params {
			env.slots[param.Name] = b.slot(param.Type, f.pos)
		}
		b.block(f.body, env)
		if !b.closed() {
			op := "return"
			if sig.result != coreir.Void {
				op = "unreachable"
			}
			b.terminate(coreir.Terminator{Op: op, Value: -1, Location: coreLocation(f.pos)})
		}
		module.Functions = append(module.Functions, b.f)
	}
	if err := module.Validate(); err != nil {
		return coreir.Module{}, err
	}
	return module, nil
}

type coreBuilder struct {
	f                     coreir.Function
	signatures            map[string]coreSignature
	current, instructions int
}

func (b *coreBuilder) slot(t coreir.Type, pos scanner.Position) int {
	if t != coreir.I64 && t != coreir.F64 && t != coreir.Bool {
		coreFail(pos, "void or unsupported value")
	}
	if len(b.f.Slots) >= coreir.MaxSlots {
		coreFail(pos, "core slot limit exceeded")
	}
	i := len(b.f.Slots)
	b.f.Slots = append(b.f.Slots, t)
	return i
}
func (b *coreBuilder) newBlock(pos scanner.Position) int {
	if len(b.f.Blocks) >= coreir.MaxBlocks {
		coreFail(pos, "core block limit exceeded")
	}
	i := len(b.f.Blocks)
	b.f.Blocks = append(b.f.Blocks, coreir.Block{})
	return i
}
func (b *coreBuilder) closed() bool { return b.f.Blocks[b.current].Terminator.Op != "" }
func (b *coreBuilder) emit(ins coreir.Instruction) {
	b.instructions++
	if b.instructions > coreir.MaxInstructions {
		coreFail(scanner.Position{}, "core instruction limit exceeded")
	}
	b.f.Blocks[b.current].Instructions = append(b.f.Blocks[b.current].Instructions, ins)
}
func (b *coreBuilder) terminate(t coreir.Terminator) { b.f.Blocks[b.current].Terminator = t }
func (b *coreBuilder) jump(target int, pos scanner.Position) {
	b.terminate(coreir.Terminator{Op: "jump", Value: -1, Targets: []int{target}, Location: coreLocation(pos)})
}
func (b *coreBuilder) valueType(slot int, pos scanner.Position) coreir.Type {
	if slot < 0 {
		coreFail(pos, "void call cannot be used as a value")
	}
	return b.f.Slots[slot]
}
func (b *coreBuilder) constant(t coreir.Type, text string, pos scanner.Position) int {
	v, err := coreir.ParseValue(t, text)
	if err != nil {
		coreFail(pos, "%v", err)
	}
	literal := v.Literal()
	dest := b.slot(t, pos)
	b.emit(coreir.Instruction{Op: "const", Dest: dest, Constant: &literal, Location: coreLocation(pos)})
	return dest
}
func (b *coreBuilder) move(dest, src int, pos scanner.Position) {
	if b.valueType(src, pos) != b.f.Slots[dest] {
		coreFail(pos, "assignment type mismatch")
	}
	b.emit(coreir.Instruction{Op: "move", Dest: dest, Args: []int{src}, Location: coreLocation(pos)})
}
func (b *coreBuilder) block(body []*stmt, parent *coreScope) {
	env := &coreScope{slots: map[string]int{}, parent: parent}
	for _, s := range body {
		// Continue checking dead source in a disconnected block. No declarations
		// or bad types after return are silently skipped.
		if b.closed() {
			b.current = b.newBlock(s.pos)
		}
		switch s.kind {
		case "let":
			if _, ok := env.slots[s.name]; ok {
				coreFail(s.pos, "duplicate variable %q", s.name)
			}
			want := coreType(s.annotation, "", s.pos)
			v := b.expression(s.value, env, want)
			dest := b.slot(b.valueType(v, s.pos), s.pos)
			b.move(dest, v, s.pos)
			env.slots[s.name] = dest
		case "assign":
			dest := env.lookup(s.name, s.pos)
			v := b.expression(s.value, env, b.f.Slots[dest])
			b.move(dest, v, s.pos)
		case "expr":
			b.expression(s.value, env, "")
		case "return":
			if b.f.Result == coreir.Void {
				coreFail(s.pos, "void function cannot return a value")
			}
			v := b.expression(s.value, env, b.f.Result)
			b.terminate(coreir.Terminator{Op: "return", Value: v, Location: coreLocation(s.pos)})
		case "if":
			v := b.expression(s.value, env, coreir.Bool)
			yes, no, join := b.newBlock(s.pos), b.newBlock(s.pos), b.newBlock(s.pos)
			b.terminate(coreir.Terminator{Op: "branch", Value: v, Targets: []int{yes, no}, Location: coreLocation(s.pos)})
			b.current = yes
			b.block(s.body, env)
			if !b.closed() {
				b.jump(join, s.pos)
			}
			b.current = no
			b.block(s.other, env)
			if !b.closed() {
				b.jump(join, s.pos)
			}
			b.current = join
		case "while":
			head, body, end := b.newBlock(s.pos), b.newBlock(s.pos), b.newBlock(s.pos)
			b.jump(head, s.pos)
			b.current = head
			v := b.expression(s.value, env, coreir.Bool)
			b.terminate(coreir.Terminator{Op: "branch", Value: v, Targets: []int{body, end}, Location: coreLocation(s.pos)})
			b.current = body
			b.block(s.body, env)
			if !b.closed() {
				b.jump(head, s.pos)
			}
			b.current = end
		default:
			coreFail(s.pos, "unsupported statement %s", s.kind)
		}
	}
}
func (b *coreBuilder) hint(e *expr, env *coreScope) coreir.Type {
	switch e.kind {
	case "literal":
		if _, ok := e.value.(bool); ok {
			return coreir.Bool
		}
	case "variable":
		return b.f.Slots[env.lookup(e.name, e.pos)]
	case "call":
		return b.signatures[e.name].result
	case "unary":
		if e.name == "!" {
			return coreir.Bool
		}
		return b.hint(e.args[0], env)
	case "binary":
		switch e.name {
		case "==", "!=", "<", "<=", ">", ">=", "&&", "||":
			return coreir.Bool
		}
		if t := b.hint(e.args[0], env); t != "" {
			return t
		}
		return b.hint(e.args[1], env)
	}
	return ""
}
func (b *coreBuilder) expression(e *expr, env *coreScope, want coreir.Type) int {
	v := b.expr(e, env, want)
	if want != "" && b.valueType(v, e.pos) != want {
		coreFail(e.pos, "expected %s, got %s; no implicit numeric conversion", want, b.f.Slots[v])
	}
	return v
}
func (b *coreBuilder) expr(e *expr, env *coreScope, want coreir.Type) int {
	switch e.kind {
	case "literal":
		switch x := e.value.(type) {
		case bool:
			return b.constant(coreir.Bool, strconv.FormatBool(x), e.pos)
		case float64:
			t := coreir.F64
			if want == coreir.I64 {
				t = coreir.I64
			}
			text := e.lexeme
			if text == "" {
				text = strconv.FormatFloat(x, 'g', -1, 64)
			}
			if t == coreir.I64 {
				text = strings.ReplaceAll(text, "_", "")
			}
			return b.constant(t, text, e.pos)
		default:
			coreFail(e.pos, "core v1 does not support strings")
		}
	case "variable":
		return env.lookup(e.name, e.pos)
	case "call":
		sig, ok := b.signatures[e.name]
		if !ok || len(e.args) != len(sig.params) {
			coreFail(e.pos, "unknown call or incorrect arity for %s", e.name)
		}
		args := make([]int, len(e.args))
		for i, a := range e.args {
			args[i] = b.expression(a, env, sig.params[i].Type)
		}
		dest := -1
		if sig.result != coreir.Void {
			dest = b.slot(sig.result, e.pos)
		}
		b.emit(coreir.Instruction{Op: "call", Dest: dest, Args: args, Callee: e.name, MayTrap: true, Location: coreLocation(e.pos)})
		return dest
	case "unary":
		t := b.hint(e.args[0], env)
		if t == "" {
			t = want
		}
		if t == "" {
			t = coreir.F64
		}
		if e.name == "!" {
			t = coreir.Bool
		}
		if e.name == "-" && t == coreir.I64 && e.args[0].kind == "literal" {
			if _, ok := e.args[0].value.(float64); ok {
				return b.constant(coreir.I64, "-"+strings.ReplaceAll(e.args[0].lexeme, "_", ""), e.pos)
			}
		}
		v := b.expression(e.args[0], env, t)
		op := "neg"
		if e.name == "!" {
			op = "not"
		} else if t != coreir.I64 && t != coreir.F64 {
			coreFail(e.pos, "negation requires a number")
		}
		dest := b.slot(t, e.pos)
		b.emit(coreir.Instruction{Op: op, Dest: dest, Args: []int{v}, MayTrap: op == "neg" && t == coreir.I64, Location: coreLocation(e.pos)})
		return dest
	case "binary":
		if e.name == "&&" || e.name == "||" {
			left := b.expression(e.args[0], env, coreir.Bool)
			dest := b.slot(coreir.Bool, e.pos)
			rhs, short, join := b.newBlock(e.pos), b.newBlock(e.pos), b.newBlock(e.pos)
			targets := []int{rhs, short}
			if e.name == "||" {
				targets = []int{short, rhs}
			}
			b.terminate(coreir.Terminator{Op: "branch", Value: left, Targets: targets, Location: coreLocation(e.pos)})
			b.current = short
			b.move(dest, left, e.pos)
			b.jump(join, e.pos)
			b.current = rhs
			right := b.expression(e.args[1], env, coreir.Bool)
			b.move(dest, right, e.pos)
			b.jump(join, e.pos)
			b.current = join
			return dest
		}
		t := b.hint(e.args[0], env)
		if t == "" {
			t = b.hint(e.args[1], env)
		}
		if t != coreir.I64 && t != coreir.F64 {
			t = want
		}
		if t != coreir.I64 && t != coreir.F64 {
			t = coreir.F64
		}
		// Numeric context types untyped literals, never a differently typed value.
		left := b.expr(e.args[0], env, t)
		right := b.expr(e.args[1], env, t)
		lt, rt := b.valueType(left, e.pos), b.valueType(right, e.pos)
		ops := map[string]string{"+": "add", "-": "sub", "*": "mul", "/": "div", "%": "rem", "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge"}
		op := ops[e.name]
		if op == "" {
			coreFail(e.pos, "unsupported operator %s", e.name)
		}
		result, trap := lt, true
		if op == "eq" || op == "ne" {
			result, trap = coreir.Bool, false
		} else {
			if lt != rt || (lt != coreir.I64 && lt != coreir.F64) {
				coreFail(e.pos, "numeric operands must have the same type")
			}
			if op == "lt" || op == "le" || op == "gt" || op == "ge" {
				result, trap = coreir.Bool, false
			}
		}
		dest := b.slot(result, e.pos)
		b.emit(coreir.Instruction{Op: op, Dest: dest, Args: []int{left, right}, MayTrap: trap, Location: coreLocation(e.pos)})
		return dest
	}
	coreFail(e.pos, "unsupported expression %s", e.kind)
	return -1
}
