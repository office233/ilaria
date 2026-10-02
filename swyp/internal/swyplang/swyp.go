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

	"swyp-lang/internal/sourcefront"
)

type token struct {
	text string
	pos  scanner.Position
}
type expr struct {
	kind, name string
	value      any
	args       []*expr
	fields     []exprField
	arms       []exprArm
	variant    string
	pos        scanner.Position
	depth      int    // AST height, independent of parser recursion depth.
	lexeme     string // Original numeric token, retained for exact core i64 literals.
}
type exprField struct {
	name  string
	value *expr
	pos   scanner.Position
}
type exprArm struct {
	variant string
	binding string
	value   *expr
	pos     scanner.Position
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
	borrowFrom  string
	pos         scanner.Position
}
type structDecl struct {
	name   string
	fields []structField
	pos    scanner.Position
}
type structField struct {
	name     string
	typeName string
	pos      scanner.Position
}
type enumDecl struct {
	name     string
	variants []enumVariant
	pos      scanner.Position
}
type enumVariant struct {
	name    string
	payload string
	pos     scanner.Position
}
type Program struct {
	functions map[string]function
	structs   map[string]structDecl
	enums     map[string]enumDecl
	core      bool // Opt-in parser mode; legacy backends must reject it.
	module    string
	uses      []string
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
	return parseSource(filename, source, false, true)
}

// ParseCore enables explicit i64/f64 and typed locals for the opt-in core pipeline.
func ParseCore(filename, source string) (*Program, error) {
	return parseSource(filename, source, true, true)
}

// ParseModule parses a compatibility-surface library module. Unlike Parse it
// does not require an executable fn main(); callers still get the same syntax
// and declaration validation for every function that is present.
func ParseModule(filename, source string) (*Program, error) {
	return parseSource(filename, source, false, false)
}

// ParseCoreModule parses a Core-surface library module without requiring an
// executable entrypoint. Native/run/build commands intentionally keep using
// ParseCore so entry programs remain fail-closed when main is absent.
func ParseCoreModule(filename, source string) (*Program, error) {
	return parseSource(filename, source, true, false)
}

func parseSource(filename, source string, core, requireMain bool) (program *Program, err error) {
	if len(source) > 1_048_576 {
		return nil, diagnosticForFile(DiagnosticSourceTooLarge, filename, "source exceeds 1 MiB limit")
	}
	preamble, parseBody, preambleErr := sourcefront.ParsePreamble(filename, source)
	if preambleErr != nil {
		if e, ok := preambleErr.(*sourcefront.Error); ok {
			return nil, diagnosticAt(DiagnosticModulePreamble, e.Position, "%s", e.Message)
		}
		return nil, preambleErr
	}
	var s scanner.Scanner
	s.Init(strings.NewReader(parseBody))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanInts | scanner.ScanFloats | scanner.ScanStrings | scanner.ScanComments | scanner.SkipComments
	var lexical error
	s.Error = func(s *scanner.Scanner, message string) {
		if lexical == nil {
			lexical = diagnosticAt(DiagnosticLexicalError, s.Position, "%s", message)
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
	program = &Program{functions: map[string]function{}, structs: map[string]structDecl{}, enums: map[string]enumDecl{}, core: core, module: preamble.Module, uses: append([]string(nil), preamble.Uses...)}
	for p.peek() != "<eof>" {
		if p.core && p.peek() == "struct" {
			p.at++
			name := p.identifier()
			if _, exists := program.structs[name]; exists || program.enums[name].name != "" {
				p.badCode(DiagnosticInvalidType, "duplicate nominal type %q", name)
			}
			d := structDecl{name: name, pos: p.tokens[p.at-1].pos}
			p.expect("{")
			seen := map[string]bool{}
			for p.peek() != "}" {
				fieldPos := p.tokens[p.at].pos
				field := p.identifier()
				if seen[field] {
					p.badCode(DiagnosticDuplicateVariable, "duplicate struct field %q", field)
				}
				seen[field] = true
				p.expect(":")
				typ := p.typeName(false)
				p.expect(";")
				d.fields = append(d.fields, structField{name: field, typeName: typ, pos: fieldPos})
			}
			p.expect("}")
			if len(d.fields) == 0 {
				p.badCode(DiagnosticInvalidType, "struct %s must contain at least one field", name)
			}
			program.structs[name] = d
			continue
		}
		if p.core && p.peek() == "enum" {
			p.at++
			name := p.identifier()
			if _, exists := program.enums[name]; exists || program.structs[name].name != "" {
				p.badCode(DiagnosticInvalidType, "duplicate nominal type %q", name)
			}
			d := enumDecl{name: name, pos: p.tokens[p.at-1].pos}
			p.expect("{")
			seen := map[string]bool{}
			for p.peek() != "}" {
				variantPos := p.tokens[p.at].pos
				variant := p.identifier()
				if seen[variant] {
					p.badCode(DiagnosticInvalidType, "duplicate enum variant %q", variant)
				}
				seen[variant] = true
				payload := ""
				if p.take("(") {
					payload = p.typeName(false)
					p.expect(")")
				}
				p.expect(";")
				d.variants = append(d.variants, enumVariant{name: variant, payload: payload, pos: variantPos})
			}
			p.expect("}")
			if len(d.variants) == 0 {
				p.badCode(DiagnosticInvalidType, "enum %s must contain at least one variant", name)
			}
			program.enums[name] = d
			continue
		}
		p.expect("fn")
		name := p.identifier()
		if name == "print" || name == "eprint" || name == "arg" || name == "clock" || (p.core && (name == "some" || name == "none" || name == "ok" || name == "err" || name == "drop" || name == "defer_drop" || name == "store" || name == "vec_len" || name == "vec_capacity" || name == "vec_push")) {
			p.badCode(DiagnosticReservedIdentifier, "%s is a reserved built-in", name)
		}
		if _, exists := program.functions[name]; exists {
			p.badCode(DiagnosticDuplicateFunction, "duplicate function %q", name)
		}
		p.expect("(")
		f := function{pos: p.tokens[p.at-1].pos}
		seen := map[string]bool{}
		if p.peek() != ")" {
			for {
				n := p.identifier()
				if seen[n] {
					p.badCode(DiagnosticDuplicateParameter, "duplicate parameter %q", n)
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
		if p.core && p.take("borrows") {
			f.borrowFrom = p.identifier()
			if !seen[f.borrowFrom] {
				p.badCode(DiagnosticInvalidType, "borrow lifetime source %q is not a function parameter", f.borrowFrom)
			}
		}
		f.body = p.functionBody(f.result != "" && f.result != "void")
		program.functions[name] = f
	}
	if p.core {
		if typeErr := validateProgramTypeNames(program); typeErr != nil {
			return nil, typeErr
		}
	}
	if requireMain {
		main, ok := program.functions["main"]
		if !ok {
			p.badCode(DiagnosticMissingMain, "missing fn main()")
		}
		if len(main.params) != 0 {
			p.badCode(DiagnosticInvalidMain, "main must have no parameters")
		}
	}
	return program, nil
}

// ModuleName returns the optional namespace declared by the shared Swyp source
// preamble. Empty means the source is an unqualified compatibility module.
func (p *Program) ModuleName() string {
	if p == nil {
		return ""
	}
	return p.module
}

// Uses returns a detached ordered list of logical module dependencies. Import
// resolution is intentionally a separate compiler stage; parsing never performs
// ambient filesystem or network access.
func (p *Program) Uses() []string {
	if p == nil {
		return nil
	}
	return append([]string(nil), p.uses...)
}
func (p *parser) typeName(allowVoid bool) string {
	p.enter()
	defer func() { p.depth-- }()
	name := p.peek()
	if name != "number" && name != "bool" && name != "string" && !(allowVoid && name == "void") && !(p.core && (coreHIRScalarType(name) || coreHIRGenericType(name) || sourceTypeIdentifier(name))) {
		p.badCode(DiagnosticInvalidType, "expected type name, got %q", name)
	}
	p.at++
	if p.core && sourceTypeIdentifier(name) && !coreHIRScalarType(name) && !coreHIRGenericType(name) {
		for p.take(".") {
			name += "." + p.identifier()
		}
		return name
	}
	if !p.core || !coreHIRGenericType(name) {
		return name
	}
	p.expect("<")
	switch name {
	case "array":
		element := p.typeName(false)
		p.expect(",")
		lengthToken := p.peek()
		lengthText := strings.ReplaceAll(lengthToken, "_", "")
		length, err := strconv.ParseUint(lengthText, 10, 64)
		if err != nil {
			p.badCode(DiagnosticInvalidType, "array length must be an unsigned decimal integer, got %q", lengthToken)
		}
		p.at++
		p.expect(">")
		return fmt.Sprintf("array<%s,%d>", element, length)
	case "result":
		okType := p.typeName(false)
		p.expect(",")
		errType := p.typeName(false)
		p.expect(">")
		return fmt.Sprintf("result<%s,%s>", okType, errType)
	case "tuple":
		var elements []string
		for {
			elements = append(elements, p.typeName(false))
			if p.take(">") {
				break
			}
			p.expect(",")
		}
		return "tuple<" + strings.Join(elements, ",") + ">"
	default:
		arg := p.typeName(false)
		p.expect(">")
		return name + "<" + arg + ">"
	}
}

func sourceTypeIdentifier(name string) bool {
	if name == "" || name == "<eof>" {
		return false
	}
	for i, r := range name {
		if r == '_' || unicode.IsLetter(r) || (i > 0 && unicode.IsDigit(r)) {
			continue
		}
		return false
	}
	return true
}

func coreHIRScalarType(name string) bool {
	switch name {
	case "i8", "i16", "i32", "i64", "i128",
		"u8", "u16", "u32", "u64", "u128",
		"f16", "bf16", "f32", "f64", "finite32", "finite64", "ieee64", "bytes":
		return true
	default:
		return false
	}
}

func coreHIRGenericType(name string) bool {
	switch name {
	case "array", "slice", "vec", "option", "result", "tuple", "opaque", "ref", "mutref":
		return true
	default:
		return false
	}
}
func (p *parser) peek() string { return p.tokens[p.at].text }
func (p *parser) bad(f string, a ...any) {
	p.badCode(DiagnosticParseError, f, a...)
}
func (p *parser) badCode(code, f string, a ...any) {
	panic(diagnosticAt(code, p.tokens[p.at].pos, f, a...))
}
func (p *parser) take(s string) bool {
	if p.peek() == s {
		p.at++
		return true
	}
	return false
}
func (p *parser) takeDoubleColon() bool {
	if p.at+1 >= len(p.tokens) || p.tokens[p.at].text != ":" || p.tokens[p.at+1].text != ":" {
		return false
	}
	first, second := p.tokens[p.at], p.tokens[p.at+1]
	if second.pos.Offset != first.pos.Offset+len(first.text) {
		return false
	}
	p.at += 2
	return true
}
func (p *parser) expect(s string) {
	if !p.take(s) {
		p.badCode(DiagnosticUnexpectedToken, "expected %q, got %q", s, p.peek())
	}
}
func (p *parser) identifier() string {
	t := p.peek()
	for i, c := range t {
		if c != '_' && !unicode.IsLetter(c) && !(i > 0 && unicode.IsDigit(c)) {
			p.badCode(DiagnosticExpectedIdentifier, "expected identifier, got %q", t)
		}
	}
	switch t {
	case "fn", "let", "if", "else", "while", "return", "true", "false", "new", "match", "struct", "enum", "mut":
		p.badCode(DiagnosticReservedIdentifier, "reserved word %q cannot be an identifier", t)
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
			p.badCode(DiagnosticUnexpectedToken, "expected closing brace")
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
		// Core mode: a return that closes its block may omit ';' ("return x }").
		// Models write this Rust form constantly and nothing else can follow
		// the expression there, so no valid program changes meaning.
		if !(p.core && p.peek() == "}") {
			p.expect(";")
		}
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
			if p.core && p.peek() == "if" {
				// Core mode: "else if" is "else { if ... }". The nested if is
				// parsed one level deeper, exactly as inside a block, so a
				// final else-if chain may still end in bare result expressions.
				p.enter()
				s.other = []*stmt{p.statement()}
				p.depth--
			} else {
				s.other = p.block()
			}
		}
		p.tailDepth = saved
		if p.tailUsed != used && (s.other == nil || p.peek() != "}") {
			p.badCode(DiagnosticParseError, "a bare result expression is only allowed at the end of a function or of both branches of its final if/else")
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

var corePrecedence = map[string]int{
	"||": 1,
	"&&": 2,
	"|":  3,
	"^":  4,
	"&":  5,
	"==": 6, "!=": 6,
	"<": 7, "<=": 7, ">": 7, ">=": 7,
	"<<": 8, ">>": 8,
	"+": 9, "-": 9,
	"*": 10, "/": 10, "%": 10,
}

func (p *parser) enter() {
	p.depth++
	if p.depth > 256 {
		p.badCode(DiagnosticSyntaxNestingLimit, "syntax nesting limit exceeded")
	}
}
func (p *parser) operator() (string, int) {
	table := precedence
	if p.core {
		table = corePrecedence
	}
	t := p.peek()
	if p.at+1 < len(p.tokens) {
		next := p.tokens[p.at+1]
		current := p.tokens[p.at]
		if next.pos.Offset == current.pos.Offset+len(t) {
			pair := t + next.text
			if _, ok := table[pair]; ok {
				return pair, 2
			}
		}
	}
	return t, 1
}
func (p *parser) precedence(op string) (int, bool) {
	if p.core {
		v, ok := corePrecedence[op]
		return v, ok
	}
	v, ok := precedence[op]
	return v, ok
}
func (p *parser) unaryPrecedence() int {
	if p.core {
		return 11
	}
	return 7
}
func (p *parser) expression(min int) *expr {
	p.enter()
	defer func() { p.depth-- }()
	t := p.tokens[p.at]
	var e *expr
	switch {
	case p.take("-"):
		e = &expr{kind: "unary", name: "-", args: []*expr{p.expression(p.unaryPrecedence())}, pos: t.pos}
	case p.take("!"):
		e = &expr{kind: "unary", name: "!", args: []*expr{p.expression(p.unaryPrecedence())}, pos: t.pos}
	case p.core && p.take("&"):
		mode := "shared"
		if p.take("mut") {
			mode = "mut"
		}
		e = &expr{kind: "borrow", name: mode, args: []*expr{p.expression(p.unaryPrecedence())}, pos: t.pos}
	case p.core && p.take("*"):
		e = &expr{kind: "deref", args: []*expr{p.expression(p.unaryPrecedence())}, pos: t.pos}
	case p.take("("):
		e = p.expression(0)
		p.expect(")")
	case p.take("true"):
		e = &expr{kind: "literal", value: true, pos: t.pos}
	case p.take("false"):
		e = &expr{kind: "literal", value: false, pos: t.pos}
	case p.take("["):
		e = &expr{kind: "array", pos: t.pos}
		if p.peek() != "]" {
			for {
				e.args = append(e.args, p.expression(0))
				if !p.take(",") {
					break
				}
			}
		}
		p.expect("]")
	case p.core && p.take("match"):
		scrutinee := p.expression(0)
		p.expect("{")
		e = &expr{kind: "match", args: []*expr{scrutinee}, pos: t.pos}
		seen := map[string]bool{}
		for p.peek() != "}" {
			armPos := p.tokens[p.at].pos
			variant := p.identifier()
			if seen[variant] {
				p.badCode(DiagnosticParseError, "duplicate match arm %q", variant)
			}
			seen[variant] = true
			binding := ""
			if p.take("(") {
				binding = p.identifier()
				p.expect(")")
			}
			p.expect("=")
			p.expect(">")
			value := p.expression(0)
			e.arms = append(e.arms, exprArm{variant: variant, binding: binding, value: value, pos: armPos})
			if !p.take(",") && p.peek() != "}" {
				p.badCode(DiagnosticUnexpectedToken, "expected comma or closing brace after match arm")
			}
		}
		p.expect("}")
	case p.core && p.take("new"):
		constructorPos := t.pos
		typeName := p.identifier()
		for p.take(".") {
			typeName += "." + p.identifier()
		}
		p.expect("{")
		e = &expr{kind: "struct", name: typeName, pos: constructorPos}
		seen := map[string]bool{}
		if p.peek() != "}" {
			for {
				fieldPos := p.tokens[p.at].pos
				fieldName := p.identifier()
				if seen[fieldName] {
					p.badCode(DiagnosticDuplicateVariable, "duplicate struct field initializer %q", fieldName)
				}
				seen[fieldName] = true
				p.expect(":")
				fieldValue := p.expression(0)
				e.fields = append(e.fields, exprField{name: fieldName, value: fieldValue, pos: fieldPos})
				if !p.take(",") {
					break
				}
				if p.peek() == "}" {
					break
				}
			}
		}
		p.expect("}")
	default:
		if strings.HasPrefix(t.text, "\"") {
			v, err := strconv.Unquote(t.text)
			if err != nil {
				p.badCode(DiagnosticInvalidLiteral, "invalid string")
			}
			p.at++
			e = &expr{kind: "literal", value: v, pos: t.pos}
		} else if v, err := strconv.ParseFloat(t.text, 64); err == nil && !math.IsNaN(v) && !math.IsInf(v, 0) {
			p.at++
			e = &expr{kind: "literal", value: v, lexeme: t.text, pos: t.pos}
		} else {
			parts := []string{p.identifier()}
			positions := []scanner.Position{t.pos}
			for p.take(".") {
				positions = append(positions, p.tokens[p.at].pos)
				parts = append(parts, p.identifier())
			}
			if p.core && p.takeDoubleColon() {
				variantPos := p.tokens[p.at].pos
				variant := p.identifier()
				e = &expr{kind: "enum", name: strings.Join(parts, "."), variant: variant, pos: variantPos}
				if p.take("(") {
					if p.peek() != ")" {
						e.args = append(e.args, p.expression(0))
						if p.take(",") {
							p.badCode(DiagnosticArityMismatch, "enum variant constructor accepts at most one payload")
						}
					}
					p.expect(")")
				}
			} else if p.take("(") {
				e = &expr{kind: "call", name: strings.Join(parts, "."), pos: t.pos}
				if p.peek() != ")" {
					for {
						e.args = append(e.args, p.expression(0))
						if !p.take(",") {
							break
						}
					}
				}
				p.expect(")")
			} else if p.core && len(parts) > 1 {
				e = &expr{kind: "variable", name: parts[0], pos: positions[0]}
				for i := 1; i < len(parts); i++ {
					e = boundedExpression(&expr{kind: "field", name: parts[i], args: []*expr{e}, pos: positions[i]})
				}
			} else {
				e = &expr{kind: "variable", name: strings.Join(parts, "."), pos: t.pos}
			}
		}
	}
	e = boundedExpression(e)
	for p.core {
		if p.take("[") {
			indexPos := p.tokens[p.at-1].pos
			first := p.expression(0)
			if p.take(":") {
				end := p.expression(0)
				p.expect("]")
				e = boundedExpression(&expr{kind: "slice", args: []*expr{e, first, end}, pos: indexPos})
			} else {
				p.expect("]")
				e = boundedExpression(&expr{kind: "index", args: []*expr{e, first}, pos: indexPos})
			}
			continue
		}
		if p.take(".") {
			fieldPos := p.tokens[p.at].pos
			fieldName := p.identifier()
			e = boundedExpression(&expr{kind: "field", name: fieldName, args: []*expr{e}, pos: fieldPos})
			continue
		}
		break
	}
	for {
		op, n := p.operator()
		prec, ok := p.precedence(op)
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
	for _, field := range e.fields {
		if depth := field.value.depth + 1; depth > e.depth {
			e.depth = depth
		}
	}
	for _, arm := range e.arms {
		if depth := arm.value.depth + 1; depth > e.depth {
			e.depth = depth
		}
	}
	if e.depth > 256 {
		panic(diagnosticAt(DiagnosticSyntaxNestingLimit, e.pos, "expression nesting limit exceeded"))
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
	errOut       io.Writer
	steps, depth int
	args         []float64
	started      time.Time
}

// Run executes main with a bounded evaluation budget and call depth.
func (p *Program) Run(out io.Writer, budget int) (err error) {
	return p.RunArgs(out, budget, nil)
}
func (p *Program) RunArgs(out io.Writer, budget int, args []float64) (err error) {
	return p.RunArgsIO(out, out, budget, args)
}

func (p *Program) RunArgsIO(out, errOut io.Writer, budget int, args []float64) (err error) {
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
	r := &runtime{program: p, out: out, errOut: errOut, steps: budget, args: args, started: time.Now()}
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
	if name == "eprint" {
		if _, err := fmt.Fprintln(r.errOut, args...); err != nil {
			panic(failure(pos, "error output failed: %v", err))
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
