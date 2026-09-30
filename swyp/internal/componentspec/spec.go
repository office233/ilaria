// Package componentspec implements Swyp's declarative component layer.
//
// It is intentionally separate from the scalar/program parser: component
// manifests describe architecture, authority and verification contracts, while
// the existing Semantic Core remains the deterministic executable subset.
package componentspec

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"text/scanner"
	"unicode"

	"swyp-lang/internal/sourcefront"
)

const (
	Version          = 1
	maxSourceBytes   = 1 << 20
	maxDeclarations  = 4096
	maxFieldsPerDecl = 4096
)

// Manifest is the canonical, serializable form produced from a Swyp component
// source file.
type Manifest struct {
	Version      int           `json:"version"`
	Module       string        `json:"module,omitempty"`
	Uses         []string      `json:"uses,omitempty"`
	Declarations []Declaration `json:"declarations"`
}

// Declaration is one architecture declaration. Fields that do not apply to a
// declaration kind are omitted from the canonical JSON.
type Declaration struct {
	Kind         string         `json:"kind"`
	Name         string         `json:"name"`
	Base         string         `json:"base,omitempty"`
	Dataset      string         `json:"dataset,omitempty"`
	Capabilities []string       `json:"capabilities,omitempty"`
	Effects      []string       `json:"effects,omitempty"`
	States       []State        `json:"states,omitempty"`
	Requires     []string       `json:"requires,omitempty"`
	Ensures      []string       `json:"ensures,omitempty"`
	Invariants   []string       `json:"invariants,omitempty"`
	Checks       []string       `json:"checks,omitempty"`
	Forbids      []string       `json:"forbids,omitempty"`
	Verifiers    []string       `json:"verifiers,omitempty"`
	Fields       []Field        `json:"fields,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
}

type State struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Field is a typed field in a declarative record. Record types are the stable
// protocol/ABI surface generated into host-language DTOs.
type Field struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type token struct {
	text string
	pos  scanner.Position
}

type parser struct {
	tokens []token
	at     int
}

// Parse parses and semantically validates a Swyp component manifest.
func Parse(filename, source string) (_ Manifest, err error) {
	if len(source) > maxSourceBytes {
		return Manifest{}, fmt.Errorf("%s: source exceeds 1 MiB limit", filename)
	}
	preamble, parseBody, err := sourcefront.ParsePreamble(filename, source)
	if err != nil {
		return Manifest{}, err
	}
	var s scanner.Scanner
	s.Init(strings.NewReader(parseBody))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanInts | scanner.ScanStrings | scanner.ScanComments | scanner.SkipComments
	var lexical error
	s.Error = func(s *scanner.Scanner, message string) {
		if lexical == nil {
			lexical = fmt.Errorf("%s: %s", s.Position, message)
		}
	}
	p := &parser{}
	for k := s.Scan(); k != scanner.EOF; k = s.Scan() {
		p.tokens = append(p.tokens, token{text: s.TokenText(), pos: s.Position})
	}
	if lexical != nil {
		return Manifest{}, lexical
	}
	p.tokens = append(p.tokens, token{text: "<eof>", pos: s.Pos()})

	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
				return
			}
			panic(r)
		}
	}()

	m := Manifest{Version: Version, Module: preamble.Module, Uses: append([]string(nil), preamble.Uses...)}
	for p.peek() != "<eof>" {
		if len(m.Declarations) >= maxDeclarations {
			p.fail("declaration limit exceeded")
		}
		m.Declarations = append(m.Declarations, p.declaration())
	}
	if err := m.Validate(); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

func (p *parser) declaration() Declaration {
	kind := p.peek()
	switch kind {
	case "component", "capability", "effect", "contract", "task", "agent", "driver", "model", "expert", "dataset", "train", "verify", "record":
		p.at++
	default:
		p.fail("expected component declaration, got %q", kind)
	}

	d := Declaration{Kind: kind, Properties: map[string]any{}}
	d.Name = p.ident()
	if kind == "expert" {
		p.expect(":")
		d.Base = p.path()
	}
	if kind == "train" {
		p.expect("on")
		d.Dataset = p.path()
	}
	p.expect("{")
	fields := 0
	for p.peek() != "}" {
		if p.peek() == "<eof>" {
			p.fail("expected closing brace for %s %s", d.Kind, d.Name)
		}
		fields++
		if fields > maxFieldsPerDecl {
			p.fail("field limit exceeded in %s %s", d.Kind, d.Name)
		}
		p.field(&d)
	}
	p.expect("}")
	if len(d.Properties) == 0 {
		d.Properties = nil
	}
	return d
}

func (p *parser) field(d *Declaration) {
	key := p.ident()
	switch key {
	case "capability":
		d.Capabilities = appendUnique(d.Capabilities, p.path())
	case "effect":
		d.Effects = appendUnique(d.Effects, p.path())
	case "state":
		name := p.ident()
		p.expect(":")
		d.States = append(d.States, State{Name: name, Type: p.path()})
	case "field":
		name := p.ident()
		p.expect(":")
		d.Fields = append(d.Fields, Field{Name: name, Type: p.path()})
	case "requires":
		d.Requires = append(d.Requires, p.textValue())
	case "ensures":
		d.Ensures = append(d.Ensures, p.textValue())
	case "invariant":
		d.Invariants = append(d.Invariants, p.textValue())
	case "check":
		d.Checks = appendUnique(d.Checks, p.pathOrString())
	case "forbid":
		d.Forbids = appendUnique(d.Forbids, p.pathOrString())
	case "require":
		d.Requires = appendUnique(d.Requires, p.pathOrString())
	case "verify":
		d.Verifiers = appendUnique(d.Verifiers, p.path())
	case "property":
		name := p.ident()
		if _, exists := d.Properties[name]; exists {
			p.fail("duplicate property %q", name)
		}
		d.Properties[name] = p.scalar()
	default:
		if _, exists := d.Properties[key]; exists {
			p.fail("duplicate property %q", key)
		}
		d.Properties[key] = p.scalar()
	}
	p.expect(";")
}

func (p *parser) scalar() any {
	t := p.peekToken()
	if strings.HasPrefix(t.text, "\"") {
		p.at++
		v, err := strconv.Unquote(t.text)
		if err != nil {
			p.fail("invalid string")
		}
		return v
	}
	if t.text == "true" || t.text == "false" {
		p.at++
		return t.text == "true"
	}
	if n, err := strconv.ParseInt(t.text, 10, 64); err == nil {
		p.at++
		return n
	}
	return p.path()
}

func (p *parser) textValue() string {
	t := p.peekToken()
	if strings.HasPrefix(t.text, "\"") {
		p.at++
		v, err := strconv.Unquote(t.text)
		if err != nil {
			p.fail("invalid string")
		}
		return v
	}
	return p.path()
}

func (p *parser) pathOrString() string {
	return p.textValue()
}

func (p *parser) path() string {
	parts := []string{p.ident()}
	for p.take(".") {
		parts = append(parts, p.ident())
	}
	return strings.Join(parts, ".")
}

func (p *parser) ident() string {
	t := p.peek()
	if t == "<eof>" || t == "" {
		p.fail("expected identifier, got %q", t)
	}
	for i, r := range t {
		if r != '_' && !unicode.IsLetter(r) && !(i > 0 && unicode.IsDigit(r)) {
			p.fail("expected identifier, got %q", t)
		}
	}
	p.at++
	return t
}

func (p *parser) peek() string     { return p.tokens[p.at].text }
func (p *parser) peekToken() token { return p.tokens[p.at] }
func (p *parser) take(s string) bool {
	if p.peek() == s {
		p.at++
		return true
	}
	return false
}
func (p *parser) expect(s string) {
	if !p.take(s) {
		p.fail("expected %q, got %q", s, p.peek())
	}
}
func (p *parser) fail(format string, args ...any) {
	panic(fmt.Errorf("%s: %s", p.peekToken().pos, fmt.Sprintf(format, args...)))
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

// Validate checks cross-declaration references and kind-specific invariants.
func (m Manifest) Validate() error {
	if m.Version != Version {
		return fmt.Errorf("unsupported component manifest version %d", m.Version)
	}
	byName := make(map[string]Declaration, len(m.Declarations))
	for _, d := range m.Declarations {
		// A train declaration names its target expert, so sharing that name is
		// intentional. All declarations that introduce symbols remain unique.
		if d.Kind != "train" {
			if _, exists := byName[d.Name]; exists {
				return fmt.Errorf("duplicate declaration %q", d.Name)
			}
			byName[d.Name] = d
		}
		if err := validateDeclaration(d); err != nil {
			return fmt.Errorf("%s %s: %w", d.Kind, d.Name, err)
		}
	}
	for _, d := range m.Declarations {
		if d.Kind == "expert" {
			base, ok := byName[d.Base]
			if !ok {
				return fmt.Errorf("expert %s: unknown base model %q", d.Name, d.Base)
			}
			if base.Kind != "model" {
				return fmt.Errorf("expert %s: base %q is %s, not model", d.Name, d.Base, base.Kind)
			}
		}
		if d.Kind == "train" {
			target, ok := byName[d.Name]
			if !ok || target.Kind != "expert" {
				return fmt.Errorf("train %s: target must name a declared expert", d.Name)
			}
			dataset, ok := byName[d.Dataset]
			if !ok || dataset.Kind != "dataset" {
				return fmt.Errorf("train %s: dataset %q is not declared", d.Name, d.Dataset)
			}
		}
	}
	return nil
}

func validateDeclaration(d Declaration) error {
	propString := func(name string) string {
		v, ok := d.Properties[name]
		if !ok {
			return ""
		}
		s, _ := v.(string)
		return s
	}
	propPositive := func(name string) bool {
		v, ok := d.Properties[name]
		if !ok {
			return false
		}
		switch n := v.(type) {
		case int64:
			return n > 0
		case float64:
			return n > 0 && n == float64(int64(n))
		default:
			return false
		}
	}
	switch d.Kind {
	case "model":
		for _, key := range []string{"architecture", "weights", "storage", "compute"} {
			if propString(key) == "" {
				return fmt.Errorf("missing %s property", key)
			}
		}
	case "expert":
		if d.Base == "" {
			return fmt.Errorf("missing base model")
		}
		if propString("specialty") == "" {
			return fmt.Errorf("missing specialty property")
		}
	case "effect":
		if len(d.Capabilities) == 0 {
			return fmt.Errorf("effect must require at least one capability")
		}
	case "verify":
		if len(d.Checks) == 0 {
			return fmt.Errorf("verify declaration must contain at least one check")
		}
	case "train":
		if d.Dataset == "" {
			return fmt.Errorf("missing dataset")
		}
		if !propPositive("cohort") {
			return fmt.Errorf("cohort must be a positive integer")
		}
		if !propPositive("local_steps") {
			return fmt.Errorf("local_steps must be a positive integer")
		}
		if propString("optimizer") == "" {
			return fmt.Errorf("missing optimizer property")
		}
	case "record":
		if len(d.Fields) == 0 {
			return fmt.Errorf("record must contain at least one field")
		}
		seen := make(map[string]bool, len(d.Fields))
		for _, f := range d.Fields {
			if seen[f.Name] {
				return fmt.Errorf("duplicate field %q", f.Name)
			}
			seen[f.Name] = true
			if !supportedRecordType(f.Type) {
				return fmt.Errorf("field %s has unsupported type %q", f.Name, f.Type)
			}
		}
	}
	return nil
}

func supportedRecordType(t string) bool {
	switch t {
	case "string", "bool", "i64", "u64", "bytes", "string_list", "string_map":
		return true
	default:
		return false
	}
}

// CanonicalJSON returns the validated manifest using a stable JSON shape.
func (m Manifest) CanonicalJSON() ([]byte, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return json.MarshalIndent(m, "", "  ")
}
