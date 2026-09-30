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
	case "ieee64":
		return coreir.IEEE64
	case "i64":
		return coreir.I64
	case "u64":
		return coreir.U64
	case "bool":
		return coreir.Bool
	case "bytes":
		return coreir.Bytes
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
			if e.kind == "call" && e.name != "print" && e.name != "eprint" && e.name != "clock" && e.name != "random" && e.name != "write_file" && e.name != "read_file" && e.name != "tcp_connect" && e.name != "http_fetch" && e.name != "process_exec" && e.name != "bytes_len" && e.name != "bytes_get" {
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
	arena := coreByteArena{offsets: map[string]uint32{}}
	for _, name := range order {
		f, sig := p.functions[name], signatures[name]
		b := coreBuilder{f: coreir.Function{Name: name, Params: sig.params, Result: sig.result}, signatures: signatures, arena: &arena}
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
	module.Data = append([]byte(nil), arena.data...)
	inferCoreEffects(&module)
	if err := module.Validate(); err != nil {
		return coreir.Module{}, err
	}
	return module, nil
}

type coreBuilder struct {
	f                     coreir.Function
	signatures            map[string]coreSignature
	arena                 *coreByteArena
	current, instructions int
}

type coreByteArena struct {
	data    []byte
	offsets map[string]uint32
}

func (a *coreByteArena) intern(text string, pos scanner.Position) coreir.Value {
	if a == nil {
		coreFail(pos, "core byte arena is unavailable")
	}
	if a.offsets == nil {
		a.offsets = map[string]uint32{}
	}
	if offset, ok := a.offsets[text]; ok {
		v, err := coreir.ByteSpan(offset, uint32(len(text)))
		if err != nil {
			coreFail(pos, "%v", err)
		}
		return v
	}
	if len(a.data)+len(text) > coreir.MaxByteArenaBytes {
		coreFail(pos, "core byte arena exceeds %d bytes", coreir.MaxByteArenaBytes)
	}
	offset := uint32(len(a.data))
	a.data = append(a.data, []byte(text)...)
	a.offsets[text] = offset
	v, err := coreir.ByteSpan(offset, uint32(len(text)))
	if err != nil {
		coreFail(pos, "%v", err)
	}
	return v
}

func (b *coreBuilder) addEffect(effect, capability string) {
	for _, existing := range b.f.Effects {
		if existing == effect {
			return
		}
	}
	b.f.EffectVersion = coreir.EffectVersion
	b.f.Effects = append(b.f.Effects, effect)
	b.f.RequiredCapabilities = append(b.f.RequiredCapabilities, coreir.CapabilityRequirement{
		Name: capability, Effect: effect,
	})
}

func inferCoreEffects(module *coreir.Module) {
	if module == nil {
		return
	}
	byName := make(map[string]int, len(module.Functions))
	for i := range module.Functions {
		byName[module.Functions[i].Name] = i
	}
	for round := 0; round <= len(module.Functions); round++ {
		changed := false
		for fi := range module.Functions {
			f := &module.Functions[fi]
			effects := make(map[string]bool, len(f.Effects))
			caps := make(map[coreir.CapabilityRequirement]bool, len(f.RequiredCapabilities))
			for _, effect := range f.Effects {
				effects[effect] = true
			}
			for _, cap := range f.RequiredCapabilities {
				caps[cap] = true
			}
			for _, block := range f.Blocks {
				for _, ins := range block.Instructions {
					if ins.Op != "call" {
						continue
					}
					ci, ok := byName[ins.Callee]
					if !ok {
						continue
					}
					callee := module.Functions[ci]
					for _, effect := range callee.Effects {
						if !effects[effect] {
							effects[effect] = true
							changed = true
						}
					}
					for _, cap := range callee.RequiredCapabilities {
						if !caps[cap] {
							caps[cap] = true
							changed = true
						}
					}
				}
			}
			f.Effects = f.Effects[:0]
			for effect := range effects {
				f.Effects = append(f.Effects, effect)
			}
			sort.Strings(f.Effects)
			f.RequiredCapabilities = f.RequiredCapabilities[:0]
			for cap := range caps {
				f.RequiredCapabilities = append(f.RequiredCapabilities, cap)
			}
			sort.Slice(f.RequiredCapabilities, func(i, j int) bool {
				a, c := f.RequiredCapabilities[i], f.RequiredCapabilities[j]
				if a.Effect != c.Effect {
					return a.Effect < c.Effect
				}
				return a.Name < c.Name
			})
			if len(f.Effects) != 0 {
				f.EffectVersion = coreir.EffectVersion
			}
		}
		if !changed {
			return
		}
	}
}

func (b *coreBuilder) slot(t coreir.Type, pos scanner.Position) int {
	if t != coreir.I64 && t != coreir.U64 && t != coreir.F64 && t != coreir.IEEE64 && t != coreir.Bool && t != coreir.Bytes {
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
		if _, ok := e.value.(string); ok {
			return coreir.Bytes
		}
	case "variable":
		return b.f.Slots[env.lookup(e.name, e.pos)]
	case "call":
		if e.name == "print" || e.name == "eprint" {
			return coreir.Void
		}
		if e.name == "clock" || e.name == "random" {
			return coreir.U64
		}
		if e.name == "read_file" {
			return coreir.Bytes
		}
		if e.name == "tcp_connect" {
			return coreir.Bool
		}
		if e.name == "http_fetch" {
			return coreir.Bytes
		}
		if e.name == "process_exec" {
			return coreir.U64
		}
		if e.name == "bytes_len" || e.name == "bytes_get" {
			return coreir.U64
		}
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
			if want == coreir.I64 || want == coreir.U64 || want == coreir.F64 || want == coreir.IEEE64 {
				t = want
			}
			text := e.lexeme
			if text == "" {
				text = strconv.FormatFloat(x, 'g', -1, 64)
			}
			if t == coreir.I64 || t == coreir.U64 {
				text = strings.ReplaceAll(text, "_", "")
			}
			return b.constant(t, text, e.pos)
		case string:
			v := b.arena.intern(x, e.pos)
			literal := v.Literal()
			dest := b.slot(coreir.Bytes, e.pos)
			b.emit(coreir.Instruction{Op: "const", Dest: dest, Constant: &literal, Location: coreLocation(e.pos)})
			return dest
		default:
			coreFail(e.pos, "core v1 does not support literal type %T", e.value)
		}
	case "variable":
		return env.lookup(e.name, e.pos)
	case "call":
		if e.name == "bytes_len" {
			if len(e.args) != 1 {
				coreFail(e.pos, "Core bytes_len expects exactly one bytes argument")
			}
			view := b.expression(e.args[0], env, coreir.Bytes)
			dest := b.slot(coreir.U64, e.pos)
			b.emit(coreir.Instruction{Op: "bytes.len", Dest: dest, Args: []int{view}, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "bytes_get" {
			if len(e.args) != 2 {
				coreFail(e.pos, "Core bytes_get expects bytes and u64 arguments")
			}
			view := b.expression(e.args[0], env, coreir.Bytes)
			index := b.expression(e.args[1], env, coreir.U64)
			dest := b.slot(coreir.U64, e.pos)
			b.emit(coreir.Instruction{Op: "bytes.get", Dest: dest, Args: []int{view, index}, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "clock" {
			if len(e.args) != 0 {
				coreFail(e.pos, "Core clock expects no arguments")
			}
			b.addEffect(coreir.EffectClockRead, "clock_read")
			dest := b.slot(coreir.U64, e.pos)
			b.emit(coreir.Instruction{Op: "clock.read", Dest: dest, Args: nil, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "random" {
			if len(e.args) != 0 {
				coreFail(e.pos, "Core random expects no arguments")
			}
			b.addEffect(coreir.EffectRNGSample, "rng_sample")
			dest := b.slot(coreir.U64, e.pos)
			b.emit(coreir.Instruction{Op: "rng.sample", Dest: dest, Args: nil, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "write_file" {
			if len(e.args) != 2 {
				coreFail(e.pos, "Core write_file expects path bytes and data bytes")
			}
			path := b.expression(e.args[0], env, coreir.Bytes)
			data := b.expression(e.args[1], env, coreir.Bytes)
			b.addEffect(coreir.EffectFSWrite, "workspace_write")
			b.emit(coreir.Instruction{Op: "fs.write", Dest: -1, Args: []int{path, data}, MayTrap: true, Location: coreLocation(e.pos)})
			return -1
		}
		if e.name == "read_file" {
			if len(e.args) != 1 {
				coreFail(e.pos, "Core read_file expects one path bytes argument")
			}
			path := b.expression(e.args[0], env, coreir.Bytes)
			b.addEffect(coreir.EffectFSRead, "workspace_read")
			dest := b.slot(coreir.Bytes, e.pos)
			b.emit(coreir.Instruction{Op: "fs.read", Dest: dest, Args: []int{path}, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "tcp_connect" {
			if len(e.args) != 2 {
				coreFail(e.pos, "Core tcp_connect expects IPv4 bytes and u64 port")
			}
			host := b.expression(e.args[0], env, coreir.Bytes)
			port := b.expression(e.args[1], env, coreir.U64)
			b.addEffect(coreir.EffectNetConnect, "network_connect")
			dest := b.slot(coreir.Bool, e.pos)
			b.emit(coreir.Instruction{Op: "net.connect", Dest: dest, Args: []int{host, port}, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "http_fetch" {
			if len(e.args) != 3 {
				coreFail(e.pos, "Core http_fetch expects IPv4 bytes, u64 port and path bytes")
			}
			host := b.expression(e.args[0], env, coreir.Bytes)
			port := b.expression(e.args[1], env, coreir.U64)
			path := b.expression(e.args[2], env, coreir.Bytes)
			b.addEffect(coreir.EffectNetFetch, "network_fetch")
			dest := b.slot(coreir.Bytes, e.pos)
			b.emit(coreir.Instruction{Op: "net.fetch", Dest: dest, Args: []int{host, port, path}, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "process_exec" {
			if len(e.args) != 6 {
				coreFail(e.pos, "Core process_exec expects executable bytes, u64 argc and four explicit bytes argv slots")
			}
			executable := b.expression(e.args[0], env, coreir.Bytes)
			argc := b.expression(e.args[1], env, coreir.U64)
			argv0 := b.expression(e.args[2], env, coreir.Bytes)
			argv1 := b.expression(e.args[3], env, coreir.Bytes)
			argv2 := b.expression(e.args[4], env, coreir.Bytes)
			argv3 := b.expression(e.args[5], env, coreir.Bytes)
			b.addEffect(coreir.EffectProcessExec, "process_exec")
			dest := b.slot(coreir.U64, e.pos)
			b.emit(coreir.Instruction{Op: "process.exec", Dest: dest, Args: []int{executable, argc, argv0, argv1, argv2, argv3}, MayTrap: true, Location: coreLocation(e.pos)})
			return dest
		}
		if e.name == "print" || e.name == "eprint" {
			if len(e.args) != 1 {
				coreFail(e.pos, "Core %s expects exactly one scalar argument", e.name)
			}
			arg := b.expression(e.args[0], env, "")
			op := "io.stdout"
			effect := coreir.EffectIOStdout
			capability := "stdout_write"
			if e.name == "eprint" {
				op = "io.stderr"
				effect = coreir.EffectIOStderr
				capability = "stderr_write"
			}
			b.addEffect(effect, capability)
			b.emit(coreir.Instruction{
				Op: op, Dest: -1, Args: []int{arg}, MayTrap: true, Location: coreLocation(e.pos),
			})
			return -1
		}
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
		} else if t != coreir.I64 && t != coreir.U64 && t != coreir.F64 && t != coreir.IEEE64 {
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
		if t != coreir.I64 && t != coreir.U64 && t != coreir.F64 && t != coreir.IEEE64 {
			t = want
		}
		if t != coreir.I64 && t != coreir.U64 && t != coreir.F64 && t != coreir.IEEE64 {
			t = coreir.F64
		}
		// Numeric context types untyped literals, never a differently typed value.
		left := b.expr(e.args[0], env, t)
		right := b.expr(e.args[1], env, t)
		lt, rt := b.valueType(left, e.pos), b.valueType(right, e.pos)
		ops := map[string]string{
			"+": "add", "-": "sub", "*": "mul", "/": "div", "%": "rem",
			"&": "band", "|": "bor", "^": "bxor", "<<": "shl", ">>": "shr",
			"==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
		}
		op := ops[e.name]
		if op == "" {
			coreFail(e.pos, "unsupported operator %s", e.name)
		}
		result, trap := lt, lt != coreir.IEEE64
		if op == "eq" || op == "ne" {
			result, trap = coreir.Bool, false
		} else {
			if lt != rt || (lt != coreir.I64 && lt != coreir.U64 && lt != coreir.F64 && lt != coreir.IEEE64) {
				coreFail(e.pos, "numeric operands must have the same type")
			}
			if op == "lt" || op == "le" || op == "gt" || op == "ge" {
				result, trap = coreir.Bool, false
			} else if lt == coreir.U64 {
				switch op {
				case "add", "sub", "mul", "band", "bor", "bxor":
					trap = false
				case "div", "rem", "shl", "shr":
					trap = true
				default:
					coreFail(e.pos, "operator %s is not valid for u64", e.name)
				}
			} else if op == "band" || op == "bor" || op == "bxor" || op == "shl" || op == "shr" {
				coreFail(e.pos, "bitwise operators require u64")
			}
		}
		dest := b.slot(result, e.pos)
		b.emit(coreir.Instruction{Op: op, Dest: dest, Args: []int{left, right}, MayTrap: trap, Location: coreLocation(e.pos)})
		return dest
	}
	coreFail(e.pos, "unsupported expression %s", e.kind)
	return -1
}
