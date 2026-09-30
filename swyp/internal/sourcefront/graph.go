package sourcefront

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	GraphVersion         = 1
	MaxModuleGraphNodes  = 256
	MaxModuleSourceBytes = 1 << 20
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

// ResolveGraph resolves the root's logical dependency graph without linking or
// executing code. Every loaded dependency must declare exactly the logical
// module name requested by its importer. Cycles fail closed for the initial M1
// module model so later linking never depends on initialization order.
func ResolveGraph(ctx context.Context, filename string, rootSource []byte, loader Loader) (Graph, error) {
	if loader == nil {
		return Graph{}, fmt.Errorf("module graph requires a loader")
	}
	if len(rootSource) == 0 || len(rootSource) > MaxModuleSourceBytes {
		return Graph{}, fmt.Errorf("root module source size must be 1..%d bytes", MaxModuleSourceBytes)
	}
	rootPreamble, _, err := ParsePreamble(filename, string(rootSource))
	if err != nil {
		return Graph{}, err
	}
	if rootPreamble.Module == "" {
		return Graph{}, fmt.Errorf("root source must declare module name")
	}

	type loadedModule struct {
		source   []byte
		preamble Preamble
	}
	loaded := map[string]loadedModule{
		rootPreamble.Module: {source: append([]byte(nil), rootSource...), preamble: rootPreamble},
	}
	state := map[string]uint8{}
	stack := make([]string, 0, 16)

	load := func(module string) (loadedModule, error) {
		if m, ok := loaded[module]; ok {
			return m, nil
		}
		if len(loaded) >= MaxModuleGraphNodes {
			return loadedModule{}, fmt.Errorf("module graph exceeds %d nodes", MaxModuleGraphNodes)
		}
		if err := ctx.Err(); err != nil {
			return loadedModule{}, err
		}
		source, err := loader.LoadModule(ctx, module)
		if err != nil {
			return loadedModule{}, fmt.Errorf("load module %s: %w", module, err)
		}
		if len(source) == 0 || len(source) > MaxModuleSourceBytes {
			return loadedModule{}, fmt.Errorf("module %s source size must be 1..%d bytes", module, MaxModuleSourceBytes)
		}
		preamble, _, err := ParsePreamble(module+".swyp", string(source))
		if err != nil {
			return loadedModule{}, fmt.Errorf("module %s preamble: %w", module, err)
		}
		if preamble.Module == "" {
			return loadedModule{}, fmt.Errorf("module %s source does not declare a module name", module)
		}
		if preamble.Module != module {
			return loadedModule{}, fmt.Errorf("module %s source declares %s", module, preamble.Module)
		}
		m := loadedModule{source: append([]byte(nil), source...), preamble: preamble}
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
		sum := sha256.Sum256(m.source)
		graph.Nodes = append(graph.Nodes, GraphNode{
			Module:       name,
			SourceSHA256: hex.EncodeToString(sum[:]),
			Uses:         append([]string(nil), m.preamble.Uses...),
		})
	}
	return graph, nil
}

// FSLoader maps a logical module a.b to <Root>/a/b.swyp. Root is explicit and
// every resolved file is checked after symlink evaluation to prevent escaping
// the authorized module tree.
type FSLoader struct {
	Root string
}

func (l FSLoader) LoadModule(ctx context.Context, module string) ([]byte, error) {
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
	return os.ReadFile(targetReal)
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
