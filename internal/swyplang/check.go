package swyplang

import (
	"fmt"
	"sort"
	"text/scanner"
)

const (
	numType    = 1
	boolType   = 2
	strType    = 4
	voidType   = 8
	valueTypes = 7
)

type typeVar struct {
	parent *typeVar
	mask   int
}

func newType(mask int) *typeVar { return &typeVar{mask: mask} }
func (v *typeVar) root() *typeVar {
	if v.parent != nil {
		v.parent = v.parent.root()
		return v.parent
	}
	return v
}
func merge(a, b *typeVar, pos scanner.Position) {
	a = a.root()
	b = b.root()
	mask := a.mask & b.mask
	if mask == 0 {
		panic(failure(pos, "type mismatch: %s versus %s", typeLabel(a.mask), typeLabel(b.mask)))
	}
	if a != b {
		b.parent = a
	}
	a.mask = mask
}
func restrict(a *typeVar, mask int, pos scanner.Position) { merge(a, newType(mask), pos) }
func typeLabel(t int) string {
	switch t {
	case numType:
		return "number"
	case boolType:
		return "bool"
	case strType:
		return "string"
	case voidType:
		return "void"
	}
	return "unresolved value"
}
func annotationType(name string) int {
	switch name {
	case "number":
		return numType
	case "bool":
		return boolType
	case "string":
		return strType
	case "void":
		return voidType
	}
	return valueTypes
}

type signature struct {
	params []*typeVar
	result *typeVar
}
type checked struct {
	signatures   map[string]signature
	expressions  map[*expr]*typeVar
	declarations map[*stmt]*typeVar
	order        []string
}
type typeScope struct {
	vars   map[string]*typeVar
	parent *typeScope
}

func (s *typeScope) lookup(n string, pos scanner.Position) *typeVar {
	for e := s; e != nil; e = e.parent {
		if v, ok := e.vars[n]; ok {
			return v
		}
	}
	panic(failure(pos, "unknown variable %q", n))
}

// Check enforces monomorphic types, lexical names, arity and return coverage.
func (p *Program) Check() error { _, err := p.check(); return err }
func (p *Program) check() (c *checked, err error) {
	if p.core {
		return nil, fmt.Errorf("core source requires CoreIR; legacy backends are unchanged")
	}
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				c = nil
				err = e
			} else {
				panic(r)
			}
		}
	}()
	c = &checked{signatures: map[string]signature{}, expressions: map[*expr]*typeVar{}, declarations: map[*stmt]*typeVar{}}
	for name := range p.functions {
		c.order = append(c.order, name)
	}
	sort.Strings(c.order)
	for _, name := range c.order {
		f := p.functions[name]
		sig := signature{}
		for _, a := range f.annotations {
			sig.params = append(sig.params, newType(annotationType(a)))
		}
		mask := voidType
		if hasReturn(f.body) {
			mask = valueTypes
			if !returns(f.body) {
				panic(failure(f.pos, "function %s may finish without returning a value", name))
			}
		}
		sig.result = newType(mask)
		if f.result != "" {
			restrict(sig.result, annotationType(f.result), f.pos)
		}
		c.signatures[name] = sig
	}
	for _, name := range c.order {
		f := p.functions[name]
		sig := c.signatures[name]
		env := &typeScope{vars: map[string]*typeVar{}}
		for i, n := range f.params {
			env.vars[n] = sig.params[i]
		}
		c.block(f.body, env, sig.result)
	}
	for _, name := range c.order {
		sig := c.signatures[name]
		for _, v := range append(append([]*typeVar{}, sig.params...), sig.result) {
			m := v.root().mask
			if m&(m-1) != 0 {
				panic(failure(p.functions[name].pos, "cannot infer type in function %s; add parameter/return annotations", name))
			}
		}
	}
	for e, v := range c.expressions {
		m := v.root().mask
		if m&(m-1) != 0 {
			panic(failure(e.pos, "cannot infer expression type"))
		}
	}
	return c, nil
}
func hasReturn(body []*stmt) bool {
	for _, s := range body {
		if s.kind == "return" || hasReturn(s.body) || hasReturn(s.other) {
			return true
		}
	}
	return false
}
func returns(body []*stmt) bool {
	for _, s := range body {
		if s.kind == "return" {
			return true
		}
		if s.kind == "if" && returns(s.body) && returns(s.other) {
			return true
		}
	}
	return false
}
func (c *checked) block(body []*stmt, parent *typeScope, result *typeVar) {
	env := &typeScope{vars: map[string]*typeVar{}, parent: parent}
	for _, s := range body {
		switch s.kind {
		case "let":
			if _, ok := env.vars[s.name]; ok {
				panic(failure(s.pos, "duplicate variable %q", s.name))
			}
			v := c.expression(s.value, env)
			restrict(v, valueTypes, s.pos)
			env.vars[s.name] = v
			c.declarations[s] = v
		case "assign":
			merge(env.lookup(s.name, s.pos), c.expression(s.value, env), s.pos)
		case "expr":
			c.expression(s.value, env)
		case "return":
			v := c.expression(s.value, env)
			restrict(v, valueTypes, s.pos)
			merge(result, v, s.pos)
		case "if", "while":
			restrict(c.expression(s.value, env), boolType, s.pos)
			c.block(s.body, env, result)
			c.block(s.other, env, result)
		}
	}
}
func (c *checked) expression(e *expr, env *typeScope) *typeVar {
	var t *typeVar
	switch e.kind {
	case "literal":
		switch e.value.(type) {
		case float64:
			t = newType(numType)
		case string:
			t = newType(strType)
		case bool:
			t = newType(boolType)
		}
	case "variable":
		t = env.lookup(e.name, e.pos)
	case "call":
		if e.name == "print" {
			for _, a := range e.args {
				restrict(c.expression(a, env), valueTypes, a.pos)
			}
			t = newType(voidType)
			break
		}
		if e.name == "arg" || e.name == "clock" {
			want := 0
			if e.name == "arg" {
				want = 1
			}
			if len(e.args) != want {
				panic(failure(e.pos, "%s expects %d arguments", e.name, want))
			}
			for _, a := range e.args {
				restrict(c.expression(a, env), numType, a.pos)
			}
			t = newType(numType)
			break
		}
		sig, ok := c.signatures[e.name]
		if !ok {
			panic(failure(e.pos, "unknown function %q", e.name))
		}
		if len(e.args) != len(sig.params) {
			panic(failure(e.pos, "%s expects %d arguments, got %d", e.name, len(sig.params), len(e.args)))
		}
		for i, a := range e.args {
			merge(sig.params[i], c.expression(a, env), a.pos)
		}
		t = sig.result
	case "unary":
		t = c.expression(e.args[0], env)
		mask := numType
		if e.name == "!" {
			mask = boolType
		}
		restrict(t, mask, e.pos)
	case "binary":
		a, b := c.expression(e.args[0], env), c.expression(e.args[1], env)
		switch e.name {
		case "==", "!=":
			restrict(a, valueTypes, e.pos)
			restrict(b, valueTypes, e.pos)
			t = newType(boolType)
		case "&&", "||":
			restrict(a, boolType, e.pos)
			restrict(b, boolType, e.pos)
			t = newType(boolType)
		case "+":
			restrict(a, numType|strType, e.pos)
			merge(a, b, e.pos)
			t = a
		default:
			restrict(a, numType, e.pos)
			restrict(b, numType, e.pos)
			t = newType(numType)
			if e.name == "<" || e.name == ">" || e.name == "<=" || e.name == ">=" {
				t = newType(boolType)
			}
		}
	default:
		panic(fmt.Errorf("unknown expression kind %s", e.kind))
	}
	c.expressions[e] = t
	return t
}
