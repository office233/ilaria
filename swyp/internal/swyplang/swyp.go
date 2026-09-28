// Package swyplang implements the experimental Swyp Lang interpreter.
package swyplang

import (
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"text/scanner"
	"time"
	"unicode"
)

type token struct {
	text string
	pos  scanner.Position
}
type expr struct {
	kind, name string
	value      any
	args       []*expr
	pos        scanner.Position
	depth      int    // AST height, independent of parser recursion depth.
	lexeme     string // Original numeric token, retained for exact core i64 literals.
}
type stmt struct {
	annotation  string // Available only in ParseCore mode.
	kind, name  string
	value       *expr
	body, other []*stmt
	pos         scanner.Position
}
type function struct {
	params      []string
	body        []*stmt
	annotations []string
	result      string
	pos         scanner.Position
}
type Program struct {
	functions map[string]function
	core      bool // Opt-in parser mode; legacy backends must reject it.
}
type parser struct {
	core      bool
	tokens    []token
	at, depth int
	tailDepth int // block depth whose final bare expression is the function result; 0 = none
	tailUsed  int // bare result expressions accepted so far
}

func failure(pos scanner.Position, format string, args ...any) error {
	return fmt.Errorf("%s: %s", pos, fmt.Sprintf(format, args...))
}

// Parse checks syntax and declarations without executing the program.
func Parse(filename, source string) (*Program, error) {
	return parseSource(filename, source, false)
}

// ParseCore enables explicit i64/f64 and typed locals for the opt-in core pipeline.
func ParseCore(filename, source string) (*Program, error) {
	return parseSource(filename, source, true)
}

func parseSource(filename, source string, core bool) (program *Program, err error) {
	if len(source) > 1_048_576 {
		return nil, fmt.Errorf("%s: source exceeds 1 MiB limit", filename)
	}
	var s scanner.Scanner
	s.Init(strings.NewReader(source))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanInts | scanner.ScanFloats | scanner.ScanStrings | scanner.ScanComments | scanner.SkipComments
	var lexical error
	s.Error = func(s *scanner.Scanner, message string) {
		if lexical == nil {
			lexical = failure(s.Position, "%s", message)
		}
	}
	p := &parser{core: core}
	for k := s.Scan(); k != scanner.EOF; k = s.Scan() {
		p.tokens = append(p.tokens, token{s.TokenText(), s.Position})
	}
	if lexical != nil {
		return nil, lexical
	}
	p.tokens = append(p.tokens, token{"<eof>", s.Pos()})
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
				program = nil
			} else {
				panic(r)
			}
		}
	}()
	program = &Program{functions: map[string]function{}, core: core}
	for p.peek() != "<eof>" {
		p.expect("fn")
		name := p.identifier()
		if name == "print" || name == "arg" || name == "clock" {
			p.bad("%s is a reserved built-in", name)
		}
		if _, exists := program.functions[name]; exists {
			p.bad("duplicate function %q", name)
		}
		p.expect("(")
		f := function{pos: p.tokens[p.at-1].pos}
		seen := map[string]bool{}
		if p.peek() != ")" {
			for {
				n := p.identifier()
				if seen[n] {
					p.bad("duplicate parameter %q", n)
				}
				seen[n] = true
				f.params = append(f.params, n)
				annotation := ""
				if p.take(":") {
					annotation = p.typeName(false)
				}
				f.annotations = append(f.annotations, annotation)
				if !p.take(",") {
					break
				}
			}
		}
		p.expect(")")
		if p.take("-") {
			p.expect(">")
			f.result = p.typeName(true)
		}
		f.body = p.functionBody(f.result != "" && f.result != "void")
		program.functions[name] = f
	}
	main, ok := program.functions["main"]
	if !ok {
		p.bad("missing fn main()")
	}
	if len(main.params) != 0 {
		p.bad("main must have no parameters")
	}
	return program, nil
}
func (p *parser) typeName(allowVoid bool) string {
	name := p.peek()
	if name != "number" && name != "bool" && name != "string" && !(allowVoid && name == "void") && !(p.core && (name == "i64" || name == "f64")) {
		p.bad("expected type number, bool, or string")
	}
	p.at++
	return name
}
func (p *parser) peek() string           { return p.tokens[p.at].text }
func (p *parser) bad(f string, a ...any) { panic(failure(p.tokens[p.at].pos, f, a...)) }
func (p *parser) take(s string) bool {
	if p.peek() == s {
		p.at++
		return true
	}
	return false
}
func (p *parser) expect(s string) {
	if !p.take(s) {
		p.bad("expected %q, got %q", s, p.peek())
	}
}
func (p *parser) identifier() string {
	t := p.peek()
	for i, c := range t {
		if c != '_' && !unicode.IsLetter(c) && !(i > 0 && unicode.IsDigit(c)) {
			p.bad("expected identifier, got %q", t)
		}
	}
	switch t {
	case "fn", "let", "if", "else", "while", "return", "true", "false":
		p.bad("reserved word %q cannot be an identifier", t)
	}
	p.at++
	return t
}
func (p *parser) block() []*stmt {
	p.enter()
	defer func() { p.depth-- }()
	p.expect("{")
	var body []*stmt
	for p.peek() != "}" {
		if p.peek() == "<eof>" {
			p.bad("expected closing brace")
		}
		body = append(body, p.statement())
	}
	p.expect("}")
	return body
}

// functionBody parses a function block. In Semantic Core mode a function
// with a result may end with a bare expression and no ';' (Rust style), which
// is its return value: code models write this form by default, and it was
// previously a syntax error, so no valid program changes meaning.
func (p *parser) functionBody(hasResult bool) []*stmt {
	saved := p.tailDepth
	p.tailDepth = 0
	if p.core && hasResult {
		p.tailDepth = p.depth + 1
	}
	defer func() { p.tailDepth = saved }()
	return p.block()
}
func (p *parser) statement() *stmt {
	s := &stmt{pos: p.tokens[p.at].pos}
	switch {
	case p.take("let"):
		s.kind = "let"
		s.name = p.identifier()
		if p.core && p.take(":") {
			s.annotation = p.typeName(false)
		}
		p.expect("=")
		s.value = p.expression(0)
		p.expect(";")
	case p.take("return"):
		s.kind = "return"
		s.value = p.expression(0)
		p.expect(";")
	case p.take("if"):
		s.kind = "if"
		s.value = p.expression(0)
		// A final if/else may end each branch with a bare result expression
		// (Rust's if-expression); anywhere else such a branch is an error.
		tail, saved, used := p.tailDepth > 0 && p.depth == p.tailDepth, p.tailDepth, p.tailUsed
		if tail {
			p.tailDepth = p.depth + 1
		}
		s.body = p.block()
		if p.take("else") {
			s.other = p.block()
		}
		p.tailDepth = saved
		if p.tailUsed != used && (s.other == nil || p.peek() != "}") {
			p.bad("a bare result expression is only allowed at the end of a function or of both branches of its final if/else")
		}
	case p.take("while"):
		s.kind = "while"
		s.value = p.expression(0)
		s.body = p.block()
	default:
		if p.at+1 < len(p.tokens) && p.tokens[p.at+1].text == "=" && (p.at+2 >= len(p.tokens) || p.tokens[p.at+2].text != "=") {
			s.kind = "assign"
			s.name = p.identifier()
			p.expect("=")
			s.value = p.expression(0)
		} else {
			s.kind = "expr"
			s.value = p.expression(0)
			if p.tailDepth > 0 && p.depth == p.tailDepth && p.peek() == "}" {
				s.kind = "return"
				p.tailUsed++
				return s
			}
		}
		p.expect(";")
	}
	return s
}

var precedence = map[string]int{"||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6}

func (p *parser) enter() {
	p.depth++
	if p.depth > 256 {
		p.bad("syntax nesting limit exceeded")
	}
}
func (p *parser) operator() (string, int) {
	t := p.peek()
	if p.at+1 < len(p.tokens) {
		next := p.tokens[p.at+1]
		current := p.tokens[p.at]
		if next.pos.Offset == current.pos.Offset+len(t) {
			pair := t + next.text
			if _, ok := precedence[pair]; ok {
				return pair, 2
			}
		}
	}
	return t, 1
}
func (p *parser) expression(min int) *expr {
	p.enter()
	defer func() { p.depth-- }()
	t := p.tokens[p.at]
	var e *expr
	switch {
	case p.take("-"):
		e = &expr{kind: "unary", name: "-", args: []*expr{p.expression(7)}, pos: t.pos}
	case p.take("!"):
		e = &expr{kind: "unary", name: "!", args: []*expr{p.expression(7)}, pos: t.pos}
	case p.take("("):
		e = p.expression(0)
		p.expect(")")
	case p.take("true"):
		e = &expr{kind: "literal", value: true, pos: t.pos}
	case p.take("false"):
		e = &expr{kind: "literal", value: false, pos: t.pos}
	default:
		if strings.HasPrefix(t.text, "\"") {
			v, err := strconv.Unquote(t.text)
			if err != nil {
				p.bad("invalid string")
			}
			p.at++
			e = &expr{kind: "literal", value: v, pos: t.pos}
		} else if v, err := strconv.ParseFloat(t.text, 64); err == nil && !math.IsNaN(v) && !math.IsInf(v, 0) {
			p.at++
			e = &expr{kind: "literal", value: v, lexeme: t.text, pos: t.pos}
		} else {
			name := p.identifier()
			e = &expr{kind: "variable", name: name, pos: t.pos}
			if p.take("(") {
				e.kind = "call"
				if p.peek() != ")" {
					for {
						e.args = append(e.args, p.expression(0))
						if !p.take(",") {
							break
						}
					}
				}
				p.expect(")")
			}
		}
	}
	e = boundedExpression(e)
	for {
		op, n := p.operator()
		prec, ok := precedence[op]
		if !ok || prec < min {
			break
		}
		p.at += n
		e = boundedExpression(&expr{kind: "binary", name: op, args: []*expr{e, p.expression(prec + 1)}, pos: t.pos})
	}
	return e
}

// Left-associative chains are built in a loop, so parser recursion alone does
// not bound the AST traversed recursively by the checker and code generators.
// Children already have their height computed; each new node is checked once.
func boundedExpression(e *expr) *expr {
	e.depth = 1
	for _, child := range e.args {
		if depth := child.depth + 1; depth > e.depth {
			e.depth = depth
		}
	}
	if e.depth > 256 {
		panic(failure(e.pos, "expression nesting limit exceeded"))
	}
	return e
}

type scope struct {
	values map[string]any
	parent *scope
}

func (s *scope) find(name string) (*scope, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if _, ok := cur.values[name]; ok {
			return cur, true
		}
	}
	return nil, false
}

type runtime struct {
	program      *Program
	out          io.Writer
	steps, depth int
	args         []float64
	started      time.Time
}

// Run executes main with a bounded evaluation budget and call depth.
func (p *Program) Run(out io.Writer, budget int) (err error) {
	return p.RunArgs(out, budget, nil)
}
func (p *Program) RunArgs(out io.Writer, budget int, args []float64) (err error) {
	if p.core {
		return fmt.Errorf("core source requires the CoreIR execution pipeline")
	}
	if budget <= 0 {
		return fmt.Errorf("step budget must be positive")
	}
	defer func() {
		if v := recover(); v != nil {
			if e, ok := v.(error); ok {
				err = e
			} else {
				panic(v)
			}
		}
	}()
	for _, a := range args {
		if math.IsNaN(a) || math.IsInf(a, 0) {
			return fmt.Errorf("arguments must be finite numbers")
		}
	}
	r := &runtime{program: p, out: out, steps: budget, args: args, started: time.Now()}
	r.call("main", nil, scanner.Position{Filename: "<entry>"})
	return nil
}
func (r *runtime) tick(pos scanner.Position) {
	r.steps--
	if r.steps < 0 {
		panic(failure(pos, "execution step limit exceeded"))
	}
}
func (r *runtime) call(name string, args []any, pos scanner.Position) any {
	r.tick(pos)
	if name == "clock" {
		if len(args) != 0 {
			panic(failure(pos, "clock expects 0 arguments"))
		}
		return time.Since(r.started).Seconds()
	}
	if name == "arg" {
		if len(args) != 1 {
			panic(failure(pos, "arg expects 1 argument"))
		}
		i := number(args[0], pos)
		if i < 0 || i >= float64(len(r.args)) || math.Trunc(i) != i {
			panic(failure(pos, "argument index out of range"))
		}
		return r.args[int(i)]
	}
	if name == "print" {
		if _, err := fmt.Fprintln(r.out, args...); err != nil {
			panic(failure(pos, "output failed: %v", err))
		}
		return nil
	}
	f, ok := r.program.functions[name]
	if !ok {
		panic(failure(pos, "unknown function %q", name))
	}
	if len(args) != len(f.params) {
		panic(failure(pos, "%s expects %d arguments, got %d", name, len(f.params), len(args)))
	}
	r.depth++
	defer func() { r.depth-- }()
	if r.depth > 128 {
		panic(failure(pos, "call depth limit exceeded"))
	}
	env := &scope{values: map[string]any{}}
	for i, n := range f.params {
		env.values[n] = args[i]
	}
	v, _ := r.block(f.body, env)
	return v
}
func (r *runtime) block(body []*stmt, parent *scope) (any, bool) {
	env := &scope{values: map[string]any{}, parent: parent}
	for _, s := range body {
		r.tick(s.pos)
		switch s.kind {
		case "let":
			if _, ok := env.values[s.name]; ok {
				panic(failure(s.pos, "duplicate variable %q", s.name))
			}
			env.values[s.name] = r.eval(s.value, env)
		case "assign":
			target, ok := env.find(s.name)
			if !ok {
				panic(failure(s.pos, "unknown variable %q", s.name))
			}
			target.values[s.name] = r.eval(s.value, env)
		case "expr":
			r.eval(s.value, env)
		case "return":
			return r.eval(s.value, env), true
		case "if":
			branch := s.other
			if boolean(r.eval(s.value, env), s.pos) {
				branch = s.body
			}
			if v, done := r.block(branch, env); done {
				return v, true
			}
		case "while":
			for boolean(r.eval(s.value, env), s.pos) {
				if v, done := r.block(s.body, env); done {
					return v, true
				}
			}
		}
	}
	return nil, false
}
func boolean(v any, pos scanner.Position) bool {
	b, ok := v.(bool)
	if !ok {
		panic(failure(pos, "expected boolean, got %T", v))
	}
	return b
}
func number(v any, pos scanner.Position) float64 {
	n, ok := v.(float64)
	if !ok {
		panic(failure(pos, "expected number, got %T", v))
	}
	return n
}
func finite(v float64, pos scanner.Position) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		panic(failure(pos, "non-finite numeric result"))
	}
	return v
}
func (r *runtime) eval(e *expr, env *scope) any {
	r.tick(e.pos)
	switch e.kind {
	case "literal":
		return e.value
	case "variable":
		s, ok := env.find(e.name)
		if !ok {
			panic(failure(e.pos, "unknown variable %q", e.name))
		}
		return s.values[e.name]
	case "call":
		args := make([]any, len(e.args))
		for i, a := range e.args {
			args[i] = r.eval(a, env)
		}
		return r.call(e.name, args, e.pos)
	case "unary":
		v := r.eval(e.args[0], env)
		if e.name == "!" {
			return !boolean(v, e.pos)
		}
		return -number(v, e.pos)
	case "binary":
		a := r.eval(e.args[0], env)
		if e.name == "&&" {
			return boolean(a, e.pos) && boolean(r.eval(e.args[1], env), e.pos)
		}
		if e.name == "||" {
			return boolean(a, e.pos) || boolean(r.eval(e.args[1], env), e.pos)
		}
		b := r.eval(e.args[1], env)
		if e.name == "==" {
			return a == b
		}
		if e.name == "!=" {
			return a != b
		}
		if e.name == "+" {
			if str, ok := a.(string); ok {
				other, ok := b.(string)
				if !ok {
					panic(failure(e.pos, "string concatenation requires two strings"))
				}
				return str + other
			}
		}
		x, y := number(a, e.pos), number(b, e.pos)
		switch e.name {
		case "+":
			return finite(x+y, e.pos)
		case "-":
			return finite(x-y, e.pos)
		case "*":
			return finite(x*y, e.pos)
		case "/":
			if y == 0 {
				panic(failure(e.pos, "division by zero"))
			}
			return finite(x/y, e.pos)
		case "%":
			if y == 0 {
				panic(failure(e.pos, "remainder by zero"))
			}
			return finite(math.Mod(x, y), e.pos)
		case "<":
			return x < y
		case "<=":
			return x <= y
		case ">":
			return x > y
		case ">=":
			return x >= y
		}
	}
	panic(failure(e.pos, "invalid expression"))
}
