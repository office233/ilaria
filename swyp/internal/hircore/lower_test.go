package hircore

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/hir"
)

func TestLowerLinkedHIRToExecutableCoreIR(t *testing.T) {
	i64 := hir.TypeRef{Name: "i64"}
	libID := hir.SymbolID{Module: "lib.math", Kind: "fn", Name: "square"}
	lib := hir.Module{Version: hir.Version, Name: "lib.math", Declarations: []hir.Declaration{{
		ID: libID,
		Function: &hir.Function{Params: []hir.Parameter{{Name: "x", Type: i64}}, Result: i64, Body: []hir.Statement{{
			Kind: "return", Value: &hir.Expression{Kind: "binary", Type: i64, Operator: "*", Args: []hir.Expression{
				{Kind: "variable", Name: "x", Type: i64}, {Kind: "variable", Name: "x", Type: i64},
			}},
		}}},
	}}}
	app := hir.Module{Version: hir.Version, Name: "app.main", Uses: []string{"lib.math"}, Declarations: []hir.Declaration{{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Params: []hir.Parameter{{Name: "x", Type: i64}}, Result: i64, Body: []hir.Statement{{
			Kind: "return", Value: &hir.Expression{Kind: "call", Type: i64, Callee: &libID, Args: []hir.Expression{{Kind: "variable", Name: "x", Type: i64}}},
		}}},
	}}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{app, lib}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	if result.Entry != "run" || result.Symbols[libID.Canonical()] == "" {
		t.Fatalf("lower result=%+v", result)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Int(7)}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := run.Value.Int64()
	if !ok || value != 49 {
		t.Fatalf("value=%v int=%d ok=%v", run.Value, value, ok)
	}
}

func TestLowerScalarizesLocalFixedArrayWithProvenIndex(t *testing.T) {
	i64 := hir.TypeRef{Name: "i64"}
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(3)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{i64}, Length: &length}
	lit := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: i64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	index := hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "1"}}
	decl := hir.Declaration{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: i64, Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{lit("5"), lit("7"), lit("9")}}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: i64, Args: []hir.Expression{{Kind: "variable", Name: "xs", Type: array}, index}}},
		}},
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := run.Value.Int64()
	if !ok || value != 7 {
		t.Fatalf("value=%v int=%d ok=%v", run.Value, value, ok)
	}
}

func TestLowerFixedArrayFailsClosedForOOBConstantIndex(t *testing.T) {
	i64 := hir.TypeRef{Name: "i64"}
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(2)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{i64}, Length: &length}
	lit := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: i64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	arrayValue := hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{lit("1"), lit("2")}}
	fn := &hir.Function{Result: i64, Body: []hir.Statement{
		{Kind: "let", Name: "xs", Type: &array, Value: &arrayValue},
		{Kind: "return", Value: &hir.Expression{Kind: "index", Type: i64, Args: []hir.Expression{{Kind: "variable", Name: "xs", Type: array}, {Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "2"}}}}},
	}}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: fn}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	_, err := Lower(bundle, "run")
	if err == nil || !strings.Contains(err.Error(), "out of bounds") {
		t.Fatalf("error=%v", err)
	}
}

func TestLowerDynamicFixedArrayIndexHasRuntimeBoundsCFG(t *testing.T) {
	i64 := hir.TypeRef{Name: "i64"}
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(3)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{i64}, Length: &length}
	lit := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: i64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "i", Type: u64}}, Result: i64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{lit("5"), lit("7"), lit("9")}}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: i64, Args: []hir.Expression{{Kind: "variable", Name: "xs", Type: array}, {Kind: "variable", Name: "i", Type: u64}}}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for index, want := range []int64{5, 7, 9} {
		run, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(uint64(index))}, 1000)
		if err != nil {
			t.Fatalf("index %d: %v", index, err)
		}
		got, ok := run.Value.Int64()
		if !ok || got != want {
			t.Fatalf("index %d value=%v int=%d ok=%v want=%d", index, run.Value, got, ok, want)
		}
	}
	if _, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(3)}, 1000); err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("OOB runtime error=%v", err)
	}
}

func TestLowerFixedArrayRespectsScalarShadowing(t *testing.T) {
	i64 := hir.TypeRef{Name: "i64"}
	u64 := hir.TypeRef{Name: "u64"}
	boolean := hir.TypeRef{Name: "bool"}
	length := uint64(1)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{i64}, Length: &length}
	decl := hir.Declaration{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: i64, Body: []hir.Statement{
			{Kind: "let", Name: "x", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{{Kind: "literal", Type: i64, Literal: &hir.Literal{Kind: "number", Value: "1"}}}}},
			{Kind: "if", Value: &hir.Expression{Kind: "literal", Type: boolean, Literal: &hir.Literal{Kind: "bool", Value: "true"}}, Body: []hir.Statement{
				{Kind: "let", Name: "x", Type: &i64, Value: &hir.Expression{Kind: "literal", Type: i64, Literal: &hir.Literal{Kind: "number", Value: "9"}}},
				{Kind: "return", Value: &hir.Expression{Kind: "variable", Name: "x", Type: i64}},
			}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: i64, Args: []hir.Expression{{Kind: "variable", Name: "x", Type: array}, {Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "0"}}}}},
		}},
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := run.Value.Int64()
	if !ok || value != 9 {
		t.Fatalf("value=%v int=%d ok=%v", run.Value, value, ok)
	}
}

func TestLowerScalarizesLocalFixedStructFieldProjection(t *testing.T) {
	i64 := hir.TypeRef{Name: "i64"}
	point := hir.TypeRef{Name: "Point"}
	pointDecl := hir.Declaration{
		ID:     hir.SymbolID{Module: "app.main", Kind: "struct", Name: "Point"},
		Fields: []hir.Field{{Name: "x", Type: i64}, {Name: "y", Type: i64}},
	}
	lit := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: i64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	runDecl := hir.Declaration{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: i64, Body: []hir.Statement{
			{Kind: "let", Name: "p", Type: &point, Value: &hir.Expression{Kind: "struct", Type: point, Fields: []hir.FieldValue{{Name: "x", Value: lit("5")}, {Name: "y", Value: lit("7")}}}},
			{Kind: "return", Value: &hir.Expression{Kind: "field", Name: "y", Type: i64, Args: []hir.Expression{{Kind: "variable", Name: "p", Type: point}}}},
		}},
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{pointDecl, runDecl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := run.Value.Int64()
	if !ok || value != 7 {
		t.Fatalf("value=%v int=%d ok=%v", run.Value, value, ok)
	}
}

func TestLowerFixedStructFailsClosedForUnsupportedFieldType(t *testing.T) {
	stringType := hir.TypeRef{Name: "string"}
	box := hir.TypeRef{Name: "Box"}
	boxDecl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "struct", Name: "Box"}, Fields: []hir.Field{{Name: "value", Type: stringType}}}
	runDecl := hir.Declaration{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: hir.TypeRef{Name: "i64"}, Body: []hir.Statement{
			{Kind: "let", Name: "b", Type: &box, Value: &hir.Expression{Kind: "struct", Type: box, Fields: []hir.FieldValue{{Name: "value", Value: hir.Expression{Kind: "literal", Type: stringType, Literal: &hir.Literal{Kind: "string", Value: "x"}}}}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{{Kind: "variable", Name: "b", Type: box}}}},
			{Kind: "return", Value: &hir.Expression{Kind: "literal", Type: hir.TypeRef{Name: "i64"}, Literal: &hir.Literal{Kind: "number", Value: "0"}}},
		}},
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{boxDecl, runDecl}}}}
	_, err := Lower(bundle, "run")
	if err == nil || !strings.Contains(err.Error(), "fixed-struct field Box.value") {
		t.Fatalf("error=%v", err)
	}
}

func TestLowerScalarizesCompileTimeKnownOptionMatch(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	option := hir.TypeRef{Name: "option", Args: []hir.TypeRef{u64}}
	literal := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	runDecl := hir.Declaration{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: u64, Body: []hir.Statement{
			{Kind: "let", Name: "value", Type: &option, Value: &hir.Expression{Kind: "enum", Name: "Some", Type: option, Args: []hir.Expression{literal("7")}}},
			{Kind: "return", Value: &hir.Expression{Kind: "match", Type: u64, Args: []hir.Expression{{Kind: "variable", Name: "value", Type: option}}, Arms: []hir.MatchArm{
				{Variant: "None", Value: literal("0")},
				{Variant: "Some", Binding: "x", BindingType: &u64, Value: hir.Expression{Kind: "variable", Name: "x", Type: u64}},
			}}},
		}},
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{runDecl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := run.Value.Uint64()
	if !ok || value != 7 {
		t.Fatalf("value=%v uint=%d ok=%v", run.Value, value, ok)
	}
}

func TestLowerScalarizesCompileTimeKnownNominalEnumMatch(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	lookup := hir.TypeRef{Name: "Lookup"}
	enumDecl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "enum", Name: "Lookup"}, Variants: []hir.Variant{{Name: "Missing"}, {Name: "Found", Payload: &u64}}}
	literal := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	runDecl := hir.Declaration{
		ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: u64, Body: []hir.Statement{
			{Kind: "let", Name: "value", Type: &lookup, Value: &hir.Expression{Kind: "enum", Name: "Found", Type: lookup, Args: []hir.Expression{literal("9")}}},
			{Kind: "return", Value: &hir.Expression{Kind: "match", Type: u64, Args: []hir.Expression{{Kind: "variable", Name: "value", Type: lookup}}, Arms: []hir.MatchArm{
				{Variant: "Missing", Value: literal("0")},
				{Variant: "Found", Binding: "x", BindingType: &u64, Value: hir.Expression{Kind: "variable", Name: "x", Type: u64}},
			}}},
		}},
	}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{enumDecl, runDecl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := run.Value.Uint64()
	if !ok || value != 9 {
		t.Fatalf("value=%v uint=%d ok=%v", run.Value, value, ok)
	}
}

func TestLowerLocalMutableRefAliasesCoreScalarSlot(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	mutref := hir.TypeRef{Name: "mutref", Args: []hir.TypeRef{u64}}
	x := hir.Expression{Kind: "variable", Name: "x", Type: u64}
	r := hir.Expression{Kind: "variable", Name: "r", Type: mutref}
	seven := hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "7"}}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "x", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "r", Type: &mutref, Value: &hir.Expression{Kind: "borrow", Type: mutref, Operator: "mut", Args: []hir.Expression{x}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "store", Args: []hir.Expression{r, seven}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{r}}},
			{Kind: "return", Value: &x},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(1)}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := run.Value.Uint64()
	if !ok || got != 7 {
		t.Fatalf("value=%v uint=%d ok=%v", run.Value, got, ok)
	}
}

func TestLowerLocalSharedRefDereference(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	ref := hir.TypeRef{Name: "ref", Args: []hir.TypeRef{u64}}
	x := hir.Expression{Kind: "variable", Name: "x", Type: u64}
	r := hir.Expression{Kind: "variable", Name: "r", Type: ref}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "x", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "r", Type: &ref, Value: &hir.Expression{Kind: "borrow", Type: ref, Operator: "shared", Args: []hir.Expression{x}}},
			{Kind: "let", Name: "y", Type: &u64, Value: &hir.Expression{Kind: "deref", Type: u64, Args: []hir.Expression{r}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{r}}},
			{Kind: "return", Value: &hir.Expression{Kind: "variable", Name: "y", Type: u64}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	run, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(11)}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := run.Value.Uint64()
	if !ok || got != 11 {
		t.Fatalf("value=%v uint=%d ok=%v", run.Value, got, ok)
	}
}

func TestLowerLocalMutableRefToFixedStructField(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	point := hir.TypeRef{Name: "Point"}
	mutref := hir.TypeRef{Name: "mutref", Args: []hir.TypeRef{u64}}
	pointDecl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "struct", Name: "Point"}, Fields: []hir.Field{{Name: "x", Type: u64}, {Name: "y", Type: u64}}}
	lit := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	p := hir.Expression{Kind: "variable", Name: "p", Type: point}
	px := hir.Expression{Kind: "field", Name: "x", Type: u64, Args: []hir.Expression{p}}
	r := hir.Expression{Kind: "variable", Name: "r", Type: mutref}
	runDecl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{Result: u64, Body: []hir.Statement{
		{Kind: "let", Name: "p", Type: &point, Value: &hir.Expression{Kind: "struct", Type: point, Fields: []hir.FieldValue{{Name: "x", Value: lit("5")}, {Name: "y", Value: lit("7")}}}},
		{Kind: "let", Name: "r", Type: &mutref, Value: &hir.Expression{Kind: "borrow", Type: mutref, Operator: "mut", Args: []hir.Expression{px}}},
		{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "store", Args: []hir.Expression{r, lit("9")}}},
		{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{r}}},
		{Kind: "return", Value: &px},
	}}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{pointDecl, runDecl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	resultValue, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := resultValue.Value.Uint64()
	if !ok || got != 9 {
		t.Fatalf("value=%v uint=%d ok=%v", resultValue.Value, got, ok)
	}
}

func TestLowerLocalMutableRefToFixedArrayElement(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(2)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	mutref := hir.TypeRef{Name: "mutref", Args: []hir.TypeRef{u64}}
	lit := func(value string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: value}}
	}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	index := lit("1")
	element := hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{xs, index}}
	r := hir.Expression{Kind: "variable", Name: "r", Type: mutref}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{Result: u64, Body: []hir.Statement{
		{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{lit("5"), lit("7")}}},
		{Kind: "let", Name: "r", Type: &mutref, Value: &hir.Expression{Kind: "borrow", Type: mutref, Operator: "mut", Args: []hir.Expression{element}}},
		{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "store", Args: []hir.Expression{r, lit("9")}}},
		{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{r}}},
		{Kind: "return", Value: &element},
	}}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	resultValue, err := executable.Run(context.Background(), result.Entry, nil, 1000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := resultValue.Value.Uint64()
	if !ok || got != 9 {
		t.Fatalf("value=%v uint=%d ok=%v", resultValue.Value, got, ok)
	}
}

func TestLowerLocalRefsUseOwnershipGateAndRejectDynamicPlace(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	mutref := hir.TypeRef{Name: "mutref", Args: []hir.TypeRef{u64}}
	x := hir.Expression{Kind: "variable", Name: "x", Type: u64}
	r1 := hir.Expression{Kind: "variable", Name: "a", Type: mutref}
	r2 := hir.Expression{Kind: "variable", Name: "b", Type: mutref}
	badOwnership := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "x", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "a", Type: &mutref, Value: &hir.Expression{Kind: "borrow", Type: mutref, Operator: "mut", Args: []hir.Expression{x}}},
			{Kind: "let", Name: "b", Type: &mutref, Value: &hir.Expression{Kind: "borrow", Type: mutref, Operator: "mut", Args: []hir.Expression{x}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{r1}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{r2}}},
			{Kind: "return", Value: &x},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{badOwnership}}}}
	if _, err := Lower(bundle, "run"); err == nil || !strings.Contains(err.Error(), "HIR ownership gate") {
		t.Fatalf("ownership gate error=%v", err)
	}

	length := uint64(2)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	i := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	dynamicElement := hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{xs, i}}
	dynamic := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "1"}}, {Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "2"}}}}},
			{Kind: "let", Name: "r", Type: &mutref, Value: &hir.Expression{Kind: "borrow", Type: mutref, Operator: "mut", Args: []hir.Expression{dynamicElement}}},
			{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{{Kind: "variable", Name: "r", Type: mutref}}}},
			{Kind: "return", Value: &hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "0"}}},
		},
	}}
	bundle = hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{dynamic}}}}
	if _, err := Lower(bundle, "run"); err == nil || !strings.Contains(err.Error(), "compile-time u64 index") {
		t.Fatalf("dynamic ref lowering error=%v", err)
	}
}

func TestLowerFixedSumFailsClosedForDynamicParameter(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	option := hir.TypeRef{Name: "option", Args: []hir.TypeRef{u64}}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "value", Type: option}}, Result: u64,
		Body: []hir.Statement{{Kind: "return", Value: &hir.Expression{Kind: "match", Type: u64, Args: []hir.Expression{{Kind: "variable", Name: "value", Type: option}}, Arms: []hir.MatchArm{
			{Variant: "None", Value: hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "0"}}},
			{Variant: "Some", Binding: "x", BindingType: &u64, Value: hir.Expression{Kind: "variable", Name: "x", Type: u64}},
		}}}},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	_, err := Lower(bundle, "run")
	if err == nil || !strings.Contains(err.Error(), "parameter value") {
		t.Fatalf("error=%v", err)
	}
}

func TestLowerPropagatesEffectsAcrossImportedCall(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	nowID := hir.SymbolID{Module: "lib.clock", Kind: "fn", Name: "now"}
	lib := hir.Module{Version: hir.Version, Name: "lib.clock", Declarations: []hir.Declaration{{
		ID:       nowID,
		Function: &hir.Function{Result: u64, Body: []hir.Statement{{Kind: "return", Value: &hir.Expression{Kind: "call", Type: u64, Builtin: "clock"}}}},
	}}}
	app := hir.Module{Version: hir.Version, Name: "app.main", Uses: []string{"lib.clock"}, Declarations: []hir.Declaration{{
		ID:       hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"},
		Function: &hir.Function{Result: u64, Body: []hir.Statement{{Kind: "return", Value: &hir.Expression{Kind: "call", Type: u64, Callee: &nowID}}}},
	}}}
	result, err := Lower(hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{app, lib}}, "run")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range result.Module.Functions {
		if len(f.Effects) != 1 || f.Effects[0] != coreir.EffectClockRead || len(f.RequiredCapabilities) != 1 || f.RequiredCapabilities[0].Name != "clock_read" {
			t.Fatalf("function %s effects=%v caps=%v", f.Name, f.Effects, f.RequiredCapabilities)
		}
	}
}

func TestLowerFixedSliceViewFromScalarizedArray(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(4)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	slice := hir.TypeRef{Name: "slice", Args: []hir.TypeRef{u64}}
	i := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	s := hir.Expression{Kind: "variable", Name: "s", Type: slice}
	num := func(v string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: v}}
	}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{num("10"), num("20"), num("30"), num("40")}}},
			{Kind: "let", Name: "s", Type: &slice, Value: &hir.Expression{Kind: "slice", Type: slice, Args: []hir.Expression{xs, num("1"), num("4")}}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{s, i}}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		index uint64
		want  uint64
	}{{0, 20}, {1, 30}, {2, 40}} {
		run, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(tc.index)}, 5000)
		if err != nil {
			t.Fatalf("index %d: %v", tc.index, err)
		}
		got, ok := run.Value.Uint64()
		if !ok || got != tc.want {
			t.Fatalf("index %d value=%v got=%d ok=%v want=%d", tc.index, run.Value, got, ok, tc.want)
		}
	}
	if _, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(3)}, 5000); err == nil {
		t.Fatal("out-of-range fixed slice index unexpectedly succeeded")
	}
}

func TestLowerFixedSliceAcceptsRuntimeRangeBounds(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(3)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	slice := hir.TypeRef{Name: "slice", Args: []hir.TypeRef{u64}}
	i := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	num := func(v string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: v}}
	}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{num("1"), num("2"), num("3")}}},
			{Kind: "let", Name: "s", Type: &slice, Value: &hir.Expression{Kind: "slice", Type: slice, Args: []hir.Expression{xs, i, num("3")}}},
			{Kind: "return", Value: func() *hir.Expression { v := num("0"); return &v }()},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	if _, err := Lower(bundle, "run"); err != nil {
		t.Fatalf("dynamic fixed-slice range lowering failed: %v", err)
	}
}

func TestLowerDynamicFixedSliceRangeAndIndex(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(4)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	slice := hir.TypeRef{Name: "slice", Args: []hir.TypeRef{u64}}
	start := hir.Expression{Kind: "variable", Name: "start", Type: u64}
	end := hir.Expression{Kind: "variable", Name: "end", Type: u64}
	index := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	s := hir.Expression{Kind: "variable", Name: "s", Type: slice}
	num := func(v string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: v}}
	}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "start", Type: u64}, {Name: "end", Type: u64}, {Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: []hir.Expression{num("10"), num("20"), num("30"), num("40")}}},
			{Kind: "let", Name: "s", Type: &slice, Value: &hir.Expression{Kind: "slice", Type: slice, Args: []hir.Expression{xs, start, end}}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{s, index}}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args []uint64
		want uint64
	}{{[]uint64{1, 4, 0}, 20}, {[]uint64{1, 4, 2}, 40}, {[]uint64{0, 2, 1}, 20}} {
		values := []coreir.Value{coreir.Uint(tc.args[0]), coreir.Uint(tc.args[1]), coreir.Uint(tc.args[2])}
		run, err := executable.Run(context.Background(), result.Entry, values, 10000)
		if err != nil {
			t.Fatalf("args=%v: %v", tc.args, err)
		}
		got, ok := run.Value.Uint64()
		if !ok || got != tc.want {
			t.Fatalf("args=%v got=%d ok=%v want=%d", tc.args, got, ok, tc.want)
		}
	}
	for _, args := range [][]uint64{{3, 2, 0}, {1, 5, 0}, {1, 4, 3}} {
		values := []coreir.Value{coreir.Uint(args[0]), coreir.Uint(args[1]), coreir.Uint(args[2])}
		if _, err := executable.Run(context.Background(), result.Entry, values, 10000); err == nil {
			t.Fatalf("invalid args=%v unexpectedly succeeded", args)
		}
	}
}

func TestLowerLargeU64ArrayUsesCoreStorage(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(65)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	values := make([]hir.Expression, length)
	for i := range values {
		values[i] = hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: strconv.Itoa(i + 100)}}
	}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	i := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: values}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{xs, i}}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	var sawAlloc, sawStore, sawLoad bool
	for _, f := range result.Module.Functions {
		for _, block := range f.Blocks {
			for _, ins := range block.Instructions {
				switch ins.Op {
				case "storage.alloc_u64":
					sawAlloc = true
				case "storage.store_u64":
					sawStore = true
				case "storage.load_u64":
					sawLoad = true
				}
			}
		}
	}
	if !sawAlloc || !sawStore || !sawLoad {
		t.Fatalf("storage ops missing alloc=%v store=%v load=%v", sawAlloc, sawStore, sawLoad)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []struct {
		name string
		run  func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error)
	}{{"run", executable.Run}, {"fast", executable.RunFast}, {"turbo", executable.RunTurbo}} {
		got, err := mode.run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(64)}, 10000)
		if err != nil {
			t.Fatalf("%s: %v", mode.name, err)
		}
		value, ok := got.Value.Uint64()
		if !ok || value != 164 {
			t.Fatalf("%s value=%d ok=%v want=164", mode.name, value, ok)
		}
		if _, err := mode.run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(65)}, 10000); err == nil {
			t.Fatalf("%s OOB unexpectedly succeeded", mode.name)
		}
	}
}

func TestLowerStorageBackedSliceView(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(65)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	slice := hir.TypeRef{Name: "slice", Args: []hir.TypeRef{u64}}
	values := make([]hir.Expression, length)
	for i := range values {
		values[i] = hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: strconv.Itoa(i + 100)}}
	}
	num := func(v string) hir.Expression {
		return hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: v}}
	}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	s := hir.Expression{Kind: "variable", Name: "s", Type: slice}
	i := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: values}},
			{Kind: "let", Name: "s", Type: &slice, Value: &hir.Expression{Kind: "slice", Type: slice, Args: []hir.Expression{xs, num("60"), num("65")}}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{s, i}}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []struct {
		name string
		run  func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error)
	}{{"run", executable.Run}, {"fast", executable.RunFast}, {"turbo", executable.RunTurbo}} {
		got, err := mode.run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(4)}, 20000)
		if err != nil {
			t.Fatalf("%s: %v", mode.name, err)
		}
		value, ok := got.Value.Uint64()
		if !ok || value != 164 {
			t.Fatalf("%s value=%d ok=%v want=164", mode.name, value, ok)
		}
		if _, err := mode.run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(5)}, 20000); err == nil {
			t.Fatalf("%s OOB unexpectedly succeeded", mode.name)
		}
	}
}

func TestLowerStorageBackedDynamicSliceRange(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	length := uint64(65)
	array := hir.TypeRef{Name: "array", Args: []hir.TypeRef{u64}, Length: &length}
	slice := hir.TypeRef{Name: "slice", Args: []hir.TypeRef{u64}}
	values := make([]hir.Expression, length)
	for i := range values {
		values[i] = hir.Expression{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: strconv.Itoa(i)}}
	}
	xs := hir.Expression{Kind: "variable", Name: "xs", Type: array}
	s := hir.Expression{Kind: "variable", Name: "s", Type: slice}
	start := hir.Expression{Kind: "variable", Name: "start", Type: u64}
	end := hir.Expression{Kind: "variable", Name: "end", Type: u64}
	i := hir.Expression{Kind: "variable", Name: "i", Type: u64}
	decl := hir.Declaration{ID: hir.SymbolID{Module: "app.main", Kind: "fn", Name: "run"}, Function: &hir.Function{
		Params: []hir.Parameter{{Name: "start", Type: u64}, {Name: "end", Type: u64}, {Name: "i", Type: u64}}, Result: u64,
		Body: []hir.Statement{
			{Kind: "let", Name: "xs", Type: &array, Value: &hir.Expression{Kind: "array", Type: array, Args: values}},
			{Kind: "let", Name: "s", Type: &slice, Value: &hir.Expression{Kind: "slice", Type: slice, Args: []hir.Expression{xs, start, end}}},
			{Kind: "return", Value: &hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{s, i}}},
		},
	}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app.main", Modules: []hir.Module{{Version: hir.Version, Name: "app.main", Declarations: []hir.Declaration{decl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := executable.Run(context.Background(), result.Entry, []coreir.Value{coreir.Uint(60), coreir.Uint(65), coreir.Uint(4)}, 20000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := got.Value.Uint64()
	if !ok || value != 64 {
		t.Fatalf("value=%d ok=%v want=64", value, ok)
	}
	for _, args := range [][]coreir.Value{
		{coreir.Uint(64), coreir.Uint(63), coreir.Uint(0)},
		{coreir.Uint(60), coreir.Uint(66), coreir.Uint(0)},
		{coreir.Uint(60), coreir.Uint(65), coreir.Uint(5)},
	} {
		if _, err := executable.Run(context.Background(), result.Entry, args, 20000); err == nil {
			t.Fatalf("invalid args=%v unexpectedly succeeded", args)
		}
	}
}

func TestLowerStorageVecReturnUsesDescriptorHandle(t *testing.T) {
	u64 := hir.TypeRef{Name: "u64"}
	vec := hir.TypeRef{Name: "vec", Args: []hir.TypeRef{u64}}
	makeID := hir.SymbolID{Module: "app", Kind: "fn", Name: "make"}
	runID := hir.SymbolID{Module: "app", Kind: "fn", Name: "run"}
	makeDecl := hir.Declaration{ID: makeID, Function: &hir.Function{Result: vec, Body: []hir.Statement{
		{Kind: "let", Name: "v", Type: &vec, Value: &hir.Expression{Kind: "vec", Type: vec, Args: []hir.Expression{
			{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "10"}},
			{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "20"}},
		}}},
		{Kind: "return", Value: &hir.Expression{Kind: "variable", Name: "v", Type: vec}},
	}}}
	runDecl := hir.Declaration{ID: runID, Function: &hir.Function{Result: u64, Body: []hir.Statement{
		{Kind: "let", Name: "v", Type: &vec, Value: &hir.Expression{Kind: "call", Type: vec, Callee: &makeID}},
		{Kind: "let", Name: "x", Type: &u64, Value: &hir.Expression{Kind: "index", Type: u64, Args: []hir.Expression{
			{Kind: "variable", Name: "v", Type: vec},
			{Kind: "literal", Type: u64, Literal: &hir.Literal{Kind: "number", Value: "1"}},
		}}},
		{Kind: "expr", Value: &hir.Expression{Kind: "call", Type: hir.TypeRef{Name: "void"}, Builtin: "drop", Args: []hir.Expression{{Kind: "variable", Name: "v", Type: vec}}}},
		{Kind: "return", Value: &hir.Expression{Kind: "variable", Name: "x", Type: u64}},
	}}}
	bundle := hir.Bundle{Version: hir.Version, Root: "app", Modules: []hir.Module{{Version: hir.Version, Name: "app", Declarations: []hir.Declaration{makeDecl, runDecl}}}}
	result, err := Lower(bundle, "run")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(result.Module)
	if err != nil {
		t.Fatal(err)
	}
	got, err := executable.Run(context.Background(), result.Entry, nil, 20000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := got.Value.Uint64()
	if !ok || value != 20 {
		t.Fatalf("value=%d ok=%v want=20", value, ok)
	}
	for _, f := range result.Module.Functions {
		if f.Name == result.Symbols[makeID.Canonical()] && f.Result != coreir.U64 {
			t.Fatalf("vec-return lowered result=%s want u64 descriptor handle", f.Result)
		}
	}
}
