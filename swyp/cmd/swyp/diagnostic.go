package main

import (
	"errors"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

// compilerDiagnostic normalizes all structured compiler errors onto the JSON
// diagnostic envelope used by model-facing and Core commands. Source diagnostic
// messages retain their historical text while exposing a stable code/location.
func compilerDiagnostic(err error) *coreir.Diagnostic {
	var core *coreir.Diagnostic
	if errors.As(err, &core) {
		return core
	}
	var source *swyplang.Diagnostic
	if errors.As(err, &source) {
		return &coreir.Diagnostic{
			Code:    source.Code,
			Message: source.Error(),
			Location: coreir.Location{
				File:   source.Location.File,
				Line:   source.Location.Line,
				Column: source.Location.Column,
			},
		}
	}
	return &coreir.Diagnostic{Code: "invalid_input", Message: err.Error()}
}
