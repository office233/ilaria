package hir

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Bundle struct {
	Version int      `json:"version"`
	Root    string   `json:"root"`
	Modules []Module `json:"modules"`
}

type FunctionSymbol struct {
	ID        SymbolID
	Signature Function
}

type FunctionTable map[string]FunctionSymbol

type TypeSymbol struct {
	ID       SymbolID
	Fields   []Field
	Variants []Variant
}

type TypeTable map[string]TypeSymbol

func BuildTypeTable(modules []Module) (TypeTable, error) {
	table := TypeTable{}
	for _, module := range modules {
		for _, decl := range module.Declarations {
			switch decl.ID.Kind {
			case "struct", "enum", "record":
			default:
				continue
			}
			key := decl.ID.Module + "." + decl.ID.Name
			if previous, exists := table[key]; exists {
				return nil, fmt.Errorf("ambiguous nominal type %q declared as both %s and %s", key, previous.ID.Kind, decl.ID.Kind)
			}
			table[key] = TypeSymbol{
				ID:       decl.ID,
				Fields:   append([]Field(nil), decl.Fields...),
				Variants: append([]Variant(nil), decl.Variants...),
			}
		}
	}
	return table, nil
}

func ResolveType(table TypeTable, currentModule string, ref TypeRef) (TypeSymbol, bool) {
	if len(ref.Args) != 0 || ref.Length != nil {
		return TypeSymbol{}, false
	}
	module, name := currentModule, ref.Name
	if dot := strings.LastIndex(ref.Name, "."); dot > 0 {
		module, name = ref.Name[:dot], ref.Name[dot+1:]
	}
	symbol, ok := table[module+"."+name]
	return symbol, ok
}

// ResolveVariants returns the tagged-union schema for nominal enums and the
// built-in option/result algebraic types. owner is the module relative to which
// unqualified nominal payload types are interpreted.
func ResolveVariants(table TypeTable, currentModule string, ref TypeRef) (variants []Variant, owner string, ok bool) {
	switch ref.Name {
	case "option":
		if len(ref.Args) != 1 || ref.Length != nil {
			return nil, "", false
		}
		payload := ref.Args[0]
		return []Variant{{Name: "None"}, {Name: "Some", Payload: &payload}}, currentModule, true
	case "result":
		if len(ref.Args) != 2 || ref.Length != nil {
			return nil, "", false
		}
		okType, errType := ref.Args[0], ref.Args[1]
		return []Variant{{Name: "Ok", Payload: &okType}, {Name: "Err", Payload: &errType}}, currentModule, true
	}
	symbol, found := ResolveType(table, currentModule, ref)
	if !found || symbol.ID.Kind != "enum" {
		return nil, "", false
	}
	return append([]Variant(nil), symbol.Variants...), symbol.ID.Module, true
}

func BuildFunctionTable(modules []Module) (FunctionTable, error) {
	table := FunctionTable{}
	for _, module := range modules {
		if err := module.Validate(); err != nil {
			return nil, err
		}
		for _, decl := range module.Declarations {
			if decl.Function == nil {
				continue
			}
			key := decl.ID.Canonical()
			if _, exists := table[key]; exists {
				return nil, fmt.Errorf("duplicate function symbol %q", key)
			}
			signature := *decl.Function
			signature.Body = nil
			table[key] = FunctionSymbol{ID: decl.ID, Signature: signature}
		}
	}
	return table, nil
}

func (b Bundle) Validate() error {
	if b.Version != Version {
		return fmt.Errorf("unsupported HIR bundle version %d", b.Version)
	}
	if !validPath(b.Root) {
		return fmt.Errorf("invalid HIR bundle root %q", b.Root)
	}
	byModule := map[string]Module{}
	for _, module := range b.Modules {
		if err := module.Validate(); err != nil {
			return err
		}
		if _, exists := byModule[module.Name]; exists {
			return fmt.Errorf("duplicate HIR module %q", module.Name)
		}
		byModule[module.Name] = module
	}
	if _, ok := byModule[b.Root]; !ok {
		return fmt.Errorf("HIR bundle root %q is missing", b.Root)
	}
	table, err := BuildFunctionTable(b.Modules)
	if err != nil {
		return err
	}
	types, err := BuildTypeTable(b.Modules)
	if err != nil {
		return err
	}
	for _, module := range b.Modules {
		uses := map[string]bool{}
		for _, use := range module.Uses {
			uses[use] = true
		}
		for _, decl := range module.Declarations {
			if err := validateDeclarationTypeLinks(module.Name, uses, decl, types); err != nil {
				return fmt.Errorf("%s: %w", decl.ID.Canonical(), err)
			}
		}
		for _, decl := range module.Declarations {
			if decl.Function == nil || len(decl.Function.Body) == 0 {
				continue
			}
			if err := validateLinkedStatements(module.Name, uses, decl.Function.Body, table); err != nil {
				return fmt.Errorf("%s: %w", decl.ID.Canonical(), err)
			}
		}
	}
	return nil
}

func validateDeclarationTypeLinks(module string, uses map[string]bool, decl Declaration, types TypeTable) error {
	check := func(t TypeRef) error { return validateLinkedType(module, uses, t, types) }
	if decl.Function != nil {
		for _, param := range decl.Function.Params {
			if err := check(param.Type); err != nil {
				return fmt.Errorf("parameter %s: %w", param.Name, err)
			}
		}
		if err := check(decl.Function.Result); err != nil {
			return fmt.Errorf("result: %w", err)
		}
		if err := validateStatementTypeLinks(module, uses, decl.Function.Body, types); err != nil {
			return err
		}
	}
	for _, field := range decl.Fields {
		if err := check(field.Type); err != nil {
			return fmt.Errorf("field %s: %w", field.Name, err)
		}
	}
	for _, variant := range decl.Variants {
		if variant.Payload != nil {
			if err := check(*variant.Payload); err != nil {
				return fmt.Errorf("variant %s: %w", variant.Name, err)
			}
		}
	}
	return nil
}

func validateStatementTypeLinks(module string, uses map[string]bool, body []Statement, types TypeTable) error {
	for _, stmt := range body {
		if stmt.Type != nil {
			if err := validateLinkedType(module, uses, *stmt.Type, types); err != nil {
				return err
			}
		}
		if stmt.Value != nil {
			if err := validateExpressionTypeLinks(module, uses, *stmt.Value, types); err != nil {
				return err
			}
		}
		if err := validateStatementTypeLinks(module, uses, stmt.Body, types); err != nil {
			return err
		}
		if err := validateStatementTypeLinks(module, uses, stmt.Else, types); err != nil {
			return err
		}
	}
	return nil
}

func validateExpressionTypeLinks(module string, uses map[string]bool, e Expression, types TypeTable) error {
	if err := validateLinkedType(module, uses, e.Type, types); err != nil {
		return err
	}
	for _, arg := range e.Args {
		if err := validateExpressionTypeLinks(module, uses, arg, types); err != nil {
			return err
		}
	}
	for _, field := range e.Fields {
		if err := validateExpressionTypeLinks(module, uses, field.Value, types); err != nil {
			return err
		}
	}
	for _, arm := range e.Arms {
		if arm.BindingType != nil {
			if err := validateLinkedType(module, uses, *arm.BindingType, types); err != nil {
				return err
			}
		}
		if err := validateExpressionTypeLinks(module, uses, arm.Value, types); err != nil {
			return err
		}
	}
	if e.Kind == "struct" {
		if err := validateStructConstruction(module, uses, e, types); err != nil {
			return err
		}
	}
	if e.Kind == "field" {
		if err := validateFieldProjection(module, uses, e, types); err != nil {
			return err
		}
	}
	if e.Kind == "enum" {
		if err := validateEnumConstruction(module, uses, e, types); err != nil {
			return err
		}
	}
	if e.Kind == "match" {
		if err := validateMatchExpression(module, uses, e, types); err != nil {
			return err
		}
	}
	return nil
}

func validateLinkedType(module string, uses map[string]bool, t TypeRef, types TypeTable) error {
	for _, arg := range t.Args {
		if err := validateLinkedType(module, uses, arg, types); err != nil {
			return err
		}
	}
	if len(t.Args) != 0 || builtinHIRTypeName(t.Name) {
		return nil
	}
	owner, name := module, t.Name
	if dot := strings.LastIndex(t.Name, "."); dot > 0 {
		owner, name = t.Name[:dot], t.Name[dot+1:]
		if owner != module && !uses[owner] {
			return fmt.Errorf("nominal type %s requires direct use %s", t.Name, owner)
		}
	}
	key := owner + "." + name
	if _, ok := types[key]; !ok {
		return fmt.Errorf("unknown nominal type %s", t.Name)
	}
	return nil
}

func validateStructConstruction(module string, uses map[string]bool, e Expression, types TypeTable) error {
	if err := validateLinkedType(module, uses, e.Type, types); err != nil {
		return err
	}
	symbol, ok := ResolveType(types, module, e.Type)
	if !ok || (symbol.ID.Kind != "struct" && symbol.ID.Kind != "record") {
		return fmt.Errorf("struct construction requires struct/record type %s", e.Type.String())
	}
	want := make(map[string]TypeRef, len(symbol.Fields))
	for _, field := range symbol.Fields {
		want[field.Name] = field.Type
	}
	seen := map[string]bool{}
	for _, field := range e.Fields {
		typ, ok := want[field.Name]
		if !ok {
			return fmt.Errorf("type %s has no field %s", e.Type.String(), field.Name)
		}
		if seen[field.Name] {
			return fmt.Errorf("duplicate field %s in %s construction", field.Name, e.Type.String())
		}
		seen[field.Name] = true
		if !sameType(qualifyLocalType(symbol.ID.Module, typ), qualifyLocalType(module, field.Value.Type)) {
			return fmt.Errorf("field %s type %s does not match %s", field.Name, typeString(field.Value.Type), typeString(typ))
		}
	}
	for name := range want {
		if !seen[name] {
			return fmt.Errorf("missing field %s in %s construction", name, e.Type.String())
		}
	}
	return nil
}

func validateFieldProjection(module string, uses map[string]bool, e Expression, types TypeTable) error {
	if len(e.Args) != 1 {
		return fmt.Errorf("field projection requires one base")
	}
	base := e.Args[0]
	if err := validateLinkedType(module, uses, base.Type, types); err != nil {
		return err
	}
	symbol, ok := ResolveType(types, module, base.Type)
	if !ok || (symbol.ID.Kind != "struct" && symbol.ID.Kind != "record") {
		return fmt.Errorf("field projection requires struct/record base, got %s", base.Type.String())
	}
	for _, field := range symbol.Fields {
		if field.Name == e.Name {
			want := qualifyLocalType(symbol.ID.Module, field.Type)
			got := qualifyLocalType(module, e.Type)
			if !sameType(want, got) {
				return fmt.Errorf("field %s result type %s does not match %s", e.Name, e.Type.String(), field.Type.String())
			}
			return nil
		}
	}
	return fmt.Errorf("type %s has no field %s", base.Type.String(), e.Name)
}

func validateEnumConstruction(module string, uses map[string]bool, e Expression, types TypeTable) error {
	if err := validateLinkedType(module, uses, e.Type, types); err != nil {
		return err
	}
	variants, owner, ok := ResolveVariants(types, module, e.Type)
	if !ok {
		return fmt.Errorf("tagged construction requires enum/option/result type %s", e.Type.String())
	}
	for _, variant := range variants {
		if variant.Name != e.Name {
			continue
		}
		if variant.Payload == nil {
			if len(e.Args) != 0 {
				return fmt.Errorf("enum variant %s::%s has no payload", e.Type.String(), e.Name)
			}
			return nil
		}
		if len(e.Args) != 1 {
			return fmt.Errorf("enum variant %s::%s requires one payload", e.Type.String(), e.Name)
		}
		want := qualifyLocalType(owner, *variant.Payload)
		got := qualifyLocalType(module, e.Args[0].Type)
		if !sameType(want, got) {
			return fmt.Errorf("enum variant %s::%s payload type %s does not match %s", e.Type.String(), e.Name, typeString(e.Args[0].Type), typeString(*variant.Payload))
		}
		return nil
	}
	return fmt.Errorf("enum %s has no variant %s", e.Type.String(), e.Name)
}

func validateMatchExpression(module string, uses map[string]bool, e Expression, types TypeTable) error {
	if len(e.Args) != 1 {
		return fmt.Errorf("match requires one scrutinee")
	}
	scrutinee := e.Args[0]
	if err := validateLinkedType(module, uses, scrutinee.Type, types); err != nil {
		return err
	}
	variants, owner, ok := ResolveVariants(types, module, scrutinee.Type)
	if !ok {
		return fmt.Errorf("match requires enum/option/result scrutinee, got %s", scrutinee.Type.String())
	}
	wantVariants := make(map[string]*TypeRef, len(variants))
	for i := range variants {
		variant := &variants[i]
		wantVariants[variant.Name] = variant.Payload
	}
	seen := map[string]bool{}
	for _, arm := range e.Arms {
		payload, ok := wantVariants[arm.Variant]
		if !ok {
			return fmt.Errorf("enum %s has no variant %s", scrutinee.Type.String(), arm.Variant)
		}
		if seen[arm.Variant] {
			return fmt.Errorf("duplicate match arm %s", arm.Variant)
		}
		seen[arm.Variant] = true
		if payload == nil {
			if arm.Binding != "" || arm.BindingType != nil {
				return fmt.Errorf("unit variant %s cannot bind payload", arm.Variant)
			}
		} else {
			if arm.Binding == "" || arm.BindingType == nil {
				return fmt.Errorf("payload variant %s requires binding", arm.Variant)
			}
			want := qualifyLocalType(owner, *payload)
			got := qualifyLocalType(module, *arm.BindingType)
			if !sameType(want, got) {
				return fmt.Errorf("match arm %s binding type %s does not match %s", arm.Variant, typeString(*arm.BindingType), typeString(*payload))
			}
		}
		if !sameType(e.Type, arm.Value.Type) {
			return fmt.Errorf("match arm %s result type %s does not match %s", arm.Variant, typeString(arm.Value.Type), typeString(e.Type))
		}
	}
	for variant := range wantVariants {
		if !seen[variant] {
			return fmt.Errorf("non-exhaustive match on %s: missing %s", scrutinee.Type.String(), variant)
		}
	}
	return nil
}

func qualifyLocalType(module string, t TypeRef) TypeRef {
	if len(t.Args) != 0 {
		out := t
		out.Args = append([]TypeRef(nil), t.Args...)
		for i := range out.Args {
			out.Args[i] = qualifyLocalType(module, out.Args[i])
		}
		return out
	}
	if builtinHIRTypeName(t.Name) || strings.Contains(t.Name, ".") {
		return t
	}
	return TypeRef{Name: module + "." + t.Name, Length: t.Length}
}

func builtinHIRTypeName(name string) bool {
	switch name {
	case "void", "bool", "string", "bytes", "number",
		"i8", "i16", "i32", "i64", "i128",
		"u8", "u16", "u32", "u64", "u128",
		"f16", "bf16", "f32", "f64", "finite32", "finite64", "ieee64",
		"array", "slice", "vec", "option", "result", "tuple", "opaque":
		return true
	default:
		return false
	}
}

func (b Bundle) CanonicalJSON() ([]byte, error) {
	if err := b.Validate(); err != nil {
		return nil, err
	}
	return json.MarshalIndent(b, "", "  ")
}

func validateLinkedStatements(module string, uses map[string]bool, body []Statement, table FunctionTable) error {
	for _, stmt := range body {
		if stmt.Value != nil {
			if err := validateLinkedExpression(module, uses, *stmt.Value, table); err != nil {
				return err
			}
		}
		if err := validateLinkedStatements(module, uses, stmt.Body, table); err != nil {
			return err
		}
		if err := validateLinkedStatements(module, uses, stmt.Else, table); err != nil {
			return err
		}
	}
	return nil
}

func validateLinkedExpression(module string, uses map[string]bool, e Expression, table FunctionTable) error {
	if e.Callee != nil {
		if e.Callee.Module != module && !uses[e.Callee.Module] {
			return fmt.Errorf("call target %s is not a direct use of module %s", e.Callee.Canonical(), module)
		}
		symbol, ok := table[e.Callee.Canonical()]
		if !ok {
			return fmt.Errorf("unknown call target %s", e.Callee.Canonical())
		}
		if len(e.Args) != len(symbol.Signature.Params) {
			return fmt.Errorf("call %s expects %d arguments, got %d", e.Callee.Canonical(), len(symbol.Signature.Params), len(e.Args))
		}
		for i, arg := range e.Args {
			got := qualifyLocalType(module, arg.Type)
			want := qualifyLocalType(symbol.ID.Module, symbol.Signature.Params[i].Type)
			if !sameType(got, want) {
				return fmt.Errorf("call %s argument %d type %s does not match %s", e.Callee.Canonical(), i, typeString(arg.Type), typeString(symbol.Signature.Params[i].Type))
			}
		}
		gotResult := qualifyLocalType(module, e.Type)
		wantResult := qualifyLocalType(symbol.ID.Module, symbol.Signature.Result)
		if !sameType(gotResult, wantResult) {
			return fmt.Errorf("call %s result type %s does not match %s", e.Callee.Canonical(), typeString(e.Type), typeString(symbol.Signature.Result))
		}
	}
	for _, arg := range e.Args {
		if err := validateLinkedExpression(module, uses, arg, table); err != nil {
			return err
		}
	}
	for _, field := range e.Fields {
		if err := validateLinkedExpression(module, uses, field.Value, table); err != nil {
			return err
		}
	}
	for _, arm := range e.Arms {
		if err := validateLinkedExpression(module, uses, arm.Value, table); err != nil {
			return err
		}
	}
	return nil
}

func sameType(a, b TypeRef) bool {
	if a.Name != b.Name || len(a.Args) != len(b.Args) {
		return false
	}
	if (a.Length == nil) != (b.Length == nil) {
		return false
	}
	if a.Length != nil && *a.Length != *b.Length {
		return false
	}
	for i := range a.Args {
		if !sameType(a.Args[i], b.Args[i]) {
			return false
		}
	}
	return true
}

func typeString(t TypeRef) string {
	if len(t.Args) == 0 {
		return t.Name
	}
	return t.Name + "<...>"
}
