package hir

import (
	"fmt"
	"sort"
)

const BoundsEvidenceVersion = 1

type BoundsReport struct {
	Version     int                `json:"version"`
	Root        string             `json:"root"`
	Status      string             `json:"status"`
	Checks      []BoundsCheck      `json:"checks,omitempty"`
	Diagnostics []BoundsDiagnostic `json:"diagnostics,omitempty"`
}

type BoundsCheck struct {
	Function string   `json:"function"`
	Kind     string   `json:"kind"`
	Status   string   `json:"status"` // proven | runtime_required
	BaseType string   `json:"base_type"`
	Location Location `json:"location,omitempty"`
}

type BoundsDiagnostic struct {
	Code     string   `json:"code"`
	Function string   `json:"function"`
	Message  string   `json:"message"`
	Location Location `json:"location,omitempty"`
}

// AnalyzeBounds emits deterministic evidence for every HIR index/slice access.
// It proves only facts available from fixed array lengths and literal u64 bounds.
// Anything dependent on runtime values or slice descriptor length remains
// runtime_required; no optimistic range inference is performed here.
func AnalyzeBounds(bundle Bundle) (BoundsReport, error) {
	if err := bundle.Validate(); err != nil {
		return BoundsReport{}, fmt.Errorf("validate HIR bundle: %w", err)
	}
	report := BoundsReport{Version: BoundsEvidenceVersion, Root: bundle.Root, Status: "ok"}
	for _, module := range bundle.Modules {
		for _, decl := range module.Declarations {
			if decl.Function == nil {
				continue
			}
			function := decl.ID.Canonical()
			analyzeBoundsStatements(decl.Function.Body, function, &report)
		}
	}
	sort.Slice(report.Checks, func(i, j int) bool {
		a, b := report.Checks[i], report.Checks[j]
		if a.Function != b.Function {
			return a.Function < b.Function
		}
		if a.Location.File != b.Location.File {
			return a.Location.File < b.Location.File
		}
		if a.Location.Line != b.Location.Line {
			return a.Location.Line < b.Location.Line
		}
		if a.Location.Column != b.Location.Column {
			return a.Location.Column < b.Location.Column
		}
		return a.Kind < b.Kind
	})
	sort.Slice(report.Diagnostics, func(i, j int) bool {
		a, b := report.Diagnostics[i], report.Diagnostics[j]
		if a.Function != b.Function {
			return a.Function < b.Function
		}
		if a.Location.File != b.Location.File {
			return a.Location.File < b.Location.File
		}
		if a.Location.Line != b.Location.Line {
			return a.Location.Line < b.Location.Line
		}
		if a.Location.Column != b.Location.Column {
			return a.Location.Column < b.Location.Column
		}
		return a.Code < b.Code
	})
	if len(report.Diagnostics) != 0 {
		report.Status = "error"
	}
	return report, nil
}

func analyzeBoundsStatements(body []Statement, function string, report *BoundsReport) {
	for _, stmt := range body {
		if stmt.Value != nil {
			analyzeBoundsExpression(*stmt.Value, function, report)
		}
		analyzeBoundsStatements(stmt.Body, function, report)
		analyzeBoundsStatements(stmt.Else, function, report)
	}
}

func analyzeBoundsExpression(e Expression, function string, report *BoundsReport) {
	for _, arg := range e.Args {
		analyzeBoundsExpression(arg, function, report)
	}
	for _, field := range e.Fields {
		analyzeBoundsExpression(field.Value, function, report)
	}
	for _, arm := range e.Arms {
		analyzeBoundsExpression(arm.Value, function, report)
	}
	switch e.Kind {
	case "index":
		analyzeIndexBounds(e, function, report)
	case "slice":
		analyzeSliceBounds(e, function, report)
	}
}

func analyzeIndexBounds(e Expression, function string, report *BoundsReport) {
	if len(e.Args) != 2 {
		return
	}
	base, index := e.Args[0], e.Args[1]
	check := BoundsCheck{Function: function, Kind: "index", Status: "runtime_required", BaseType: base.Type.String(), Location: e.Location}
	if base.Type.Name == "array" && base.Type.Length != nil {
		if value, ok := constantU64Index(index); ok {
			if value >= *base.Type.Length {
				report.Diagnostics = append(report.Diagnostics, BoundsDiagnostic{
					Code: "index_out_of_bounds", Function: function, Location: e.Location,
					Message: fmt.Sprintf("constant index %d is outside array length %d", value, *base.Type.Length),
				})
				return
			}
			check.Status = "proven"
		}
	}
	report.Checks = append(report.Checks, check)
}

func analyzeSliceBounds(e Expression, function string, report *BoundsReport) {
	if len(e.Args) != 3 {
		return
	}
	base, startExpr, endExpr := e.Args[0], e.Args[1], e.Args[2]
	check := BoundsCheck{Function: function, Kind: "range", Status: "runtime_required", BaseType: base.Type.String(), Location: e.Location}
	if base.Type.Name == "array" && base.Type.Length != nil {
		start, startOK := constantU64Index(startExpr)
		end, endOK := constantU64Index(endExpr)
		if startOK && endOK {
			if start > end {
				report.Diagnostics = append(report.Diagnostics, BoundsDiagnostic{
					Code: "range_order", Function: function, Location: e.Location,
					Message: fmt.Sprintf("constant range start %d exceeds end %d", start, end),
				})
				return
			}
			if end > *base.Type.Length {
				report.Diagnostics = append(report.Diagnostics, BoundsDiagnostic{
					Code: "range_out_of_bounds", Function: function, Location: e.Location,
					Message: fmt.Sprintf("constant range [%d:%d] exceeds array length %d", start, end, *base.Type.Length),
				})
				return
			}
			check.Status = "proven"
		}
	}
	report.Checks = append(report.Checks, check)
}
