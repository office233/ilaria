package sourcefront

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	GraphVersion                    = 1
	MaxModuleGraphNodes             = 256
	MaxModuleSourceBytes            = 1 << 20
	MaxModuleGraphSourceBytes int64 = int64(MaxModuleGraphNodes) * int64(MaxModuleSourceBytes)

	DefaultMaxModuleGraphNodes  = MaxModuleGraphNodes
	DefaultMaxModuleSourceBytes = MaxModuleSourceBytes
	DefaultMaxModuleGraphBytes  = 16 << 20
)

// Loader resolves one logical module name to exact source bytes. Resolver
// correctness never depends on network access or a particular storage backend.
type Loader interface {
	LoadModule(ctx context.Context, module string) ([]byte, error)
}

type Graph struct {
	Version int         `json:"version"`
	Root    string      `json:"root"`
	Nodes   []GraphNode `json:"nodes"`
}

type GraphNode struct {
	Module       string   `json:"module"`
	SourceSHA256 string   `json:"source_sha256"`
	Uses         []string `json:"uses,omitempty"`
}

type ResolvedModule struct {
	Name         string
	Source       []byte
	Uses         []string
	SourceSHA256 string
}

// ModuleGraphLimits is a per-call resource policy. The hard Max* constants are
// compatibility/safety ceilings; callers may tighten them for a particular
// resolution without changing global state.
type ModuleGraphLimits struct {
	MaxNodes             int
	MaxModuleSourceBytes int
	MaxTotalSourceBytes  int64
}

// DefaultModuleGraphLimits returns the machine-independent default policy.
func DefaultModuleGraphLimits() ModuleGraphLimits {
	return ModuleGraphLimits{
		MaxNodes:             DefaultMaxModuleGraphNodes,
		MaxModuleSourceBytes: DefaultMaxModuleSourceBytes,
		MaxTotalSourceBytes:  DefaultMaxModuleGraphBytes,
	}
}

// ValidateModuleGraphLimits rejects unusable or unsafe per-call policies.
func ValidateModuleGraphLimits(limits ModuleGraphLimits) error {
	if limits.MaxNodes < 1 || limits.MaxNodes > MaxModuleGraphNodes {
		return fmt.Errorf("module graph max nodes must be 1..%d", MaxModuleGraphNodes)
	}
	if limits.MaxModuleSourceBytes < 1 || limits.MaxModuleSourceBytes > MaxModuleSourceBytes {
		return fmt.Errorf("module source byte limit must be 1..%d", MaxModuleSourceBytes)
	}
	if limits.MaxTotalSourceBytes < 1 || limits.MaxTotalSourceBytes > MaxModuleGraphSourceBytes {
		return fmt.Errorf("module graph total source byte limit must be 1..%d", MaxModuleGraphSourceBytes)
	}
	return nil
}

type moduleGraphBudget struct {
	limits      ModuleGraphLimits
	nodes       int
	sourceBytes int64
}

func (b *moduleGraphBudget) admit(module string, source []byte) error {
	if len(source) == 0 || len(source) > b.limits.MaxModuleSourceBytes {
		return fmt.Errorf("module %s source size must be 1..%d bytes", module, b.limits.MaxModuleSourceBytes)
	}
	if b.nodes >= b.limits.MaxNodes {
		return fmt.Errorf("module graph exceeds %d nodes", b.limits.MaxNodes)
	}
	size := int64(len(source))
	if size > b.limits.MaxTotalSourceBytes-b.sourceBytes {
		return fmt.Errorf("module graph source bytes exceed %d", b.limits.MaxTotalSourceBytes)
	}
	b.nodes++
	b.sourceBytes += size
	return nil
}

func sourceSHA256(source []byte) string {
	sum := sha256.Sum256(source)
	return hex.EncodeToString(sum[:])
}

// ResolveGraph resolves the root's logical dependency graph without linking or
// executing code. Every loaded dependency must declare exactly the logical
// module name requested by its importer. Cycles fail closed for the initial M1
// module model so later linking never depends on initialization order.
func ResolveGraph(ctx context.Context, filename string, rootSource []byte, loader Loader) (Graph, error) {
	return ResolveGraphWithLimits(ctx, filename, rootSource, loader, DefaultModuleGraphLimits())
}

// ResolveGraphWithLimits resolves a graph under explicit per-call resource
// limits. Only preamble metadata and source digests are retained; complete
// dependency source buffers are released after each module is inspected.
func ResolveGraphWithLimits(ctx context.Context, filename string, rootSource []byte, loader Loader, limits ModuleGraphLimits) (Graph, error) {
	if ctx == nil {
		return Graph{}, fmt.Errorf("module graph requires a non-nil context")
	}
	if err := ValidateModuleGraphLimits(limits); err != nil {
		return Graph{}, err
	}
	if loader == nil {
		return Graph{}, fmt.Errorf("module graph requires a loader")
	}
	if err := ctx.Err(); err != nil {
		return Graph{}, err
	}
	if len(rootSource) == 0 || len(rootSource) > limits.MaxModuleSourceBytes {
		return Graph{}, fmt.Errorf("root module source size must be 1..%d bytes", limits.MaxModuleSourceBytes)
	}
	if int64(len(rootSource)) > limits.MaxTotalSourceBytes {
		return Graph{}, fmt.Errorf("module graph source bytes exceed %d", limits.MaxTotalSourceBytes)
	}
	rootPreamble, _, err := ParsePreamble(filename, string(rootSource))
	if err != nil {
		return Graph{}, err
	}
	if err := ctx.Err(); err != nil {
		return Graph{}, err
	}
	if rootPreamble.Module == "" {
		return Graph{}, fmt.Errorf("root source must declare module name")
	}

	type loadedModule struct {
		preamble Preamble
		hash     string
	}
	loaded := map[string]loadedModule{
		rootPreamble.Module: {preamble: rootPreamble, hash: sourceSHA256(rootSource)},
	}
	budget := moduleGraphBudget{limits: limits, nodes: 1, sourceBytes: int64(len(rootSource))}
	state := map[string]uint8{}
	stack := make([]string, 0, 16)

	load := func(module string) (loadedModule, error) {
		if m, ok := loaded[module]; ok {
			return m, nil
		}
		if budget.nodes >= limits.MaxNodes {
			return loadedModule{}, fmt.Errorf("module graph exceeds %d nodes", limits.MaxNodes)
		}
		if err := ctx.Err(); err != nil {
			return loadedModule{}, err
		}
		source, err := loader.LoadModule(ctx, module)
		if contextErr := ctx.Err(); contextErr != nil {
			return loadedModule{}, contextErr
		}
		if err != nil {
			return loadedModule{}, fmt.Errorf("load module %s: %w", module, err)
		}
		// Admission precedes any conversion/copy used by preamble parsing. Shared
		// dependencies reach the loaded-map fast path above and count only once.
		if err := budget.admit(module, source); err != nil {
			return loadedModule{}, err
		}
		hash := sourceSHA256(source)
		preamble, _, err := ParsePreamble(module+".swyp", string(source))
		if err != nil {
			return loadedModule{}, fmt.Errorf("module %s preamble: %w", module, err)
		}
		if err := ctx.Err(); err != nil {
			return loadedModule{}, err
		}
		if preamble.Module == "" {
			return loadedModule{}, fmt.Errorf("module %s source does not declare a module name", module)
		}
		if preamble.Module != module {
			return loadedModule{}, fmt.Errorf("module %s source declares %s", module, preamble.Module)
		}
		m := loadedModule{preamble: preamble, hash: hash}
		loaded[module] = m
		return m, nil
	}

	var visit func(string) error
	visit = func(module string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		switch state[module] {
		case 2:
			return nil
		case 1:
			start := 0
			for i, name := range stack {
				if name == module {
					start = i
					break
				}
			}
			cycle := append(append([]string(nil), stack[start:]...), module)
			return fmt.Errorf("module dependency cycle: %s", strings.Join(cycle, " -> "))
		}
		m, err := load(module)
		if err != nil {
			return err
		}
		state[module] = 1
		stack = append(stack, module)
		for _, dependency := range m.preamble.Uses {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		state[module] = 2
		return nil
	}

	if err := visit(rootPreamble.Module); err != nil {
		return Graph{}, err
	}
	names := make([]string, 0, len(loaded))
	for name := range loaded {
		names = append(names, name)
	}
	sort.Strings(names)
	graph := Graph{Version: GraphVersion, Root: rootPreamble.Module, Nodes: make([]GraphNode, 0, len(names))}
	for _, name := range names {
		m := loaded[name]
		graph.Nodes = append(graph.Nodes, GraphNode{
			Module:       name,
			SourceSHA256: m.hash,
			Uses:         append([]string(nil), m.preamble.Uses...),
		})
	}
	return graph, nil
}

// ResolveModules returns the exact source bytes corresponding to a validated
// graph. Dependencies are read back through the loader and their hashes are
// compared with the graph snapshot, so concurrent source changes fail closed
// rather than silently linking a different graph than the one validated.
func ResolveModules(ctx context.Context, filename string, rootSource []byte, loader Loader) (Graph, []ResolvedModule, error) {
	return ResolveModulesWithLimits(ctx, filename, rootSource, loader, DefaultModuleGraphLimits())
}

// ResolveModulesWithLimits returns owned source bytes for a graph validated
// under limits. Dependencies are deliberately reloaded and hashed so source
// changes between graph discovery and linking fail closed.
func ResolveModulesWithLimits(ctx context.Context, filename string, rootSource []byte, loader Loader, limits ModuleGraphLimits) (Graph, []ResolvedModule, error) {
	graph, err := ResolveGraphWithLimits(ctx, filename, rootSource, loader, limits)
	if err != nil {
		return Graph{}, nil, err
	}
	resolved := make([]ResolvedModule, 0, len(graph.Nodes))
	var totalSourceBytes int64
	for _, node := range graph.Nodes {
		if err := ctx.Err(); err != nil {
			return Graph{}, nil, err
		}
		var source []byte
		if node.Module == graph.Root {
			source = rootSource
		} else {
			source, err = loader.LoadModule(ctx, node.Module)
			if contextErr := ctx.Err(); contextErr != nil {
				return Graph{}, nil, contextErr
			}
			if err != nil {
				return Graph{}, nil, fmt.Errorf("reload module %s: %w", node.Module, err)
			}
		}
		if len(source) == 0 || len(source) > limits.MaxModuleSourceBytes {
			return Graph{}, nil, fmt.Errorf("module %s source size must be 1..%d bytes", node.Module, limits.MaxModuleSourceBytes)
		}
		size := int64(len(source))
		if size > limits.MaxTotalSourceBytes-totalSourceBytes {
			return Graph{}, nil, fmt.Errorf("module graph source bytes exceed %d during reload", limits.MaxTotalSourceBytes)
		}
		totalSourceBytes += size
		hash := sourceSHA256(source)
		if hash != node.SourceSHA256 {
			return Graph{}, nil, fmt.Errorf("module %s changed during graph resolution", node.Module)
		}
		resolved = append(resolved, ResolvedModule{
			Name:         node.Module,
			Source:       append([]byte(nil), source...),
			Uses:         append([]string(nil), node.Uses...),
			SourceSHA256: hash,
		})
	}
	return graph, resolved, nil
}

// FSLoader maps a logical module a.b to <Root>/a/b.swyp. Root is explicit and
// every resolved file is checked after symlink evaluation to prevent escaping
// the authorized module tree.
type FSLoader struct {
	Root string
}

func (l FSLoader) LoadModule(ctx context.Context, module string) ([]byte, error) {
	if ctx == nil {
		return nil, fmt.Errorf("module loader requires a non-nil context")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parts, ok := splitModule(module)
	if !ok {
		return nil, fmt.Errorf("invalid logical module name %q", module)
	}
	if strings.TrimSpace(l.Root) == "" {
		return nil, fmt.Errorf("module root is empty")
	}
	rootAbs, err := filepath.Abs(l.Root)
	if err != nil {
		return nil, err
	}
	rootReal, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return nil, fmt.Errorf("resolve module root: %w", err)
	}
	pathParts := append([]string{rootReal}, parts...)
	target := filepath.Join(pathParts...) + ".swyp"
	targetReal, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(rootReal, targetReal)
	if err != nil {
		return nil, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil, fmt.Errorf("module %s resolves outside module root", module)
	}
	info, err := os.Stat(targetReal)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("module %s is not a regular file", module)
	}
	if info.Size() <= 0 || info.Size() > MaxModuleSourceBytes {
		return nil, fmt.Errorf("module %s source size must be 1..%d bytes", module, MaxModuleSourceBytes)
	}
	f, err := os.Open(targetReal)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// The file may grow after Stat. Bound the actual read as well as the
	// preflight size check so a changing dependency cannot exhaust memory.
	source, err := io.ReadAll(io.LimitReader(f, MaxModuleSourceBytes+1))
	if err != nil {
		return nil, err
	}
	if len(source) == 0 || len(source) > MaxModuleSourceBytes {
		return nil, fmt.Errorf("module %s source size must be 1..%d bytes", module, MaxModuleSourceBytes)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return source, nil
}

func splitModule(module string) ([]string, bool) {
	parts := strings.Split(module, ".")
	if len(parts) == 0 {
		return nil, false
	}
	for _, part := range parts {
		if !identifier(part) {
			return nil, false
		}
	}
	return parts, true
}
