// Package hir defines the versioned, language-level declaration model Swyp is
// converging on. V1 intentionally covers qualified identities and typed
// declaration signatures; executable bodies remain on the legacy/Core AST
// during the incremental M1 migration.
package hir

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
)

const Version = 1

type Module struct {
	Version      int           `json:"version"`
	Name         string        `json:"name"`
	Uses         []string      `json:"uses,omitempty"`
	Declarations []Declaration `json:"declarations"`
}

type SymbolID struct {
	Module string `json:"module"`
	Kind   string `json:"kind"`
	Name   string `json:"name"`
}

func (s SymbolID) Canonical() string {
	return s.Module + "::" + s.Kind + "::" + s.Name
}

type TypeRef struct {
	Name   string    `json:"name"`
	Args   []TypeRef `json:"args,omitempty"`
	Length *uint64   `json:"length,omitempty"`
}

type Parameter struct {
	Name string  `json:"name"`
	Type TypeRef `json:"type"`
}

type Function struct {
	Params     []Parameter `json:"params,omitempty"`
	Result     TypeRef     `json:"result"`
	BorrowFrom string      `json:"borrow_from,omitempty"`
	Body       []Statement `json:"body,omitempty"`
}

type Location struct {
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

type Literal struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

type Expression struct {
	Kind     string       `json:"kind"`
	Type     TypeRef      `json:"type"`
	Location Location     `json:"location,omitempty"`
	Literal  *Literal     `json:"literal,omitempty"`
	Name     string       `json:"name,omitempty"`
	Operator string       `json:"operator,omitempty"`
	Builtin  string       `json:"builtin,omitempty"`
	Callee   *SymbolID    `json:"callee,omitempty"`
	Args     []Expression `json:"args,omitempty"`
	Fields   []FieldValue `json:"fields,omitempty"`
	Arms     []MatchArm   `json:"arms,omitempty"`
}

type FieldValue struct {
	Name  string     `json:"name"`
	Value Expression `json:"value"`
}

type MatchArm struct {
	Variant     string     `json:"variant"`
	Binding     string     `json:"binding,omitempty"`
	BindingType *TypeRef   `json:"binding_type,omitempty"`
	Value       Expression `json:"value"`
}

type Statement struct {
	Kind     string      `json:"kind"`
	Location Location    `json:"location,omitempty"`
	Name     string      `json:"name,omitempty"`
	Type     *TypeRef    `json:"type,omitempty"`
	Value    *Expression `json:"value,omitempty"`
	Body     []Statement `json:"body,omitempty"`
	Else     []Statement `json:"else,omitempty"`
}

type Field struct {
	Name string  `json:"name"`
	Type TypeRef `json:"type"`
}

type Variant struct {
	Name    string   `json:"name"`
	Payload *TypeRef `json:"payload,omitempty"`
}

type Declarative struct {
	Base         string         `json:"base,omitempty"`
	Dataset      string         `json:"dataset,omitempty"`
	Capabilities []string       `json:"capabilities,omitempty"`
	Effects      []string       `json:"effects,omitempty"`
	States       []Field        `json:"states,omitempty"`
	Requires     []string       `json:"requires,omitempty"`
	Ensures      []string       `json:"ensures,omitempty"`
	Invariants   []string       `json:"invariants,omitempty"`
	Checks       []string       `json:"checks,omitempty"`
	Forbids      []string       `json:"forbids,omitempty"`
	Verifiers    []string       `json:"verifiers,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
}

type Declaration struct {
	ID          SymbolID     `json:"id"`
	Function    *Function    `json:"function,omitempty"`
	Fields      []Field      `json:"fields,omitempty"`
	Variants    []Variant    `json:"variants,omitempty"`
	Declarative *Declarative `json:"declarative,omitempty"`
}

func (m Module) Validate() error {
	if m.Version != Version {
		return fmt.Errorf("unsupported HIR version %d", m.Version)
	}
	if !validPath(m.Name) {
		return fmt.Errorf("invalid HIR module name %q", m.Name)
	}
	seenUse := map[string]bool{}
	for _, use := range m.Uses {
		if !validPath(use) {
			return fmt.Errorf("invalid HIR use %q", use)
		}
		if use == m.Name {
			return fmt.Errorf("HIR module cannot use itself %q", use)
		}
		if seenUse[use] {
			return fmt.Errorf("duplicate HIR use %q", use)
		}
		seenUse[use] = true
	}
	seenDecl := map[string]bool{}
	for i, d := range m.Declarations {
		if d.ID.Module != m.Name {
			return fmt.Errorf("declaration %d module %q does not match %q", i, d.ID.Module, m.Name)
		}
		if !identifier(d.ID.Kind) || !identifier(d.ID.Name) {
			return fmt.Errorf("declaration %d has invalid identity %+v", i, d.ID)
		}
		key := d.ID.Canonical()
		if seenDecl[key] {
			return fmt.Errorf("duplicate HIR declaration %q", key)
		}
		seenDecl[key] = true
		if d.Function != nil {
			if d.ID.Kind != "fn" {
				return fmt.Errorf("%s carries function signature but kind is %s", key, d.ID.Kind)
			}
			if err := validateFunction(*d.Function); err != nil {
				return fmt.Errorf("%s: %w", key, err)
			}
		}
		if len(d.Fields) > 0 {
			if d.ID.Kind != "record" && d.ID.Kind != "struct" {
				return fmt.Errorf("%s carries fields but kind is %s", key, d.ID.Kind)
			}
			if err := validateFields(d.Fields); err != nil {
				return fmt.Errorf("%s: %w", key, err)
			}
		}
		if len(d.Variants) > 0 {
			if d.ID.Kind != "enum" {
				return fmt.Errorf("%s carries variants but kind is %s", key, d.ID.Kind)
			}
			if err := validateVariants(d.Variants); err != nil {
				return fmt.Errorf("%s: %w", key, err)
			}
		}
		if d.ID.Kind == "struct" && len(d.Fields) == 0 {
			return fmt.Errorf("%s struct must contain at least one field", key)
		}
		if d.ID.Kind == "enum" && len(d.Variants) == 0 {
			return fmt.Errorf("%s enum must contain at least one variant", key)
		}
		if d.Declarative != nil {
			if err := validateDeclarative(*d.Declarative); err != nil {
				return fmt.Errorf("%s: %w", key, err)
			}
		}
		if d.ID.Kind == "fn" && d.Function == nil {
			return fmt.Errorf("%s is missing function signature", key)
		}
	}
	return nil
}

func validateDeclarative(d Declarative) error {
	if d.Base != "" && !validPath(d.Base) {
		return fmt.Errorf("invalid base symbol %q", d.Base)
	}
	if d.Dataset != "" && !validPath(d.Dataset) {
		return fmt.Errorf("invalid dataset symbol %q", d.Dataset)
	}
	for _, values := range [][]string{d.Capabilities, d.Effects, d.Verifiers} {
		seen := map[string]bool{}
		for _, value := range values {
			if !validPath(value) {
				return fmt.Errorf("invalid qualified reference %q", value)
			}
			if seen[value] {
				return fmt.Errorf("duplicate qualified reference %q", value)
			}
			seen[value] = true
		}
	}
	if err := validateFields(d.States); err != nil {
		return fmt.Errorf("states: %w", err)
	}
	return nil
}

func (m Module) CanonicalJSON() ([]byte, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return json.MarshalIndent(m, "", "  ")
}

func validateFunction(f Function) error {
	seen := map[string]bool{}
	paramTypes := map[string]TypeRef{}
	for _, p := range f.Params {
		if !identifier(p.Name) {
			return fmt.Errorf("invalid parameter name %q", p.Name)
		}
		if seen[p.Name] {
			return fmt.Errorf("duplicate parameter %q", p.Name)
		}
		seen[p.Name] = true
		paramTypes[p.Name] = p.Type
		if err := validateType(p.Type, 0); err != nil {
			return fmt.Errorf("parameter %s: %w", p.Name, err)
		}
	}
	if err := validateType(f.Result, 0); err != nil {
		return fmt.Errorf("result: %w", err)
	}
	if f.BorrowFrom != "" {
		if !identifier(f.BorrowFrom) {
			return fmt.Errorf("invalid borrow_from parameter %q", f.BorrowFrom)
		}
		paramType, ok := paramTypes[f.BorrowFrom]
		if !ok {
			return fmt.Errorf("borrow_from %q is not a function parameter", f.BorrowFrom)
		}
		if !borrowType(paramType) {
			return fmt.Errorf("borrow_from %q must name ref<T>, mutref<T> or slice<T>, got %s", f.BorrowFrom, typeString(paramType))
		}
		if !borrowType(f.Result) {
			return fmt.Errorf("borrow_from requires borrowed result type, got %s", typeString(f.Result))
		}
	}
	if err := validateStatements(f.Body, 0); err != nil {
		return fmt.Errorf("body: %w", err)
	}
	if err := validateTypedBody(f); err != nil {
		return fmt.Errorf("body types: %w", err)
	}
	return nil
}

func borrowType(t TypeRef) bool {
	if len(t.Args) != 1 || t.Length != nil {
		return false
	}
	switch t.Name {
	case "ref", "mutref", "slice":
		return true
	default:
		return false
	}
}

type typeScope struct {
	vars   map[string]TypeRef
	parent *typeScope
}

func (s *typeScope) lookup(name string) (TypeRef, bool) {
	for cur := s; cur != nil; cur = cur.parent {
		if typ, ok := cur.vars[name]; ok {
			return typ, true
		}
	}
	return TypeRef{}, false
}

func validateTypedBody(f Function) error {
	root := &typeScope{vars: map[string]TypeRef{}}
	for _, param := range f.Params {
		root.vars[param.Name] = param.Type
	}
	return validateTypedStatements(f.Body, root, f.Result)
}

func validateTypedStatements(body []Statement, parent *typeScope, result TypeRef) error {
	scope := &typeScope{vars: map[string]TypeRef{}, parent: parent}
	for i, stmt := range body {
		if stmt.Value != nil {
			if err := validateTypedExpression(*stmt.Value, scope); err != nil {
				return fmt.Errorf("statement %d: %w", i, err)
			}
		}
		switch stmt.Kind {
		case "let":
			if _, duplicate := scope.vars[stmt.Name]; duplicate {
				return fmt.Errorf("duplicate local %q", stmt.Name)
			}
			if stmt.Type == nil || stmt.Value == nil || !sameType(*stmt.Type, stmt.Value.Type) {
				return fmt.Errorf("let %s type does not match value", stmt.Name)
			}
			if stmt.Type.Name == "void" {
				return fmt.Errorf("let %s cannot store void", stmt.Name)
			}
			scope.vars[stmt.Name] = *stmt.Type
		case "assign":
			want, ok := scope.lookup(stmt.Name)
			if !ok {
				return fmt.Errorf("assignment to unknown local %q", stmt.Name)
			}
			if stmt.Value == nil || !sameType(want, stmt.Value.Type) {
				return fmt.Errorf("assignment to %s has mismatched type", stmt.Name)
			}
		case "return":
			if stmt.Value == nil {
				return fmt.Errorf("return is missing value")
			}
			if !sameType(result, stmt.Value.Type) {
				return fmt.Errorf("return type %s does not match %s", typeString(stmt.Value.Type), typeString(result))
			}
		case "if", "while":
			if stmt.Value == nil || stmt.Value.Type.Name != "bool" {
				return fmt.Errorf("%s condition must be bool", stmt.Kind)
			}
			if err := validateTypedStatements(stmt.Body, scope, result); err != nil {
				return err
			}
			if err := validateTypedStatements(stmt.Else, scope, result); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateTypedExpression(e Expression, scope *typeScope) error {
	if e.Kind == "variable" {
		want, ok := scope.lookup(e.Name)
		if !ok {
			return fmt.Errorf("unknown local %q", e.Name)
		}
		if !sameType(want, e.Type) {
			return fmt.Errorf("local %s expression type %s does not match %s", e.Name, typeString(e.Type), typeString(want))
		}
	}
	for _, arg := range e.Args {
		if err := validateTypedExpression(arg, scope); err != nil {
			return err
		}
	}
	for _, field := range e.Fields {
		if err := validateTypedExpression(field.Value, scope); err != nil {
			return fmt.Errorf("field %s: %w", field.Name, err)
		}
	}
	for _, arm := range e.Arms {
		armScope := &typeScope{vars: map[string]TypeRef{}, parent: scope}
		if arm.Binding != "" {
			if arm.BindingType == nil {
				return fmt.Errorf("match arm %s binding is missing type", arm.Variant)
			}
			armScope.vars[arm.Binding] = *arm.BindingType
		}
		if err := validateTypedExpression(arm.Value, armScope); err != nil {
			return fmt.Errorf("match arm %s: %w", arm.Variant, err)
		}
		if !sameType(e.Type, arm.Value.Type) {
			return fmt.Errorf("match arm %s type %s does not match %s", arm.Variant, typeString(arm.Value.Type), typeString(e.Type))
		}
	}
	if e.Kind == "call" && (e.Builtin == "vec_len" || e.Builtin == "vec_capacity") {
		if len(e.Args) != 1 || e.Args[0].Type.Name != "vec" || len(e.Args[0].Type.Args) != 1 || e.Args[0].Type.Length != nil || e.Type.Name != "u64" || len(e.Type.Args) != 0 || e.Type.Length != nil {
			return fmt.Errorf("%s requires vec<T> and returns u64", e.Builtin)
		}
	}
	if e.Kind == "call" && e.Builtin == "vec_push" {
		if len(e.Args) != 2 || e.Args[0].Type.Name != "vec" || len(e.Args[0].Type.Args) != 1 || e.Args[0].Type.Length != nil || !sameType(e.Args[0].Type.Args[0], e.Args[1].Type) || e.Type.Name != "void" || len(e.Type.Args) != 0 || e.Type.Length != nil {
			return fmt.Errorf("vec_push requires vec<T>, T and returns void")
		}
	}
	if e.Kind == "unary" {
		if len(e.Args) != 1 {
			return fmt.Errorf("unary %s requires one operand", e.Operator)
		}
		arg := e.Args[0].Type
		switch e.Operator {
		case "!":
			if arg.Name != "bool" || e.Type.Name != "bool" {
				return fmt.Errorf("logical not requires bool")
			}
		case "-":
			if !numericType(arg) || !sameType(arg, e.Type) {
				return fmt.Errorf("numeric negation type mismatch")
			}
		default:
			return fmt.Errorf("unsupported unary operator %q", e.Operator)
		}
	}
	if e.Kind == "binary" {
		if len(e.Args) != 2 {
			return fmt.Errorf("binary %s requires two operands", e.Operator)
		}
		left, right := e.Args[0].Type, e.Args[1].Type
		if !sameType(left, right) {
			return fmt.Errorf("binary %s operand types differ", e.Operator)
		}
		switch e.Operator {
		case "&&", "||":
			if left.Name != "bool" || e.Type.Name != "bool" {
				return fmt.Errorf("logical %s requires bool", e.Operator)
			}
		case "==", "!=":
			if e.Type.Name != "bool" || left.Name == "void" {
				return fmt.Errorf("equality %s has invalid types", e.Operator)
			}
		case "<", "<=", ">", ">=":
			if !numericType(left) || e.Type.Name != "bool" {
				return fmt.Errorf("comparison %s requires numeric operands", e.Operator)
			}
		case "+":
			if !(numericType(left) || left.Name == "string") || !sameType(left, e.Type) {
				return fmt.Errorf("addition has invalid types")
			}
		case "-", "*", "/", "%":
			if !numericType(left) || !sameType(left, e.Type) {
				return fmt.Errorf("arithmetic %s has invalid types", e.Operator)
			}
		case "&", "|", "^", "<<", ">>":
			if left.Name != "u64" || !sameType(left, e.Type) {
				return fmt.Errorf("integer operator %s has invalid types", e.Operator)
			}
		default:
			return fmt.Errorf("unsupported binary operator %q", e.Operator)
		}
	}
	if e.Kind == "array" {
		if e.Type.Name != "array" || len(e.Type.Args) != 1 || e.Type.Length == nil {
			return fmt.Errorf("array literal requires array<T,N> type")
		}
		if uint64(len(e.Args)) != *e.Type.Length {
			return fmt.Errorf("array literal length %d does not match %d", len(e.Args), *e.Type.Length)
		}
		for i, arg := range e.Args {
			if !sameType(arg.Type, e.Type.Args[0]) {
				return fmt.Errorf("array element %d type %s does not match %s", i, typeString(arg.Type), typeString(e.Type.Args[0]))
			}
		}
	}
	if e.Kind == "vec" {
		if e.Type.Name != "vec" || len(e.Type.Args) != 1 || e.Type.Length != nil {
			return fmt.Errorf("vec literal requires vec<T> type")
		}
		for i, arg := range e.Args {
			if !sameType(arg.Type, e.Type.Args[0]) {
				return fmt.Errorf("vec element %d type %s does not match %s", i, typeString(arg.Type), typeString(e.Type.Args[0]))
			}
		}
	}
	if e.Kind == "index" {
		if len(e.Args) != 2 {
			return fmt.Errorf("index expression requires base and index operands")
		}
		base, index := e.Args[0], e.Args[1]
		if (base.Type.Name != "array" && base.Type.Name != "slice" && base.Type.Name != "vec") || len(base.Type.Args) != 1 || (base.Type.Name == "array" && base.Type.Length == nil) {
			return fmt.Errorf("index base must be array<T,N>, slice<T> or vec<T>")
		}
		if index.Type.Name != "u64" {
			return fmt.Errorf("index must be u64")
		}
		if !sameType(e.Type, base.Type.Args[0]) {
			return fmt.Errorf("index result type %s does not match element type %s", typeString(e.Type), typeString(base.Type.Args[0]))
		}
	}
	if e.Kind == "slice" {
		if len(e.Args) != 3 {
			return fmt.Errorf("slice expression requires base, start and end")
		}
		base, start, end := e.Args[0], e.Args[1], e.Args[2]
		if (base.Type.Name != "array" && base.Type.Name != "slice" && base.Type.Name != "vec") || len(base.Type.Args) != 1 || (base.Type.Name == "array" && base.Type.Length == nil) {
			return fmt.Errorf("slice base must be array<T,N>, slice<T> or vec<T>")
		}
		if start.Type.Name != "u64" || end.Type.Name != "u64" {
			return fmt.Errorf("slice bounds must be u64")
		}
		want := TypeRef{Name: "slice", Args: []TypeRef{base.Type.Args[0]}}
		if !sameType(e.Type, want) {
			return fmt.Errorf("slice result type %s does not match %s", typeString(e.Type), typeString(want))
		}
	}
	if e.Kind == "struct" {
		if len(e.Fields) == 0 {
			return fmt.Errorf("struct construction requires at least one field")
		}
		seen := map[string]bool{}
		for _, field := range e.Fields {
			if !identifier(field.Name) {
				return fmt.Errorf("invalid struct field name %q", field.Name)
			}
			if seen[field.Name] {
				return fmt.Errorf("duplicate struct field %q", field.Name)
			}
			seen[field.Name] = true
		}
	}
	if e.Kind == "field" {
		if len(e.Args) != 1 || !identifier(e.Name) {
			return fmt.Errorf("field projection requires one base and a field name")
		}
	}
	if e.Kind == "enum" {
		if !identifier(e.Name) || len(e.Args) > 1 {
			return fmt.Errorf("enum construction requires variant name and zero/one payload")
		}
	}
	if e.Kind == "match" {
		if len(e.Args) != 1 || len(e.Arms) == 0 {
			return fmt.Errorf("match requires one scrutinee and at least one arm")
		}
		seen := map[string]bool{}
		for _, arm := range e.Arms {
			if !identifier(arm.Variant) || seen[arm.Variant] {
				return fmt.Errorf("invalid or duplicate match variant %q", arm.Variant)
			}
			seen[arm.Variant] = true
			if arm.Binding != "" && !identifier(arm.Binding) {
				return fmt.Errorf("invalid match binding %q", arm.Binding)
			}
		}
	}
	if e.Kind == "borrow" {
		if len(e.Args) != 1 || (e.Operator != "shared" && e.Operator != "mut") {
			return fmt.Errorf("borrow requires one operand and shared/mut mode")
		}
		wantName := "ref"
		if e.Operator == "mut" {
			wantName = "mutref"
		}
		if e.Type.Name != wantName || len(e.Type.Args) != 1 || e.Type.Length != nil || !sameType(e.Type.Args[0], e.Args[0].Type) {
			return fmt.Errorf("borrow result type does not match operand")
		}
	}
	if e.Kind == "deref" {
		if len(e.Args) != 1 {
			return fmt.Errorf("deref requires one operand")
		}
		arg := e.Args[0].Type
		if (arg.Name != "ref" && arg.Name != "mutref") || len(arg.Args) != 1 || arg.Length != nil || !sameType(e.Type, arg.Args[0]) {
			return fmt.Errorf("deref requires ref<T>/mutref<T> and returns T")
		}
	}
	if e.Kind == "call" && e.Builtin == "drop" {
		if len(e.Args) != 1 || e.Args[0].Type.Name == "void" || e.Type.Name != "void" {
			return fmt.Errorf("drop requires one non-void argument and returns void")
		}
	}
	if e.Kind == "call" && e.Builtin == "defer_drop" {
		if len(e.Args) != 1 || e.Args[0].Kind != "variable" || e.Args[0].Type.Name == "void" || e.Type.Name != "void" {
			return fmt.Errorf("defer_drop requires one local non-void variable and returns void")
		}
	}
	if e.Kind == "call" && e.Builtin == "store" {
		if len(e.Args) != 2 || e.Type.Name != "void" {
			return fmt.Errorf("store requires mutref and value arguments and returns void")
		}
		ref := e.Args[0].Type
		if ref.Name != "mutref" || len(ref.Args) != 1 || ref.Length != nil || !sameType(ref.Args[0], e.Args[1].Type) {
			return fmt.Errorf("store value type must match mutref<T>")
		}
	}
	return nil
}

func numericType(t TypeRef) bool {
	switch t.Name {
	case "number", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f16", "bf16", "f32", "f64", "finite32", "finite64", "ieee64":
		return true
	default:
		return false
	}
}

func integerType(t TypeRef) bool {
	switch t.Name {
	case "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128":
		return true
	default:
		return false
	}
}

func validateStatements(body []Statement, depth int) error {
	if depth > 64 {
		return fmt.Errorf("statement nesting exceeds 64")
	}
	for i, s := range body {
		switch s.Kind {
		case "let":
			if !identifier(s.Name) || s.Type == nil || s.Value == nil {
				return fmt.Errorf("statement %d malformed let", i)
			}
			if err := validateType(*s.Type, 0); err != nil {
				return fmt.Errorf("statement %d let type: %w", i, err)
			}
		case "assign":
			if !identifier(s.Name) || s.Value == nil {
				return fmt.Errorf("statement %d malformed assign", i)
			}
		case "expr", "return":
			if s.Value == nil {
				return fmt.Errorf("statement %d %s requires value", i, s.Kind)
			}
		case "if":
			if s.Value == nil {
				return fmt.Errorf("statement %d if requires condition", i)
			}
			if err := validateStatements(s.Body, depth+1); err != nil {
				return err
			}
			if err := validateStatements(s.Else, depth+1); err != nil {
				return err
			}
		case "while":
			if s.Value == nil {
				return fmt.Errorf("statement %d while requires condition", i)
			}
			if err := validateStatements(s.Body, depth+1); err != nil {
				return err
			}
		default:
			return fmt.Errorf("statement %d has unsupported kind %q", i, s.Kind)
		}
		if s.Value != nil {
			if err := validateExpression(*s.Value, 0); err != nil {
				return fmt.Errorf("statement %d: %w", i, err)
			}
		}
	}
	return nil
}

func validateExpression(e Expression, depth int) error {
	if depth > 128 {
		return fmt.Errorf("expression nesting exceeds 128")
	}
	if err := validateType(e.Type, 0); err != nil {
		return fmt.Errorf("expression type: %w", err)
	}
	switch e.Kind {
	case "literal":
		if e.Literal == nil || e.Literal.Kind == "" {
			return fmt.Errorf("literal expression is missing literal payload")
		}
	case "variable":
		if !identifier(e.Name) {
			return fmt.Errorf("invalid variable name %q", e.Name)
		}
	case "call":
		if (e.Builtin == "") == (e.Callee == nil) {
			return fmt.Errorf("call must specify exactly one of builtin or callee")
		}
		if e.Builtin != "" && !identifier(e.Builtin) {
			return fmt.Errorf("invalid builtin name %q", e.Builtin)
		}
		if e.Callee != nil && (!validPath(e.Callee.Module) || e.Callee.Kind != "fn" || !identifier(e.Callee.Name)) {
			return fmt.Errorf("invalid call target %+v", *e.Callee)
		}
	case "array":
		if e.Type.Name != "array" || e.Type.Length == nil || len(e.Type.Args) != 1 {
			return fmt.Errorf("array expression requires array<T,N> type")
		}
	case "vec":
		if e.Type.Name != "vec" || e.Type.Length != nil || len(e.Type.Args) != 1 {
			return fmt.Errorf("vec expression requires vec<T> type")
		}
	case "index":
		if len(e.Args) != 2 {
			return fmt.Errorf("index expression requires exactly two operands")
		}
	case "slice":
		if len(e.Args) != 3 {
			return fmt.Errorf("slice expression requires exactly three operands")
		}
	case "struct":
		if len(e.Fields) == 0 || len(e.Args) != 0 {
			return fmt.Errorf("struct expression requires named fields and no positional arguments")
		}
		seen := map[string]bool{}
		for _, field := range e.Fields {
			if !identifier(field.Name) || seen[field.Name] {
				return fmt.Errorf("invalid or duplicate struct field %q", field.Name)
			}
			seen[field.Name] = true
		}
	case "field":
		if len(e.Args) != 1 || !identifier(e.Name) {
			return fmt.Errorf("field expression requires one base and field name")
		}
	case "enum":
		if !identifier(e.Name) || len(e.Args) > 1 {
			return fmt.Errorf("enum expression requires variant and zero/one payload")
		}
	case "match":
		if len(e.Args) != 1 || len(e.Arms) == 0 {
			return fmt.Errorf("match expression requires one scrutinee and arms")
		}
		seen := map[string]bool{}
		for _, arm := range e.Arms {
			if !identifier(arm.Variant) || seen[arm.Variant] {
				return fmt.Errorf("invalid or duplicate match variant %q", arm.Variant)
			}
			seen[arm.Variant] = true
			if arm.Binding != "" {
				if !identifier(arm.Binding) || arm.BindingType == nil {
					return fmt.Errorf("match arm %s has invalid binding", arm.Variant)
				}
				if err := validateType(*arm.BindingType, 0); err != nil {
					return fmt.Errorf("match arm %s binding type: %w", arm.Variant, err)
				}
			} else if arm.BindingType != nil {
				return fmt.Errorf("match arm %s has binding type without binding", arm.Variant)
			}
		}
	case "borrow":
		if len(e.Args) != 1 || (e.Operator != "shared" && e.Operator != "mut") {
			return fmt.Errorf("borrow expression requires one operand and shared/mut mode")
		}
	case "deref":
		if len(e.Args) != 1 {
			return fmt.Errorf("deref expression requires one operand")
		}
	case "unary", "binary":
		if e.Operator == "" {
			return fmt.Errorf("%s expression is missing operator", e.Kind)
		}
	default:
		return fmt.Errorf("unsupported expression kind %q", e.Kind)
	}
	for _, arg := range e.Args {
		if err := validateExpression(arg, depth+1); err != nil {
			return err
		}
	}
	for _, field := range e.Fields {
		if err := validateExpression(field.Value, depth+1); err != nil {
			return fmt.Errorf("field %s: %w", field.Name, err)
		}
	}
	for _, arm := range e.Arms {
		if err := validateExpression(arm.Value, depth+1); err != nil {
			return fmt.Errorf("match arm %s: %w", arm.Variant, err)
		}
	}
	return nil
}

func validateFields(fields []Field) error {
	seen := map[string]bool{}
	for _, f := range fields {
		if !identifier(f.Name) {
			return fmt.Errorf("invalid field name %q", f.Name)
		}
		if seen[f.Name] {
			return fmt.Errorf("duplicate field %q", f.Name)
		}
		seen[f.Name] = true
		if err := validateType(f.Type, 0); err != nil {
			return fmt.Errorf("field %s: %w", f.Name, err)
		}
	}
	return nil
}

func validateVariants(variants []Variant) error {
	seen := map[string]bool{}
	for _, v := range variants {
		if !identifier(v.Name) {
			return fmt.Errorf("invalid variant name %q", v.Name)
		}
		if seen[v.Name] {
			return fmt.Errorf("duplicate variant %q", v.Name)
		}
		seen[v.Name] = true
		if v.Payload != nil {
			if err := validateType(*v.Payload, 0); err != nil {
				return fmt.Errorf("variant %s payload: %w", v.Name, err)
			}
			if v.Payload.Name == "void" {
				return fmt.Errorf("variant %s cannot carry void", v.Name)
			}
		}
	}
	return nil
}

func validateType(t TypeRef, depth int) error {
	if depth > 32 {
		return fmt.Errorf("type nesting exceeds 32")
	}
	if !validPath(t.Name) {
		return fmt.Errorf("invalid type name %q", t.Name)
	}
	if depth > 0 && t.Name == "void" {
		return fmt.Errorf("void cannot be nested inside another type")
	}
	switch t.Name {
	case "array":
		if len(t.Args) != 1 || t.Length == nil {
			return fmt.Errorf("array requires exactly one element type and a length")
		}
	case "slice", "vec", "option", "opaque", "ref", "mutref":
		if len(t.Args) != 1 || t.Length != nil {
			return fmt.Errorf("%s requires exactly one type argument", t.Name)
		}
	case "result":
		if len(t.Args) != 2 || t.Length != nil {
			return fmt.Errorf("result requires exactly two type arguments")
		}
	case "tuple":
		if len(t.Args) == 0 || t.Length != nil {
			return fmt.Errorf("tuple requires at least one type argument")
		}
	default:
		if len(t.Args) != 0 || t.Length != nil {
			return fmt.Errorf("type %s does not accept type arguments or length", t.Name)
		}
	}
	for _, arg := range t.Args {
		if err := validateType(arg, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func identifier(text string) bool {
	if text == "" {
		return false
	}
	for i, r := range text {
		if r == '_' || unicode.IsLetter(r) || (i > 0 && unicode.IsDigit(r)) {
			continue
		}
		return false
	}
	return true
}

func validPath(path string) bool {
	parts := strings.Split(path, ".")
	if len(parts) == 0 {
		return false
	}
	for _, part := range parts {
		if !identifier(part) {
			return false
		}
	}
	return true
}
