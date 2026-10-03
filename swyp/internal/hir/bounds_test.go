package hir

import "testing"

func TestBoundsEvidenceProvesFixedArrayConstants(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	length := uint64(4)
	array := TypeRef{Name: "array", Args: []TypeRef{u64}, Length: &length}
	index := Expression{Kind: "index", Type: u64, Args: []Expression{
		{Kind: "variable", Name: "x", Type: array},
		{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "3"}},
	}}
	rangeExpr := Expression{Kind: "slice", Type: TypeRef{Name: "slice", Args: []TypeRef{u64}}, Args: []Expression{
		{Kind: "variable", Name: "x", Type: array},
		{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "1"}},
		{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "4"}},
	}}
	bundle := boundsBundle(array, []Statement{{Kind: "expr", Value: &index}, {Kind: "expr", Value: &rangeExpr}})
	report, err := AnalyzeBounds(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Diagnostics) != 0 || len(report.Checks) != 2 {
		t.Fatalf("report=%+v", report)
	}
	for _, check := range report.Checks {
		if check.Status != "proven" {
			t.Fatalf("check=%+v", check)
		}
	}
}

func TestBoundsEvidenceRequiresRuntimeForDynamicAndSliceAccess(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	length := uint64(4)
	array := TypeRef{Name: "array", Args: []TypeRef{u64}, Length: &length}
	slice := TypeRef{Name: "slice", Args: []TypeRef{u64}}
	body := []Statement{
		{Kind: "expr", Value: &Expression{Kind: "index", Type: u64, Args: []Expression{{Kind: "variable", Name: "x", Type: array}, {Kind: "variable", Name: "i", Type: u64}}}},
		{Kind: "expr", Value: &Expression{Kind: "index", Type: u64, Args: []Expression{{Kind: "variable", Name: "s", Type: slice}, {Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "0"}}}}},
	}
	bundle := Module{Version: Version, Name: "bounds", Declarations: []Declaration{{
		ID: SymbolID{Module: "bounds", Kind: "fn", Name: "check"}, Function: &Function{
			Params: []Parameter{{Name: "x", Type: array}, {Name: "i", Type: u64}, {Name: "s", Type: slice}}, Result: TypeRef{Name: "void"}, Body: body,
		},
	}}}
	report, err := AnalyzeBounds(Bundle{Version: Version, Root: "bounds", Modules: []Module{bundle}})
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "ok" || len(report.Checks) != 2 {
		t.Fatalf("report=%+v", report)
	}
	for _, check := range report.Checks {
		if check.Status != "runtime_required" {
			t.Fatalf("check=%+v", check)
		}
	}
}

func TestBoundsEvidenceRejectsStaticOutOfBounds(t *testing.T) {
	u64 := TypeRef{Name: "u64"}
	length := uint64(4)
	array := TypeRef{Name: "array", Args: []TypeRef{u64}, Length: &length}
	body := []Statement{
		{Kind: "expr", Value: &Expression{Kind: "index", Type: u64, Args: []Expression{{Kind: "variable", Name: "x", Type: array}, {Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "4"}}}}},
		{Kind: "expr", Value: &Expression{Kind: "slice", Type: TypeRef{Name: "slice", Args: []TypeRef{u64}}, Args: []Expression{
			{Kind: "variable", Name: "x", Type: array},
			{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "3"}},
			{Kind: "literal", Type: u64, Literal: &Literal{Kind: "number", Value: "2"}},
		}}},
	}
	report, err := AnalyzeBounds(boundsBundle(array, body))
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "error" || len(report.Diagnostics) != 2 {
		t.Fatalf("report=%+v", report)
	}
}

func boundsBundle(array TypeRef, body []Statement) Bundle {
	module := Module{Version: Version, Name: "bounds", Declarations: []Declaration{{
		ID: SymbolID{Module: "bounds", Kind: "fn", Name: "check"}, Function: &Function{
			Params: []Parameter{{Name: "x", Type: array}}, Result: TypeRef{Name: "void"}, Body: body,
		},
	}}}
	return Bundle{Version: Version, Root: "bounds", Modules: []Module{module}}
}
