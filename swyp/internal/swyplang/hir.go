package swyplang

import (
	"sort"
	"strconv"
	"strings"
	"text/scanner"

	"swyp-lang/internal/hir"
)

// HIRDeclarations converts the currently parsed executable module into the M1
// declaration HIR. Function bodies deliberately remain on the existing AST;
// this layer establishes stable qualified identities and typed signatures first.
func (p *Program) HIRDeclarations() (hir.Module, error) {
	if p == nil {
		return hir.Module{}, diagnosticMessage(DiagnosticParseError, "nil source program")
	}
	if p.module == "" {
		return hir.Module{}, diagnosticMessage(DiagnosticModulePreamble, "HIR requires an explicit module declaration")
	}
	m := hir.Module{Version: hir.Version, Name: p.module, Uses: p.Uses()}
	if p.core {
		structNames := make([]string, 0, len(p.structs))
		for name := range p.structs {
			structNames = append(structNames, name)
		}
		sort.Strings(structNames)
		for _, name := range structNames {
			d := p.structs[name]
			fields := make([]hir.Field, 0, len(d.fields))
			for _, field := range d.fields {
				typ, err := hirCoreType(field.typeName)
				if err != nil {
					return hir.Module{}, diagnosticAt(DiagnosticInvalidType, field.pos, "invalid struct field type %q: %v", field.typeName, err)
				}
				fields = append(fields, hir.Field{Name: field.name, Type: typ})
			}
			m.Declarations = append(m.Declarations, hir.Declaration{
				ID:     hir.SymbolID{Module: p.module, Kind: "struct", Name: name},
				Fields: fields,
			})
		}
		enumNames := make([]string, 0, len(p.enums))
		for name := range p.enums {
			enumNames = append(enumNames, name)
		}
		sort.Strings(enumNames)
		for _, name := range enumNames {
			d := p.enums[name]
			variants := make([]hir.Variant, 0, len(d.variants))
			for _, variant := range d.variants {
				v := hir.Variant{Name: variant.name}
				if variant.payload != "" {
					typ, err := hirCoreType(variant.payload)
					if err != nil {
						return hir.Module{}, diagnosticAt(DiagnosticInvalidType, variant.pos, "invalid enum payload type %q: %v", variant.payload, err)
					}
					v.Payload = &typ
				}
				variants = append(variants, v)
			}
			m.Declarations = append(m.Declarations, hir.Declaration{
				ID:       hir.SymbolID{Module: p.module, Kind: "enum", Name: name},
				Variants: variants,
			})
		}
	}
	names := make([]string, 0, len(p.functions))
	for name := range p.functions {
		names = append(names, name)
	}
	sort.Strings(names)

	if p.core {
		for _, name := range names {
			f := p.functions[name]
			params := make([]hir.Parameter, 0, len(f.params))
			for i, param := range f.params {
				if f.annotations[i] == "" {
					return hir.Module{}, diagnosticAt(DiagnosticCannotInferType, f.pos, "HIR function %s parameter %s requires an explicit type", name, param)
				}
				typ, err := hirCoreType(f.annotations[i])
				if err != nil {
					return hir.Module{}, diagnosticAt(DiagnosticInvalidType, f.pos, "invalid HIR parameter type %q: %v", f.annotations[i], err)
				}
				params = append(params, hir.Parameter{Name: param, Type: typ})
			}
			result := f.result
			if result == "" {
				result = "void"
				if hasReturn(f.body) {
					result = "f64"
				}
			}
			resultType, err := hirCoreType(result)
			if err != nil {
				return hir.Module{}, diagnosticAt(DiagnosticInvalidType, f.pos, "invalid HIR result type %q: %v", result, err)
			}
			m.Declarations = append(m.Declarations, hir.Declaration{
				ID:       hir.SymbolID{Module: p.module, Kind: "fn", Name: name},
				Function: &hir.Function{Params: params, Result: resultType, BorrowFrom: f.borrowFrom},
			})
		}
	} else {
		checked, err := p.check()
		if err != nil {
			return hir.Module{}, err
		}
		for _, name := range names {
			f := p.functions[name]
			sig := checked.signatures[name]
			params := make([]hir.Parameter, 0, len(f.params))
			for i, param := range f.params {
				params = append(params, hir.Parameter{Name: param, Type: hir.TypeRef{Name: typeLabel(sig.params[i].root().mask)}})
			}
			m.Declarations = append(m.Declarations, hir.Declaration{
				ID:       hir.SymbolID{Module: p.module, Kind: "fn", Name: name},
				Function: &hir.Function{Params: params, Result: hir.TypeRef{Name: typeLabel(sig.result.root().mask)}},
			})
		}
	}
	if err := m.Validate(); err != nil {
		return hir.Module{}, err
	}
	return m, nil
}

func hirCoreType(name string) (hir.TypeRef, error) {
	typ, err := hir.ParseTypeRef(name)
	if err != nil {
		return hir.TypeRef{}, err
	}
	return normalizeCoreHIRType(typ), nil
}

func normalizeCoreHIRType(t hir.TypeRef) hir.TypeRef {
	if t.Name == "number" {
		t.Name = "f64"
	}
	for i := range t.Args {
		t.Args[i] = normalizeCoreHIRType(t.Args[i])
	}
	return t
}

func hirLocation(pos scanner.Position) hir.Location {
	return hir.Location{File: pos.Filename, Line: pos.Line, Column: pos.Column}
}

// HIRModule emits typed statement/expression bodies. A supplied function table
// may contain signatures from directly imported modules; every call is resolved
// to an explicit SymbolID while converting the source body.
func (p *Program) HIRModule(table hir.FunctionTable, suppliedTypes ...hir.TypeTable) (module hir.Module, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				module = hir.Module{}
				err = e
				return
			}
			panic(r)
		}
	}()
	m, err := p.HIRDeclarations()
	if err != nil {
		return hir.Module{}, err
	}
	if table == nil {
		table, err = hir.BuildFunctionTable([]hir.Module{m})
		if err != nil {
			return hir.Module{}, err
		}
	}
	types := hir.TypeTable(nil)
	if len(suppliedTypes) > 0 {
		types = suppliedTypes[0]
	}
	if types == nil {
		types, err = hir.BuildTypeTable([]hir.Module{m})
		if err != nil {
			return hir.Module{}, err
		}
	}
	if p.core {
		for i := range m.Declarations {
			decl := &m.Declarations[i]
			if decl.Function == nil {
				continue
			}
			f := p.functions[decl.ID.Name]
			builder := hirBodyBuilder{program: p, function: decl.ID, result: decl.Function.Result, table: table, types: types}
			env := &hirTypeScope{vars: map[string]hir.TypeRef{}}
			for _, param := range decl.Function.Params {
				env.vars[param.Name] = param.Type
			}
			decl.Function.Body = builder.block(f.body, env)
		}
	} else {
		checked, checkErr := p.check()
		if checkErr != nil {
			return hir.Module{}, checkErr
		}
		for i := range m.Declarations {
			decl := &m.Declarations[i]
			if decl.Function == nil {
				continue
			}
			f := p.functions[decl.ID.Name]
			decl.Function.Body = legacyHIRBlock(p.module, f.body, checked)
		}
	}
	if err := m.Validate(); err != nil {
		return hir.Module{}, err
	}
	return m, nil
}

type hirTypeScope struct {
	vars   map[string]hir.TypeRef
	parent *hirTypeScope
}

func (s *hirTypeScope) lookup(name string, pos scanner.Position) hir.TypeRef {
	for cur := s; cur != nil; cur = cur.parent {
		if typ, ok := cur.vars[name]; ok {
			return typ
		}
	}
	panic(diagnosticAt(DiagnosticUnknownVariable, pos, "unknown variable %q", name))
}

type hirBodyBuilder struct {
	program  *Program
	function hir.SymbolID
	result   hir.TypeRef
	table    hir.FunctionTable
	types    hir.TypeTable
}

func (b *hirBodyBuilder) block(body []*stmt, parent *hirTypeScope) []hir.Statement {
	env := &hirTypeScope{vars: map[string]hir.TypeRef{}, parent: parent}
	out := make([]hir.Statement, 0, len(body))
	for _, s := range body {
		statement := hir.Statement{Kind: s.kind, Location: hirLocation(s.pos), Name: s.name}
		switch s.kind {
		case "let":
			if _, exists := env.vars[s.name]; exists {
				panic(diagnosticAt(DiagnosticDuplicateVariable, s.pos, "duplicate variable %q", s.name))
			}
			var want *hir.TypeRef
			if s.annotation != "" {
				t, err := hirCoreType(s.annotation)
				if err != nil {
					panic(diagnosticAt(DiagnosticInvalidType, s.pos, "invalid HIR local type %q: %v", s.annotation, err))
				}
				want = &t
			}
			value := b.expression(s.value, env, want)
			if value.Type.Name == "void" {
				panic(diagnosticAt(DiagnosticTypeMismatch, s.pos, "void value cannot be stored"))
			}
			t := value.Type
			statement.Type, statement.Value = &t, &value
			env.vars[s.name] = t
		case "assign":
			want := env.lookup(s.name, s.pos)
			value := b.expression(s.value, env, &want)
			statement.Value = &value
		case "expr":
			value := b.expression(s.value, env, nil)
			statement.Value = &value
		case "return":
			if b.result.Name == "void" {
				panic(diagnosticAt(DiagnosticTypeMismatch, s.pos, "void function cannot return a value"))
			}
			value := b.expression(s.value, env, &b.result)
			statement.Value = &value
		case "if":
			boolean := hir.TypeRef{Name: "bool"}
			condition := b.expression(s.value, env, &boolean)
			statement.Value = &condition
			statement.Body = b.block(s.body, env)
			statement.Else = b.block(s.other, env)
		case "while":
			boolean := hir.TypeRef{Name: "bool"}
			condition := b.expression(s.value, env, &boolean)
			statement.Value = &condition
			statement.Body = b.block(s.body, env)
		default:
			panic(diagnosticAt(DiagnosticParseError, s.pos, "unsupported HIR statement %q", s.kind))
		}
		out = append(out, statement)
	}
	return out
}

func (b *hirBodyBuilder) expression(e *expr, env *hirTypeScope, want *hir.TypeRef) hir.Expression {
	result := b.expr(e, env, want)
	if want != nil && !hirTypeEqual(result.Type, *want) {
		panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "expected %s, got %s; no implicit conversion", want.Name, result.Type.Name))
	}
	return result
}

func (b *hirBodyBuilder) expr(e *expr, env *hirTypeScope, want *hir.TypeRef) hir.Expression {
	loc := hirLocation(e.pos)
	switch e.kind {
	case "literal":
		switch value := e.value.(type) {
		case bool:
			return hir.Expression{Kind: "literal", Type: hir.TypeRef{Name: "bool"}, Location: loc, Literal: &hir.Literal{Kind: "bool", Value: strconv.FormatBool(value)}}
		case string:
			return hir.Expression{Kind: "literal", Type: hir.TypeRef{Name: "bytes"}, Location: loc, Literal: &hir.Literal{Kind: "bytes", Value: value}}
		case float64:
			typ := hir.TypeRef{Name: "f64"}
			if want != nil && hirNumericType(*want) {
				typ = *want
			}
			text := e.lexeme
			if text == "" {
				text = strconv.FormatFloat(value, 'g', -1, 64)
			}
			return hir.Expression{Kind: "literal", Type: typ, Location: loc, Literal: &hir.Literal{Kind: "number", Value: text}}
		default:
			panic(diagnosticAt(DiagnosticInvalidLiteral, e.pos, "unsupported HIR literal %T", e.value))
		}
	case "variable":
		return hir.Expression{Kind: "variable", Type: env.lookup(e.name, e.pos), Location: loc, Name: e.name}
	case "array":
		if want == nil || len(want.Args) != 1 || (want.Name != "array" && want.Name != "vec") || (want.Name == "array" && want.Length == nil) {
			panic(diagnosticAt(DiagnosticCannotInferType, e.pos, "array literal requires contextual array<T,N> type or vec<T> context"))
		}
		if want.Name == "array" && uint64(len(e.args)) != *want.Length {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "array literal has %d elements, expected %d", len(e.args), *want.Length))
		}
		args := make([]hir.Expression, len(e.args))
		for i := range e.args {
			args[i] = b.expression(e.args[i], env, &want.Args[0])
		}
		kind := "array"
		if want.Name == "vec" {
			kind = "vec"
		}
		return hir.Expression{Kind: kind, Type: *want, Location: loc, Args: args}
	case "index":
		if len(e.args) != 2 {
			panic(diagnosticAt(DiagnosticParseError, e.pos, "array index requires base and index"))
		}
		base := b.expression(e.args[0], env, nil)
		if (base.Type.Name != "array" && base.Type.Name != "slice" && base.Type.Name != "vec") || len(base.Type.Args) != 1 || (base.Type.Name == "array" && base.Type.Length == nil) {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "indexing requires array<T,N>, slice<T> or vec<T>, got %s", base.Type.String()))
		}
		u64 := hir.TypeRef{Name: "u64"}
		index := b.expression(e.args[1], env, &u64)
		return hir.Expression{Kind: "index", Type: base.Type.Args[0], Location: loc, Args: []hir.Expression{base, index}}
	case "slice":
		if len(e.args) != 3 {
			panic(diagnosticAt(DiagnosticParseError, e.pos, "slice requires base, start and end"))
		}
		base := b.expression(e.args[0], env, nil)
		if (base.Type.Name != "array" && base.Type.Name != "slice" && base.Type.Name != "vec") || len(base.Type.Args) != 1 || (base.Type.Name == "array" && base.Type.Length == nil) {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "slicing requires array<T,N> or slice<T> (or vec<T>), got %s", base.Type.String()))
		}
		u64 := hir.TypeRef{Name: "u64"}
		start := b.expression(e.args[1], env, &u64)
		end := b.expression(e.args[2], env, &u64)
		result := hir.TypeRef{Name: "slice", Args: []hir.TypeRef{base.Type.Args[0]}}
		return hir.Expression{Kind: "slice", Type: result, Location: loc, Args: []hir.Expression{base, start, end}}
	case "struct":
		typ, symbol := b.resolveStructType(e.name, e.pos)
		wantFields := make(map[string]hir.TypeRef, len(symbol.Fields))
		for _, field := range symbol.Fields {
			wantFields[field.Name] = b.typeForCurrentModule(symbol.ID.Module, field.Type)
		}
		seen := map[string]bool{}
		fields := make([]hir.FieldValue, 0, len(e.fields))
		for _, field := range e.fields {
			wantField, ok := wantFields[field.name]
			if !ok {
				panic(diagnosticAt(DiagnosticTypeMismatch, field.pos, "type %s has no field %s", typ.String(), field.name))
			}
			if seen[field.name] {
				panic(diagnosticAt(DiagnosticDuplicateVariable, field.pos, "duplicate struct field initializer %q", field.name))
			}
			seen[field.name] = true
			value := b.expression(field.value, env, &wantField)
			fields = append(fields, hir.FieldValue{Name: field.name, Value: value})
		}
		for name := range wantFields {
			if !seen[name] {
				panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "missing field %s in %s construction", name, typ.String()))
			}
		}
		return hir.Expression{Kind: "struct", Type: typ, Location: loc, Fields: fields}
	case "field":
		if len(e.args) != 1 {
			panic(diagnosticAt(DiagnosticParseError, e.pos, "field projection requires one base"))
		}
		base := b.expression(e.args[0], env, nil)
		symbol, ok := hir.ResolveType(b.types, b.program.module, base.Type)
		if !ok || (symbol.ID.Kind != "struct" && symbol.ID.Kind != "record") {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "field projection requires struct/record base, got %s", base.Type.String()))
		}
		for _, field := range symbol.Fields {
			if field.Name == e.name {
				fieldType := b.typeForCurrentModule(symbol.ID.Module, field.Type)
				return hir.Expression{Kind: "field", Type: fieldType, Location: loc, Name: e.name, Args: []hir.Expression{base}}
			}
		}
		panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "type %s has no field %s", base.Type.String(), e.name))
	case "enum":
		typ, symbol := b.resolveEnumType(e.name, e.pos)
		for _, variant := range symbol.Variants {
			if variant.Name != e.variant {
				continue
			}
			if variant.Payload == nil {
				if len(e.args) != 0 {
					panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s::%s expects no payload", e.name, e.variant))
				}
				return hir.Expression{Kind: "enum", Type: typ, Location: loc, Name: e.variant}
			}
			if len(e.args) != 1 {
				panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s::%s expects one payload", e.name, e.variant))
			}
			payloadType := b.typeForCurrentModule(symbol.ID.Module, *variant.Payload)
			payload := b.expression(e.args[0], env, &payloadType)
			return hir.Expression{Kind: "enum", Type: typ, Location: loc, Name: e.variant, Args: []hir.Expression{payload}}
		}
		panic(diagnosticAt(DiagnosticInvalidType, e.pos, "enum %s has no variant %s", e.name, e.variant))
	case "match":
		if len(e.args) != 1 || len(e.arms) == 0 {
			panic(diagnosticAt(DiagnosticParseError, e.pos, "match requires one scrutinee and at least one arm"))
		}
		scrutinee := b.expression(e.args[0], env, nil)
		variantList, owner, ok := hir.ResolveVariants(b.types, b.program.module, scrutinee.Type)
		if !ok {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "match requires enum/option/result scrutinee, got %s", scrutinee.Type.String()))
		}
		variants := make(map[string]*hir.TypeRef, len(variantList))
		for i := range variantList {
			variant := &variantList[i]
			variants[variant.Name] = variant.Payload
		}
		seen := map[string]bool{}
		arms := make([]hir.MatchArm, 0, len(e.arms))
		var resultType *hir.TypeRef
		if want != nil {
			t := *want
			resultType = &t
		}
		for _, arm := range e.arms {
			payload, exists := variants[arm.variant]
			if !exists {
				panic(diagnosticAt(DiagnosticInvalidType, arm.pos, "enum %s has no variant %s", scrutinee.Type.String(), arm.variant))
			}
			if seen[arm.variant] {
				panic(diagnosticAt(DiagnosticParseError, arm.pos, "duplicate match arm %q", arm.variant))
			}
			seen[arm.variant] = true
			armEnv := &hirTypeScope{vars: map[string]hir.TypeRef{}, parent: env}
			hirArm := hir.MatchArm{Variant: arm.variant, Binding: arm.binding}
			if payload == nil {
				if arm.binding != "" {
					panic(diagnosticAt(DiagnosticTypeMismatch, arm.pos, "unit variant %s cannot bind payload", arm.variant))
				}
			} else {
				if arm.binding == "" {
					panic(diagnosticAt(DiagnosticTypeMismatch, arm.pos, "payload variant %s requires binding", arm.variant))
				}
				bindingType := b.typeForCurrentModule(owner, *payload)
				armEnv.vars[arm.binding] = bindingType
				hirArm.BindingType = &bindingType
			}
			var armWant *hir.TypeRef
			if resultType != nil {
				armWant = resultType
			}
			value := b.expression(arm.value, armEnv, armWant)
			if resultType == nil {
				t := value.Type
				resultType = &t
			}
			hirArm.Value = value
			arms = append(arms, hirArm)
		}
		for variant := range variants {
			if !seen[variant] {
				panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "non-exhaustive match on %s: missing %s", scrutinee.Type.String(), variant))
			}
		}
		if resultType == nil {
			panic(diagnosticAt(DiagnosticCannotInferType, e.pos, "cannot infer match result type"))
		}
		return hir.Expression{Kind: "match", Type: *resultType, Location: loc, Args: []hir.Expression{scrutinee}, Arms: arms}
	case "borrow":
		if len(e.args) != 1 || !hirBorrowPlace(e.args[0]) {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "borrow v1 requires a local variable, field or index place"))
		}
		base := b.expression(e.args[0], env, nil)
		name := "ref"
		if e.name == "mut" {
			name = "mutref"
		}
		return hir.Expression{Kind: "borrow", Type: hir.TypeRef{Name: name, Args: []hir.TypeRef{base.Type}}, Location: loc, Operator: e.name, Args: []hir.Expression{base}}
	case "deref":
		if len(e.args) != 1 {
			panic(diagnosticAt(DiagnosticParseError, e.pos, "deref requires one operand"))
		}
		ref := b.expression(e.args[0], env, nil)
		if (ref.Type.Name != "ref" && ref.Type.Name != "mutref") || len(ref.Type.Args) != 1 || ref.Type.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "deref requires ref<T> or mutref<T>, got %s", ref.Type.String()))
		}
		class, err := hir.OwnershipOf(b.types, b.program.module, ref.Type.Args[0])
		if err != nil {
			panic(diagnosticAt(DiagnosticInvalidType, e.pos, "%v", err))
		}
		if class != hir.OwnershipCopy {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "deref of %s is HIR-v1 safe only for Copy referents", ref.Type.Args[0].String()))
		}
		return hir.Expression{Kind: "deref", Type: ref.Type.Args[0], Location: loc, Args: []hir.Expression{ref}}
	case "call":
		return b.call(e, env, want)
	case "unary":
		if e.name == "!" {
			boolean := hir.TypeRef{Name: "bool"}
			arg := b.expression(e.args[0], env, &boolean)
			return hir.Expression{Kind: "unary", Type: boolean, Location: loc, Operator: e.name, Args: []hir.Expression{arg}}
		}
		operandType := hir.TypeRef{Name: "f64"}
		if want != nil && hirNumericType(*want) {
			operandType = *want
		} else if hint, ok := b.hint(e.args[0], env); ok && hirNumericType(hint) {
			operandType = hint
		}
		arg := b.expression(e.args[0], env, &operandType)
		return hir.Expression{Kind: "unary", Type: operandType, Location: loc, Operator: e.name, Args: []hir.Expression{arg}}
	case "binary":
		return b.binary(e, env, want)
	default:
		panic(diagnosticAt(DiagnosticParseError, e.pos, "unsupported HIR expression %q", e.kind))
	}
}

func hirBorrowPlace(e *expr) bool {
	if e == nil {
		return false
	}
	switch e.kind {
	case "variable":
		return true
	case "field":
		return len(e.args) == 1 && hirBorrowPlace(e.args[0])
	case "index":
		return len(e.args) == 2 && hirBorrowPlace(e.args[0])
	default:
		return false
	}
}

func (b *hirBodyBuilder) resolveStructType(name string, pos scanner.Position) (hir.TypeRef, hir.TypeSymbol) {
	ref := hir.TypeRef{Name: name}
	module := b.program.module
	if dot := strings.LastIndex(name, "."); dot > 0 {
		module = name[:dot]
		allowed := false
		for _, use := range b.program.uses {
			if use == module {
				allowed = true
				break
			}
		}
		if !allowed {
			panic(diagnosticAt(DiagnosticInvalidType, pos, "qualified type %q requires direct use %s", name, module))
		}
	}
	symbol, ok := hir.ResolveType(b.types, b.program.module, ref)
	if !ok {
		panic(diagnosticAt(DiagnosticInvalidType, pos, "expected type name; unknown nominal type %q", name))
	}
	if symbol.ID.Kind != "struct" && symbol.ID.Kind != "record" {
		panic(diagnosticAt(DiagnosticTypeMismatch, pos, "new %s requires struct/record type, got %s", name, symbol.ID.Kind))
	}
	return ref, symbol
}

func (b *hirBodyBuilder) resolveEnumType(name string, pos scanner.Position) (hir.TypeRef, hir.TypeSymbol) {
	ref := hir.TypeRef{Name: name}
	module := b.program.module
	if dot := strings.LastIndex(name, "."); dot > 0 {
		module = name[:dot]
		allowed := false
		for _, use := range b.program.uses {
			if use == module {
				allowed = true
				break
			}
		}
		if !allowed {
			panic(diagnosticAt(DiagnosticInvalidType, pos, "qualified type %q requires direct use %s", name, module))
		}
	}
	symbol, ok := hir.ResolveType(b.types, b.program.module, ref)
	if !ok {
		panic(diagnosticAt(DiagnosticInvalidType, pos, "expected type name; unknown nominal type %q", name))
	}
	if symbol.ID.Kind != "enum" {
		panic(diagnosticAt(DiagnosticTypeMismatch, pos, "%s is %s, not enum", name, symbol.ID.Kind))
	}
	return ref, symbol
}

func (b *hirBodyBuilder) typeForCurrentModule(owner string, typ hir.TypeRef) hir.TypeRef {
	out := typ
	if len(typ.Args) != 0 {
		out.Args = append([]hir.TypeRef(nil), typ.Args...)
		for i := range out.Args {
			out.Args[i] = b.typeForCurrentModule(owner, out.Args[i])
		}
		return out
	}
	if owner == b.program.module || strings.Contains(typ.Name, ".") {
		return out
	}
	if _, ok := b.types[owner+"."+typ.Name]; ok {
		out.Name = owner + "." + typ.Name
	}
	return out
}

func (b *hirBodyBuilder) binary(e *expr, env *hirTypeScope, want *hir.TypeRef) hir.Expression {
	loc := hirLocation(e.pos)
	if e.name == "&&" || e.name == "||" {
		boolean := hir.TypeRef{Name: "bool"}
		left := b.expression(e.args[0], env, &boolean)
		right := b.expression(e.args[1], env, &boolean)
		return hir.Expression{Kind: "binary", Type: boolean, Location: loc, Operator: e.name, Args: []hir.Expression{left, right}}
	}
	operand := hir.TypeRef{Name: "f64"}
	if want != nil && hirNumericType(*want) && !hirComparison(e.name) {
		operand = *want
	} else if hint, ok := b.hint(e.args[0], env); ok && hirNumericType(hint) {
		operand = hint
	} else if hint, ok := b.hint(e.args[1], env); ok && hirNumericType(hint) {
		operand = hint
	}
	left := b.expression(e.args[0], env, &operand)
	right := b.expression(e.args[1], env, &operand)
	if !hirTypeEqual(left.Type, right.Type) {
		panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "binary operands must have the same type"))
	}
	if !hirNumericType(left.Type) {
		panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "operator %s requires numeric operands", e.name))
	}
	if hirBitwiseOperator(e.name) && left.Type.Name != "u64" {
		panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "operator %s requires u64 operands", e.name))
	}
	resultType := left.Type
	if hirComparison(e.name) {
		resultType = hir.TypeRef{Name: "bool"}
	}
	return hir.Expression{Kind: "binary", Type: resultType, Location: loc, Operator: e.name, Args: []hir.Expression{left, right}}
}

func (b *hirBodyBuilder) call(e *expr, env *hirTypeScope, want *hir.TypeRef) hir.Expression {
	if e.name == "some" || e.name == "none" || e.name == "ok" || e.name == "err" {
		return b.sumConstructor(e, env, want)
	}
	if e.name == "vec_len" || e.name == "vec_capacity" {
		if len(e.args) != 1 {
			panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s expects exactly one vec argument", e.name))
		}
		arg := b.expression(e.args[0], env, nil)
		if arg.Type.Name != "vec" || len(arg.Type.Args) != 1 || arg.Type.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "%s requires vec<T>, got %s", e.name, arg.Type.String()))
		}
		return hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "u64"}, Location: hirLocation(e.pos), Builtin: e.name, Args: []hir.Expression{arg}}
	}
	if e.name == "vec_push" {
		if len(e.args) != 2 {
			panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "vec_push expects vec and value arguments"))
		}
		vec := b.expression(e.args[0], env, nil)
		if vec.Type.Name != "vec" || len(vec.Type.Args) != 1 || vec.Type.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "vec_push requires vec<T>, got %s", vec.Type.String()))
		}
		value := b.expression(e.args[1], env, &vec.Type.Args[0])
		return hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Location: hirLocation(e.pos), Builtin: "vec_push", Args: []hir.Expression{vec, value}}
	}
	if e.name == "drop" {
		if len(e.args) != 1 {
			panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "drop expects exactly one argument"))
		}
		arg := b.expression(e.args[0], env, nil)
		if arg.Type.Name == "void" {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "drop cannot consume void"))
		}
		return hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Location: hirLocation(e.pos), Builtin: "drop", Args: []hir.Expression{arg}}
	}
	if e.name == "defer_drop" {
		if len(e.args) != 1 {
			panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "defer_drop expects exactly one argument"))
		}
		arg := b.expression(e.args[0], env, nil)
		if arg.Kind != "variable" || arg.Type.Name == "void" {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "defer_drop requires one local non-void variable"))
		}
		return hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Location: hirLocation(e.pos), Builtin: "defer_drop", Args: []hir.Expression{arg}}
	}
	if e.name == "store" {
		if len(e.args) != 2 {
			panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "store expects mutref and value arguments"))
		}
		ref := b.expression(e.args[0], env, nil)
		if ref.Type.Name != "mutref" || len(ref.Type.Args) != 1 || ref.Type.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "store requires mutref<T>, got %s", ref.Type.String()))
		}
		class, err := hir.OwnershipOf(b.types, b.program.module, ref.Type.Args[0])
		if err != nil {
			panic(diagnosticAt(DiagnosticInvalidType, e.pos, "%v", err))
		}
		if class != hir.OwnershipCopy {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "store through mutref is HIR-v1 safe only for Copy referents"))
		}
		value := b.expression(e.args[1], env, &ref.Type.Args[0])
		return hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Location: hirLocation(e.pos), Builtin: "store", Args: []hir.Expression{ref, value}}
	}
	if params, result, ok := hirBuiltinSignature(e.name); ok {
		if e.name == "print" || e.name == "eprint" {
			if len(e.args) != 1 {
				panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s expects exactly one argument", e.name))
			}
			arg := b.expression(e.args[0], env, nil)
			if !hirCorePrintableType(arg.Type) {
				panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "%s requires one scalar argument", e.name))
			}
			return hir.Expression{Kind: "call", Type: result, Location: hirLocation(e.pos), Builtin: e.name, Args: []hir.Expression{arg}}
		}
		if len(e.args) != len(params) {
			panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s expects %d arguments, got %d", e.name, len(params), len(e.args)))
		}
		args := make([]hir.Expression, len(e.args))
		for i := range e.args {
			args[i] = b.expression(e.args[i], env, &params[i])
		}
		return hir.Expression{Kind: "call", Type: result, Location: hirLocation(e.pos), Builtin: e.name, Args: args}
	}
	callee := b.resolveFunction(e.name, e.pos)
	symbol := b.table[callee.Canonical()]
	if len(e.args) != len(symbol.Signature.Params) {
		panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s expects %d arguments, got %d", e.name, len(symbol.Signature.Params), len(e.args)))
	}
	args := make([]hir.Expression, len(e.args))
	for i := range e.args {
		want := b.typeForCurrentModule(symbol.ID.Module, symbol.Signature.Params[i].Type)
		args[i] = b.expression(e.args[i], env, &want)
	}
	result := b.typeForCurrentModule(symbol.ID.Module, symbol.Signature.Result)
	return hir.Expression{Kind: "call", Type: result, Location: hirLocation(e.pos), Callee: &callee, Args: args}
}

func (b *hirBodyBuilder) sumConstructor(e *expr, env *hirTypeScope, want *hir.TypeRef) hir.Expression {
	if want == nil {
		panic(diagnosticAt(DiagnosticCannotInferType, e.pos, "%s requires contextual option<T> or result<T,E> type", e.name))
	}
	variant := ""
	payloadIndex := -1
	wantArgs := 0
	switch e.name {
	case "some":
		if want.Name != "option" || len(want.Args) != 1 || want.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "some requires contextual option<T> type, got %s", want.String()))
		}
		variant, payloadIndex, wantArgs = "Some", 0, 1
	case "none":
		if want.Name != "option" || len(want.Args) != 1 || want.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "none requires contextual option<T> type, got %s", want.String()))
		}
		variant, wantArgs = "None", 0
	case "ok":
		if want.Name != "result" || len(want.Args) != 2 || want.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "ok requires contextual result<T,E> type, got %s", want.String()))
		}
		variant, payloadIndex, wantArgs = "Ok", 0, 1
	case "err":
		if want.Name != "result" || len(want.Args) != 2 || want.Length != nil {
			panic(diagnosticAt(DiagnosticTypeMismatch, e.pos, "err requires contextual result<T,E> type, got %s", want.String()))
		}
		variant, payloadIndex, wantArgs = "Err", 1, 1
	}
	if len(e.args) != wantArgs {
		panic(diagnosticAt(DiagnosticArityMismatch, e.pos, "%s expects %d arguments, got %d", e.name, wantArgs, len(e.args)))
	}
	result := hir.Expression{Kind: "enum", Type: *want, Location: hirLocation(e.pos), Name: variant}
	if payloadIndex >= 0 {
		payloadType := want.Args[payloadIndex]
		payload := b.expression(e.args[0], env, &payloadType)
		result.Args = []hir.Expression{payload}
	}
	return result
}

func (b *hirBodyBuilder) resolveFunction(name string, pos scanner.Position) hir.SymbolID {
	module, function := b.program.module, name
	if dot := strings.LastIndex(name, "."); dot >= 0 {
		module, function = name[:dot], name[dot+1:]
		allowed := false
		for _, use := range b.program.uses {
			if use == module {
				allowed = true
				break
			}
		}
		if !allowed {
			panic(diagnosticAt(DiagnosticUnknownFunction, pos, "qualified call %q requires direct use %s", name, module))
		}
	}
	id := hir.SymbolID{Module: module, Kind: "fn", Name: function}
	if _, ok := b.table[id.Canonical()]; !ok {
		panic(diagnosticAt(DiagnosticUnknownFunction, pos, "unknown function %q", name))
	}
	return id
}

func (b *hirBodyBuilder) hint(e *expr, env *hirTypeScope) (hir.TypeRef, bool) {
	switch e.kind {
	case "literal":
		switch e.value.(type) {
		case bool:
			return hir.TypeRef{Name: "bool"}, true
		case string:
			return hir.TypeRef{Name: "bytes"}, true
		}
	case "variable":
		return env.lookup(e.name, e.pos), true
	case "call":
		if _, result, ok := hirBuiltinSignature(e.name); ok {
			return result, true
		}
		id := b.resolveFunction(e.name, e.pos)
		symbol := b.table[id.Canonical()]
		return b.typeForCurrentModule(symbol.ID.Module, symbol.Signature.Result), true
	case "struct":
		typ, _ := b.resolveStructType(e.name, e.pos)
		return typ, true
	case "field":
		if len(e.args) != 1 {
			return hir.TypeRef{}, false
		}
		baseType, ok := b.hint(e.args[0], env)
		if !ok {
			return hir.TypeRef{}, false
		}
		symbol, ok := hir.ResolveType(b.types, b.program.module, baseType)
		if !ok || (symbol.ID.Kind != "struct" && symbol.ID.Kind != "record") {
			return hir.TypeRef{}, false
		}
		for _, field := range symbol.Fields {
			if field.Name == e.name {
				return b.typeForCurrentModule(symbol.ID.Module, field.Type), true
			}
		}
		return hir.TypeRef{}, false
	case "index":
		if len(e.args) != 2 {
			return hir.TypeRef{}, false
		}
		baseType, ok := b.hint(e.args[0], env)
		if !ok || (baseType.Name != "array" && baseType.Name != "slice") || len(baseType.Args) != 1 || (baseType.Name == "array" && baseType.Length == nil) {
			return hir.TypeRef{}, false
		}
		return baseType.Args[0], true
	case "borrow":
		if len(e.args) != 1 {
			return hir.TypeRef{}, false
		}
		baseType, ok := b.hint(e.args[0], env)
		if !ok {
			return hir.TypeRef{}, false
		}
		name := "ref"
		if e.name == "mut" {
			name = "mutref"
		}
		return hir.TypeRef{Name: name, Args: []hir.TypeRef{baseType}}, true
	case "deref":
		if len(e.args) != 1 {
			return hir.TypeRef{}, false
		}
		refType, ok := b.hint(e.args[0], env)
		if !ok || (refType.Name != "ref" && refType.Name != "mutref") || len(refType.Args) != 1 || refType.Length != nil {
			return hir.TypeRef{}, false
		}
		return refType.Args[0], true
	case "slice":
		if len(e.args) != 3 {
			return hir.TypeRef{}, false
		}
		baseType, ok := b.hint(e.args[0], env)
		if !ok || (baseType.Name != "array" && baseType.Name != "slice") || len(baseType.Args) != 1 || (baseType.Name == "array" && baseType.Length == nil) {
			return hir.TypeRef{}, false
		}
		return hir.TypeRef{Name: "slice", Args: []hir.TypeRef{baseType.Args[0]}}, true
	case "unary":
		if e.name == "!" {
			return hir.TypeRef{Name: "bool"}, true
		}
		return b.hint(e.args[0], env)
	case "binary":
		if hirComparison(e.name) || e.name == "&&" || e.name == "||" {
			return hir.TypeRef{Name: "bool"}, true
		}
		if typ, ok := b.hint(e.args[0], env); ok {
			return typ, true
		}
		return b.hint(e.args[1], env)
	}
	return hir.TypeRef{}, false
}

func hirBuiltinSignature(name string) ([]hir.TypeRef, hir.TypeRef, bool) {
	bytes := hir.TypeRef{Name: "bytes"}
	u64 := hir.TypeRef{Name: "u64"}
	boolean := hir.TypeRef{Name: "bool"}
	void := hir.TypeRef{Name: "void"}
	switch name {
	case "print", "eprint":
		return nil, void, true
	case "clock", "random":
		return nil, u64, true
	case "write_file":
		return []hir.TypeRef{bytes, bytes}, void, true
	case "read_file":
		return []hir.TypeRef{bytes}, bytes, true
	case "tcp_connect":
		return []hir.TypeRef{bytes, u64}, boolean, true
	case "http_fetch":
		return []hir.TypeRef{bytes, u64, bytes}, bytes, true
	case "process_exec":
		return []hir.TypeRef{bytes, u64, bytes, bytes, bytes, bytes}, u64, true
	case "bytes_len":
		return []hir.TypeRef{bytes}, u64, true
	case "bytes_get":
		return []hir.TypeRef{bytes, u64}, u64, true
	default:
		return nil, hir.TypeRef{}, false
	}
}

func hirNumericType(t hir.TypeRef) bool {
	switch t.Name {
	case "i64", "u64", "f64", "ieee64":
		return true
	default:
		return false
	}
}

func hirComparison(op string) bool {
	switch op {
	case "==", "!=", "<", "<=", ">", ">=":
		return true
	default:
		return false
	}
}

func hirBitwiseOperator(op string) bool {
	switch op {
	case "&", "|", "^", "<<", ">>":
		return true
	default:
		return false
	}
}

func hirCorePrintableType(t hir.TypeRef) bool {
	switch t.Name {
	case "i64", "u64", "f64", "ieee64", "bool":
		return true
	default:
		return false
	}
}

func hirTypeEqual(a, b hir.TypeRef) bool {
	if a.Name != b.Name || len(a.Args) != len(b.Args) || (a.Length == nil) != (b.Length == nil) {
		return false
	}
	if a.Length != nil && *a.Length != *b.Length {
		return false
	}
	for i := range a.Args {
		if !hirTypeEqual(a.Args[i], b.Args[i]) {
			return false
		}
	}
	return true
}

func legacyHIRBlock(module string, body []*stmt, checked *checked) []hir.Statement {
	out := make([]hir.Statement, 0, len(body))
	for _, s := range body {
		statement := hir.Statement{Kind: s.kind, Location: hirLocation(s.pos), Name: s.name}
		if s.value != nil {
			value := legacyHIRExpression(module, s.value, checked)
			statement.Value = &value
		}
		if s.kind == "let" {
			t := hir.TypeRef{Name: typeLabel(checked.declarations[s].root().mask)}
			statement.Type = &t
		}
		statement.Body = legacyHIRBlock(module, s.body, checked)
		statement.Else = legacyHIRBlock(module, s.other, checked)
		out = append(out, statement)
	}
	return out
}

func legacyHIRExpression(module string, e *expr, checked *checked) hir.Expression {
	typ := hir.TypeRef{Name: typeLabel(checked.expressions[e].root().mask)}
	result := hir.Expression{Kind: e.kind, Type: typ, Location: hirLocation(e.pos), Name: e.name}
	switch e.kind {
	case "literal":
		switch value := e.value.(type) {
		case bool:
			result.Literal = &hir.Literal{Kind: "bool", Value: strconv.FormatBool(value)}
		case string:
			result.Literal = &hir.Literal{Kind: "string", Value: value}
		case float64:
			text := e.lexeme
			if text == "" {
				text = strconv.FormatFloat(value, 'g', -1, 64)
			}
			result.Literal = &hir.Literal{Kind: "number", Value: text}
		}
	case "call":
		result.Name = ""
		if e.name == "print" || e.name == "eprint" || e.name == "arg" || e.name == "clock" || e.name == "random" {
			result.Builtin = e.name
		} else {
			id := hir.SymbolID{Module: module, Kind: "fn", Name: e.name}
			result.Callee = &id
		}
	case "unary", "binary":
		result.Name = ""
		result.Operator = e.name
	}
	for _, arg := range e.args {
		result.Args = append(result.Args, legacyHIRExpression(module, arg, checked))
	}
	return result
}
