package swyplang

import (
	"fmt"
	"text/scanner"
)

// DiagnosticSchemaVersion versions the stable source-frontend diagnostic
// contract exposed by the compiler and language manifest.
const DiagnosticSchemaVersion = 1

const (
	DiagnosticArityMismatch      = "arity_mismatch"
	DiagnosticCannotInferType    = "cannot_infer_type"
	DiagnosticCorePipelineNeeded = "core_pipeline_required"
	DiagnosticDuplicateFunction  = "duplicate_function"
	DiagnosticDuplicateParameter = "duplicate_parameter"
	DiagnosticDuplicateVariable  = "duplicate_variable"
	DiagnosticExpectedIdentifier = "expected_identifier"
	DiagnosticInvalidLiteral     = "invalid_literal"
	DiagnosticInvalidMain        = "invalid_main_signature"
	DiagnosticInvalidType        = "invalid_type"
	DiagnosticLexicalError       = "lexical_error"
	DiagnosticMissingMain        = "missing_main"
	DiagnosticMissingReturn      = "missing_return"
	DiagnosticModulePreamble     = "module_preamble_error"
	DiagnosticParseError         = "parse_error"
	DiagnosticReservedIdentifier = "reserved_identifier"
	DiagnosticSourceTooLarge     = "source_too_large"
	DiagnosticSyntaxNestingLimit = "syntax_nesting_limit"
	DiagnosticTypeMismatch       = "type_mismatch"
	DiagnosticUnexpectedToken    = "unexpected_token"
	DiagnosticUnknownFunction    = "unknown_function"
	DiagnosticUnknownVariable    = "unknown_variable"
)

var canonicalDiagnosticCodes = []string{
	DiagnosticArityMismatch,
	DiagnosticCannotInferType,
	DiagnosticCorePipelineNeeded,
	DiagnosticDuplicateFunction,
	DiagnosticDuplicateParameter,
	DiagnosticDuplicateVariable,
	DiagnosticExpectedIdentifier,
	DiagnosticInvalidLiteral,
	DiagnosticInvalidMain,
	DiagnosticInvalidType,
	DiagnosticLexicalError,
	DiagnosticMissingMain,
	DiagnosticMissingReturn,
	DiagnosticModulePreamble,
	DiagnosticParseError,
	DiagnosticReservedIdentifier,
	DiagnosticSourceTooLarge,
	DiagnosticSyntaxNestingLimit,
	DiagnosticTypeMismatch,
	DiagnosticUnexpectedToken,
	DiagnosticUnknownFunction,
	DiagnosticUnknownVariable,
}

// DiagnosticLocation is source-oriented and deliberately independent of Core
// IR so parser/checker consumers can depend on the frontend contract alone.
type DiagnosticLocation struct {
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

// Diagnostic is the stable parser/checker error surface. Error() intentionally
// preserves the historical human-readable format so existing CLI consumers do
// not need to parse the code out of the text.
type Diagnostic struct {
	Code     string             `json:"code"`
	Message  string             `json:"message"`
	Location DiagnosticLocation `json:"location"`
	prefix   string
}

func (d *Diagnostic) Error() string {
	if d == nil {
		return ""
	}
	if d.prefix != "" {
		return d.prefix + ": " + d.Message
	}
	return d.Message
}

// CanonicalDiagnosticCodes returns a detached deterministic copy suitable for
// manifests, generators and compatibility tests.
func CanonicalDiagnosticCodes() []string {
	return append([]string(nil), canonicalDiagnosticCodes...)
}

func diagnosticAt(code string, pos scanner.Position, format string, args ...any) *Diagnostic {
	return &Diagnostic{
		Code:    code,
		Message: fmt.Sprintf(format, args...),
		Location: DiagnosticLocation{
			File:   pos.Filename,
			Line:   pos.Line,
			Column: pos.Column,
			Offset: pos.Offset,
		},
		prefix: pos.String(),
	}
}

func diagnosticForFile(code, filename, format string, args ...any) *Diagnostic {
	return &Diagnostic{
		Code:     code,
		Message:  fmt.Sprintf(format, args...),
		Location: DiagnosticLocation{File: filename},
		prefix:   filename,
	}
}

func diagnosticMessage(code, format string, args ...any) *Diagnostic {
	return &Diagnostic{Code: code, Message: fmt.Sprintf(format, args...)}
}
