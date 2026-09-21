package swe

// SymbolKind categorizes code declarations.
type SymbolKind string

const (
	KindPackage   SymbolKind = "PACKAGE"
	KindFunction  SymbolKind = "FUNCTION"
	KindMethod    SymbolKind = "METHOD"
	KindStruct    SymbolKind = "STRUCT"
	KindInterface SymbolKind = "INTERFACE"
	KindType      SymbolKind = "TYPE"
	KindVariable  SymbolKind = "VARIABLE"
)

// CodeSymbol represents a declaration in the software architecture.
type CodeSymbol struct {
	ID              string     `json:"id"` // e.g. "cortex/biomed.Bridge"
	Name            string     `json:"name"`
	Kind            SymbolKind `json:"kind"`
	FilePath        string     `json:"file_path"`
	StartLine       int        `json:"start_line"`
	EndLine         int        `json:"end_line"`
	Signature       string     `json:"signature"`
	ComplexityScore int        `json:"complexity_score"` // Cyclomatic complexity
}

// DepRelation classifies relationships between code elements.
type DepRelation string

const (
	RelCalls        DepRelation = "CALLS"
	RelImports      DepRelation = "IMPORTS"
	RelImplements   DepRelation = "IMPLEMENTS"
	RelReferences   DepRelation = "REFERENCES"
	RelInstantiates DepRelation = "INSTANTIATES"
)

// DependencyEdge models a directed link in the software dependency graph.
type DependencyEdge struct {
	SourceSymbolID string      `json:"source_symbol_id"`
	TargetSymbolID string      `json:"target_symbol_id"`
	Relation       DepRelation `json:"relation"`
}

// DiagnosticKind categorizes compiler, vet, or test diagnostics produced by
// the real Go toolchain (see sandbox_executor.go).
type DiagnosticKind string

const (
	DiagSyntaxError     DiagnosticKind = "SYNTAX_ERROR"
	DiagTypeMismatch    DiagnosticKind = "TYPE_MISMATCH"
	DiagUndefinedSymbol DiagnosticKind = "UNDEFINED_SYMBOL"
	DiagVet             DiagnosticKind = "VET"
	DiagTestFailure     DiagnosticKind = "TEST_FAILURE"
)

// DiagnosticError is one structured line from the toolchain output.
type DiagnosticError struct {
	Kind     DiagnosticKind `json:"kind"`
	FilePath string         `json:"file_path"`
	Line     int            `json:"line"`
	Column   int            `json:"column"`
	Message  string         `json:"message"`
}

// ExecutionResult captures the outcome of vetting, compiling and testing code
// inside a throwaway Go module.
type ExecutionResult struct {
	Success         bool              `json:"success"`
	TimedOut        bool              `json:"timed_out"`
	ExitCode        int               `json:"exit_code"`
	Stdout          string            `json:"stdout"`
	Stderr          string            `json:"stderr"`
	Diagnostics     []DiagnosticError `json:"diagnostics"`
	TestsTotal      int               `json:"tests_total"`
	TestsPassed     int               `json:"tests_passed"`
	TestsFailed     int               `json:"tests_failed"`
	FailedTestNames []string          `json:"failed_test_names"`
	ExecutionTimeMs int64             `json:"execution_time_ms"`
}
