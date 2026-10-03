package hir

import (
	"strings"
	"testing"
)

func TestOwnershipClassification(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	vec := TypeRef{Name: "vec", Args: []TypeRef{u64}}
	slice := TypeRef{Name: "slice", Args: []TypeRef{u64}}
	copyStruct := Declaration{ID: SymbolID{Module: "types", Kind: "struct", Name: "Point"}, Fields: []Field{{Name: "x", Type: u64}, {Name: "y", Type: u64}}}
	moveStruct := Declaration{ID: SymbolID{Module: "types", Kind: "struct", Name: "Buffer"}, Fields: []Field{{Name: "data", Type: vec}}}
	borrowStruct := Declaration{ID: SymbolID{Module: "types", Kind: "struct", Name: "View"}, Fields: []Field{{Name: "data", Type: slice}}}
	table, err := BuildTypeTable([]Module{{Version: Version, Name: "types", Declarations: []Declaration{copyStruct, moveStruct, borrowStruct}}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		typ  TypeRef
		want OwnershipClass
	}{
		{u64, OwnershipCopy},
		{vec, OwnershipMove},
		{slice, OwnershipBorrowed},
		{TypeRef{Name: "Point"}, OwnershipCopy},
		{TypeRef{Name: "Buffer"}, OwnershipMove},
		{TypeRef{Name: "View"}, OwnershipBorrowed},
		{TypeRef{Name: "option", Args: []TypeRef{u64}}, OwnershipCopy},
		{TypeRef{Name: "result", Args: []TypeRef{vec, u64}}, OwnershipMove},
	}
	for _, tc := range cases {
		got, err := OwnershipOf(table, "types", tc.typ)
		if err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Fatalf("ownership %s=%s want=%s", tc.typ.String(), got, tc.want)
		}
	}
}

func TestOwnershipDetectsDoubleMoveAndImplicitDrop(t *testing.T) {
	owned := TypeRef{Name: "vec", Args: []TypeRef{{Name: "u64"}}}
	consumeID := SymbolID{Module: "app", Kind: "fn", Name: "consume"}
	consume := Declaration{ID: consumeID, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}}, Result: TypeRef{Name: "void"}}}
	bad := Declaration{ID: SymbolID{Module: "app", Kind: "fn", Name: "bad"}, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}}, Result: TypeRef{Name: "void"}, Body: []Statement{
		{Kind: "expr", Value: &Expression{Kind: "call", Type: TypeRef{Name: "void"}, Callee: &consumeID, Args: []Expression{{Kind: "variable", Name: "x", Type: owned}}}},
		{Kind: "expr", Value: &Expression{Kind: "call", Type: TypeRef{Name: "void"}, Callee: &consumeID, Args: []Expression{{Kind: "variable", Name: "x", Type: owned}}}},
	}}}
	leak := Declaration{ID: SymbolID{Module: "app", Kind: "fn", Name: "leak"}, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}}, Result: TypeRef{Name: "void"}}}
	bundle := Bundle{Version: Version, Root: "app", Modules: []Module{{Version: Version, Name: "app", Declarations: []Declaration{consume, bad, leak}}}}
	report, err := AnalyzeOwnership(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "error" {
		t.Fatalf("report=%+v", report)
	}
	joined := ownershipMessages(report.Diagnostics)
	if !strings.Contains(joined, "use of moved value x") || !strings.Contains(joined, "reaches scope end without consumption") {
		t.Fatalf("diagnostics=%s", joined)
	}
}

func TestOwnershipRejectsBorrowEscapeAndLoopMove(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	owned := TypeRef{Name: "vec", Args: []TypeRef{u64}}
	slice := TypeRef{Name: "slice", Args: []TypeRef{u64}}
	borrow := Declaration{ID: SymbolID{Module: "app", Kind: "fn", Name: "borrow"}, Function: &Function{Params: []Parameter{{Name: "x", Type: slice}}, Result: slice, Body: []Statement{{Kind: "return", Value: &Expression{Kind: "variable", Name: "x", Type: slice}}}}}
	consumeID := SymbolID{Module: "app", Kind: "fn", Name: "consume"}
	consume := Declaration{ID: consumeID, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}}, Result: TypeRef{Name: "void"}}}
	loop := Declaration{ID: SymbolID{Module: "app", Kind: "fn", Name: "loop"}, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}}, Result: TypeRef{Name: "void"}, Body: []Statement{{Kind: "while", Value: &Expression{Kind: "literal", Type: TypeRef{Name: "bool"}, Literal: &Literal{Kind: "bool", Value: "true"}}, Body: []Statement{{Kind: "expr", Value: &Expression{Kind: "call", Type: TypeRef{Name: "void"}, Callee: &consumeID, Args: []Expression{{Kind: "variable", Name: "x", Type: owned}}}}}}}}}
	bundle := Bundle{Version: Version, Root: "app", Modules: []Module{{Version: Version, Name: "app", Declarations: []Declaration{borrow, consume, loop}}}}
	report, err := AnalyzeOwnership(bundle)
	if err != nil {
		t.Fatal(err)
	}
	joined := ownershipMessages(report.Diagnostics)
	if !strings.Contains(joined, "returning a borrowed value") || !strings.Contains(joined, "ownership state of x changes across loop") {
		t.Fatalf("diagnostics=%s", joined)
	}
}

func TestOwnershipRejectsUnbalancedMatchMove(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	owned := TypeRef{Name: "vec", Args: []TypeRef{u64}}
	option := TypeRef{Name: "option", Args: []TypeRef{u64}}
	consumeID := SymbolID{Module: "app", Kind: "fn", Name: "consume"}
	consume := Declaration{ID: consumeID, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}}, Result: TypeRef{Name: "void"}}}
	bad := Declaration{ID: SymbolID{Module: "app", Kind: "fn", Name: "bad_match"}, Function: &Function{Params: []Parameter{{Name: "x", Type: owned}, {Name: "m", Type: option}}, Result: u64, Body: []Statement{{Kind: "return", Value: &Expression{
		Kind: "match", Type: u64, Args: []Expression{{Kind: "variable", Name: "m", Type: option}}, Arms: []MatchArm{
			{Variant: "None", Value: Expression{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "0"}}},
			{Variant: "Some", Binding: "v", BindingType: &u64, Value: Expression{Kind: "call", Type: TypeRef{Name: "void"}, Callee: &consumeID, Args: []Expression{{Kind: "variable", Name: "x", Type: owned}}}},
		},
	}}}}}
	// The forged HIR above intentionally gives one arm a void result, which the
	// ordinary HIR validator rejects before ownership. Use a bool-returning sink
	// so both match arms stay type-correct while only one consumes x.
	consume.Function.Result = u64
	bad.Function.Body[0].Value.Arms[1].Value.Type = u64
	bundle := Bundle{Version: Version, Root: "app", Modules: []Module{{Version: Version, Name: "app", Declarations: []Declaration{consume, bad}}}}
	report, err := AnalyzeOwnership(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ownershipMessages(report.Diagnostics), "differs across match arms") {
		t.Fatalf("diagnostics=%s", ownershipMessages(report.Diagnostics))
	}
}

func ownershipMessages(diagnostics []OwnershipDiagnostic) string {
	var b strings.Builder
	for _, diagnostic := range diagnostics {
		b.WriteString(diagnostic.Code)
		b.WriteString(":")
		b.WriteString(diagnostic.Message)
		b.WriteByte('\n')
	}
	return b.String()
}
