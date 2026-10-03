package hir

import (
	"strings"
	"testing"
)

func TestQualifiedHIRModuleValidationAndCanonicalJSON(t *testing.T) {
	m := Module{
		Version: Version,
		Name:    "app.math",
		Uses:    []string{"platform.types"},
		Declarations: []Declaration{{
			ID: SymbolID{Module: "app.math", Kind: "fn", Name: "square"},
			Function: &Function{
				Params: []Parameter{{Name: "x", Type: TypeRef{Name: "i64"}}},
				Result: TypeRef{Name: "i64"},
			},
		}},
	}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	data, err := m.CanonicalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"module": "app.math"`) || !strings.Contains(string(data), `"kind": "fn"`) {
		t.Fatalf("canonical HIR=%s", data)
	}
	if got := m.Declarations[0].ID.Canonical(); got != "app.math::fn::square" {
		t.Fatalf("canonical symbol=%q", got)
	}
}

func TestHIRRejectsIdentityAndTypeViolations(t *testing.T) {
	base := Module{Version: Version, Name: "app.main", Declarations: []Declaration{{
		ID:       SymbolID{Module: "app.main", Kind: "fn", Name: "main"},
		Function: &Function{Result: TypeRef{Name: "void"}},
	}}}
	cases := []Module{
		{Version: Version, Name: "app.main", Uses: []string{"app.main"}, Declarations: base.Declarations},
		{Version: Version, Name: "app.main", Declarations: []Declaration{{ID: SymbolID{Module: "other", Kind: "fn", Name: "main"}, Function: &Function{Result: TypeRef{Name: "void"}}}}},
		{Version: Version, Name: "app.main", Declarations: []Declaration{{ID: SymbolID{Module: "app.main", Kind: "fn", Name: "main"}, Function: &Function{Params: []Parameter{{Name: "x", Type: TypeRef{Name: "bad/type"}}}, Result: TypeRef{Name: "void"}}}}},
	}
	for _, m := range cases {
		if err := m.Validate(); err == nil {
			t.Fatalf("accepted invalid HIR: %+v", m)
		}
	}
}

func TestHIRValidatesStructAndEnumShapes(t *testing.T) {
	i64 := TypeRef{Name: "i64"}
	m := Module{Version: Version, Name: "domain.model", Declarations: []Declaration{
		{ID: SymbolID{Module: "domain.model", Kind: "struct", Name: "User"}, Fields: []Field{{Name: "id", Type: i64}}},
		{ID: SymbolID{Module: "domain.model", Kind: "enum", Name: "Lookup"}, Variants: []Variant{{Name: "Missing"}, {Name: "Found", Payload: &i64}}},
	}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := m
	bad.Declarations[1].Variants = append(bad.Declarations[1].Variants, Variant{Name: "Found"})
	if err := bad.Validate(); err == nil {
		t.Fatal("duplicate enum variant accepted")
	}
}

func TestHIRValidatesArrayLiteralShape(t *testing.T) {
	length := uint64(2)
	i64 := TypeRef{Name: "i64"}
	array := TypeRef{Name: "array", Args: []TypeRef{i64}, Length: &length}
	m := Module{Version: Version, Name: "values.arrays", Declarations: []Declaration{{
		ID: SymbolID{Module: "values.arrays", Kind: "fn", Name: "make"},
		Function: &Function{Result: array, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "array", Type: array, Args: []Expression{
				{Kind: "literal", Type: i64, Literal: &Literal{Kind: "number", Value: "1"}},
				{Kind: "literal", Type: i64, Literal: &Literal{Kind: "number", Value: "2"}},
			},
		}}}},
	}}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := m
	bad.Declarations = append([]Declaration(nil), m.Declarations...)
	badFunction := *m.Declarations[0].Function
	bad.Declarations[0].Function = &badFunction
	badBody := append([]Statement(nil), badFunction.Body...)
	badFunction.Body = badBody
	badExpr := *badBody[0].Value
	badBody[0].Value = &badExpr
	badExpr.Args = badExpr.Args[:1]
	if err := bad.Validate(); err == nil {
		t.Fatal("invalid array literal length accepted")
	}
}

func TestHIRValidatesArrayIndexShape(t *testing.T) {
	length := uint64(3)
	i64 := TypeRef{Name: "i64"}
	u64 := TypeRef{Name: "u64"}
	array := TypeRef{Name: "array", Args: []TypeRef{i64}, Length: &length}
	m := Module{Version: Version, Name: "values.index", Declarations: []Declaration{{
		ID: SymbolID{Module: "values.index", Kind: "fn", Name: "second"},
		Function: &Function{Params: []Parameter{{Name: "x", Type: array}}, Result: i64, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "index", Type: i64, Args: []Expression{
				{Kind: "variable", Name: "x", Type: array},
				{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "1"}},
			},
		}}}},
	}}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestHIRValidatesBorrowFromContract(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	ref := TypeRef{Name: "ref", Args: []TypeRef{u64}}
	m := Module{Version: Version, Name: "borrow.api", Declarations: []Declaration{{
		ID: SymbolID{Module: "borrow.api", Kind: "fn", Name: "identity"},
		Function: &Function{
			Params:     []Parameter{{Name: "x", Type: ref}},
			Result:     ref,
			BorrowFrom: "x",
			Body:       []Statement{{Kind: "return", Value: &Expression{Kind: "variable", Name: "x", Type: ref}}},
		},
	}}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := m
	bad.Declarations = append([]Declaration(nil), m.Declarations...)
	badFunction := *m.Declarations[0].Function
	bad.Declarations[0].Function = &badFunction
	badFunction.BorrowFrom = "missing"
	if err := bad.Validate(); err == nil {
		t.Fatal("missing borrow_from parameter accepted")
	}
}

func TestBundleValidatesStructConstructionAndProjection(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	boolean := TypeRef{Name: "bool"}
	userLocal := TypeRef{Name: "User"}
	userID := SymbolID{Module: "domain.users", Kind: "struct", Name: "User"}
	module := Module{Version: Version, Name: "domain.users", Declarations: []Declaration{
		{ID: userID, Fields: []Field{{Name: "id", Type: u64}, {Name: "active", Type: boolean}}},
		{ID: SymbolID{Module: "domain.users", Kind: "fn", Name: "make"}, Function: &Function{Result: userLocal, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "struct", Type: userLocal, Fields: []FieldValue{
				{Name: "id", Value: Expression{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "1"}}},
				{Name: "active", Value: Expression{Kind: "literal", Type: boolean, Literal: &Literal{Kind: "bool", Value: "true"}}},
			},
		}}}}},
		{ID: SymbolID{Module: "domain.users", Kind: "fn", Name: "read"}, Function: &Function{Params: []Parameter{{Name: "u", Type: userLocal}}, Result: u64, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "field", Name: "id", Type: u64, Args: []Expression{{Kind: "variable", Name: "u", Type: userLocal}},
		}}}}},
	}}
	bundle := Bundle{Version: Version, Root: "domain.users", Modules: []Module{module}}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestBundleValidatesEnumConstructionAndExhaustiveMatch(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	enumType := TypeRef{Name: "Lookup"}
	lookupID := SymbolID{Module: "domain.lookup", Kind: "enum", Name: "Lookup"}
	module := Module{Version: Version, Name: "domain.lookup", Declarations: []Declaration{
		{ID: lookupID, Variants: []Variant{{Name: "Missing"}, {Name: "Found", Payload: &u64}}},
		{ID: SymbolID{Module: "domain.lookup", Kind: "fn", Name: "unwrap"}, Function: &Function{Params: []Parameter{{Name: "v", Type: enumType}}, Result: u64, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "match", Type: u64,
			Args: []Expression{{Kind: "variable", Name: "v", Type: enumType}},
			Arms: []MatchArm{
				{Variant: "Missing", Value: Expression{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "0"}}},
				{Variant: "Found", Binding: "x", BindingType: &u64, Value: Expression{Kind: "variable", Name: "x", Type: u64}},
			},
		}}}}},
	}}
	bundle := Bundle{Version: Version, Root: "domain.lookup", Modules: []Module{module}}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}

	bad := bundle
	bad.Modules = append([]Module(nil), bundle.Modules...)
	badDecls := append([]Declaration(nil), module.Declarations...)
	bad.Modules[0].Declarations = badDecls
	badFn := *badDecls[1].Function
	badDecls[1].Function = &badFn
	badBody := append([]Statement(nil), badFn.Body...)
	badFn.Body = badBody
	badMatch := *badBody[0].Value
	badBody[0].Value = &badMatch
	badMatch.Arms = badMatch.Arms[:1]
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "non-exhaustive match") {
		t.Fatalf("non-exhaustive bundle error=%v", err)
	}
}

func TestBundleValidatesOptionAndResultMatches(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	boolean := TypeRef{Name: "bool"}
	option := TypeRef{Name: "option", Args: []TypeRef{u64}}
	result := TypeRef{Name: "result", Args: []TypeRef{u64, boolean}}
	module := Module{Version: Version, Name: "values.sum", Declarations: []Declaration{
		{ID: SymbolID{Module: "values.sum", Kind: "fn", Name: "unwrap"}, Function: &Function{Params: []Parameter{{Name: "x", Type: option}}, Result: u64, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "match", Type: u64, Args: []Expression{{Kind: "variable", Name: "x", Type: option}}, Arms: []MatchArm{
				{Variant: "None", Value: Expression{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "0"}}},
				{Variant: "Some", Binding: "v", BindingType: &u64, Value: Expression{Kind: "variable", Name: "v", Type: u64}},
			},
		}}}}},
		{ID: SymbolID{Module: "values.sum", Kind: "fn", Name: "fail"}, Function: &Function{Result: result, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "enum", Type: result, Name: "Err", Args: []Expression{{Kind: "literal", Type: boolean, Literal: &Literal{Kind: "bool", Value: "true"}}},
		}}}}},
	}}
	if err := (Bundle{Version: Version, Root: "values.sum", Modules: []Module{module}}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestBundleValidatesDirectImportedCall(t *testing.T) {
	i64 := TypeRef{Name: "i64"}
	lib := Module{Version: Version, Name: "lib.math", Declarations: []Declaration{{
		ID:       SymbolID{Module: "lib.math", Kind: "fn", Name: "square"},
		Function: &Function{Params: []Parameter{{Name: "x", Type: i64}}, Result: i64},
	}}}
	callee := SymbolID{Module: "lib.math", Kind: "fn", Name: "square"}
	app := Module{Version: Version, Name: "app.main", Uses: []string{"lib.math"}, Declarations: []Declaration{{
		ID: SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &Function{Result: i64, Body: []Statement{{Kind: "return", Value: &Expression{
			Kind: "call", Type: i64, Callee: &callee,
			Args: []Expression{{Kind: "literal", Type: i64, Literal: &Literal{Kind: "number", Value: "4"}}},
		}}}},
	}}}
	bundle := Bundle{Version: Version, Root: "app.main", Modules: []Module{app, lib}}
	if err := bundle.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := bundle
	bad.Modules = append([]Module(nil), bundle.Modules...)
	bad.Modules[0].Uses = nil
	if err := bad.Validate(); err == nil {
		t.Fatal("bundle accepted imported call without direct use")
	}
}

func TestBundleNormalizesNestedNominalTypesAcrossImportedCalls(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	localPair := TypeRef{Name: "Pair"}
	qualifiedPair := TypeRef{Name: "lib.types.Pair"}
	localVec := TypeRef{Name: "vec", Args: []TypeRef{localPair}}
	qualifiedVec := TypeRef{Name: "vec", Args: []TypeRef{qualifiedPair}}
	lib := Module{Version: Version, Name: "lib.types", Declarations: []Declaration{
		{ID: SymbolID{Module: "lib.types", Kind: "struct", Name: "Pair"}, Fields: []Field{{Name: "value", Type: u64}}},
		{ID: SymbolID{Module: "lib.types", Kind: "fn", Name: "make"}, Function: &Function{Result: localVec}},
		{ID: SymbolID{Module: "lib.types", Kind: "fn", Name: "consume"}, Function: &Function{Params: []Parameter{{Name: "v", Type: localVec}}, Result: u64}},
	}}
	makeID := SymbolID{Module: "lib.types", Kind: "fn", Name: "make"}
	consumeID := SymbolID{Module: "lib.types", Kind: "fn", Name: "consume"}
	app := Module{Version: Version, Name: "app.main", Uses: []string{"lib.types"}, Declarations: []Declaration{
		{
			ID: SymbolID{Module: "app.main", Kind: "fn", Name: "forward"},
			Function: &Function{Params: []Parameter{{Name: "v", Type: qualifiedVec}}, Result: u64, Body: []Statement{{Kind: "return", Value: &Expression{
				Kind: "call", Type: u64, Callee: &consumeID, Args: []Expression{{Kind: "variable", Name: "v", Type: qualifiedVec}},
			}}}},
		},
		{
			ID: SymbolID{Module: "app.main", Kind: "fn", Name: "make_forward"},
			Function: &Function{Result: qualifiedVec, Body: []Statement{{Kind: "return", Value: &Expression{
				Kind: "call", Type: qualifiedVec, Callee: &makeID,
			}}}},
		},
	}}
	if err := (Bundle{Version: Version, Root: "app.main", Modules: []Module{app, lib}}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestBundleValidatesQualifiedNominalTypeLinks(t *testing.T) {
	user := Declaration{ID: SymbolID{Module: "lib.types", Kind: "struct", Name: "User"}, Fields: []Field{{Name: "id", Type: TypeRef{Name: "u64"}}}}
	lib := Module{Version: Version, Name: "lib.types", Declarations: []Declaration{user}}
	qualified := TypeRef{Name: "lib.types.User"}
	app := Module{Version: Version, Name: "app.main", Uses: []string{"lib.types"}, Declarations: []Declaration{{
		ID:       SymbolID{Module: "app.main", Kind: "fn", Name: "keep"},
		Function: &Function{Params: []Parameter{{Name: "x", Type: qualified}}, Result: qualified, Body: []Statement{{Kind: "return", Value: &Expression{Kind: "variable", Name: "x", Type: qualified}}}},
	}}}
	if err := (Bundle{Version: Version, Root: "app.main", Modules: []Module{app, lib}}).Validate(); err != nil {
		t.Fatal(err)
	}

	missing := app
	missing.Declarations = append([]Declaration(nil), app.Declarations...)
	badType := TypeRef{Name: "lib.types.Missing"}
	missing.Declarations[0].Function = &Function{Params: []Parameter{{Name: "x", Type: badType}}, Result: badType, Body: []Statement{{Kind: "return", Value: &Expression{Kind: "variable", Name: "x", Type: badType}}}}
	if err := (Bundle{Version: Version, Root: "app.main", Modules: []Module{missing, lib}}).Validate(); err == nil || !strings.Contains(err.Error(), "unknown nominal type lib.types.Missing") {
		t.Fatalf("missing type error=%v", err)
	}

	noUse := app
	noUse.Uses = nil
	if err := (Bundle{Version: Version, Root: "app.main", Modules: []Module{noUse, lib}}).Validate(); err == nil || !strings.Contains(err.Error(), "requires direct use lib.types") {
		t.Fatalf("direct-use type error=%v", err)
	}
}

func TestHIRRejectsBodyTypeForgery(t *testing.T) {
	i64 := TypeRef{Name: "i64"}
	boolean := TypeRef{Name: "bool"}
	m := Module{Version: Version, Name: "app.main", Declarations: []Declaration{{
		ID: SymbolID{Module: "app.main", Kind: "fn", Name: "bad"},
		Function: &Function{Params: []Parameter{{Name: "x", Type: i64}}, Result: i64, Body: []Statement{{
			Kind: "return", Value: &Expression{Kind: "variable", Name: "x", Type: boolean},
		}}},
	}}}
	if err := m.Validate(); err == nil {
		t.Fatal("HIR accepted forged variable/return type")
	}
}
