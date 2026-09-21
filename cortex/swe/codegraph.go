package swe

import (
	"sync"
)

// CodeGraph maintains a persistent semantic graph of codebase architecture and dependency links.
type CodeGraph struct {
	mu            sync.RWMutex
	symbols       map[string]CodeSymbol
	outgoingEdges map[string][]DependencyEdge // source -> outgoing links
	incomingEdges map[string][]DependencyEdge // target -> callers/importers
	fileToSymbols map[string][]string         // file -> symbol IDs
}

// NewCodeGraph initializes an empty codebase dependency graph.
func NewCodeGraph() *CodeGraph {
	return &CodeGraph{
		symbols:       make(map[string]CodeSymbol),
		outgoingEdges: make(map[string][]DependencyEdge),
		incomingEdges: make(map[string][]DependencyEdge),
		fileToSymbols: make(map[string][]string),
	}
}

// AddSymbol registers a function, struct, interface, or module declaration.
func (cg *CodeGraph) AddSymbol(sym CodeSymbol) {
	cg.mu.Lock()
	defer cg.mu.Unlock()

	cg.symbols[sym.ID] = sym
	cg.fileToSymbols[sym.FilePath] = append(cg.fileToSymbols[sym.FilePath], sym.ID)
}

// AddEdge registers a dependency relationship between code declarations.
func (cg *CodeGraph) AddEdge(edge DependencyEdge) {
	cg.mu.Lock()
	defer cg.mu.Unlock()

	cg.outgoingEdges[edge.SourceSymbolID] = append(cg.outgoingEdges[edge.SourceSymbolID], edge)
	cg.incomingEdges[edge.TargetSymbolID] = append(cg.incomingEdges[edge.TargetSymbolID], edge)
}

// GetSymbol returns a symbol declaration if registered.
func (cg *CodeGraph) GetSymbol(id string) (CodeSymbol, bool) {
	cg.mu.RLock()
	defer cg.mu.RUnlock()

	sym, ok := cg.symbols[id]
	return sym, ok
}

// TraceBlastRadius performs a backward reachability search (BFS) to identify all components
// impacted if the given symbol is refactored or modified.
func (cg *CodeGraph) TraceBlastRadius(symbolID string) []string {
	cg.mu.RLock()
	defer cg.mu.RUnlock()

	visited := make(map[string]bool)
	queue := []string{symbolID}
	visited[symbolID] = true

	impacted := make([]string, 0)

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		// All incoming edges represent callers or importers dependent on curr
		for _, edge := range cg.incomingEdges[curr] {
			dependent := edge.SourceSymbolID
			if !visited[dependent] {
				visited[dependent] = true
				queue = append(queue, dependent)
				impacted = append(impacted, dependent)
			}
		}
	}

	return impacted
}

// GetImpactedFiles returns unique file paths affected by modifying a given symbol.
func (cg *CodeGraph) GetImpactedFiles(symbolID string) []string {
	blastRadius := cg.TraceBlastRadius(symbolID)
	fileSet := make(map[string]bool)

	cg.mu.RLock()
	defer cg.mu.RUnlock()

	if targetSym, exists := cg.symbols[symbolID]; exists {
		fileSet[targetSym.FilePath] = true
	}

	for _, id := range blastRadius {
		if sym, exists := cg.symbols[id]; exists {
			fileSet[sym.FilePath] = true
		}
	}

	files := make([]string, 0, len(fileSet))
	for f := range fileSet {
		files = append(files, f)
	}
	return files
}

// CalculateTotalComplexity computes the aggregate cyclomatic complexity of all registered symbols.
func (cg *CodeGraph) CalculateTotalComplexity() int {
	cg.mu.RLock()
	defer cg.mu.RUnlock()

	total := 0
	for _, s := range cg.symbols {
		total += s.ComplexityScore
	}
	return total
}
