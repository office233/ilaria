package sourcefront

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

type benchmarkGraphLoader map[string][]byte

func (l benchmarkGraphLoader) LoadModule(_ context.Context, module string) ([]byte, error) {
	source, ok := l[module]
	if !ok {
		return nil, fmt.Errorf("module %s not found", module)
	}
	return source, nil
}

func benchmarkGraphFixture(moduleCount, moduleBytes int) ([]byte, benchmarkGraphLoader) {
	loader := make(benchmarkGraphLoader, moduleCount)
	var root strings.Builder
	root.WriteString("module bench.root;\n")
	for i := 0; i < moduleCount; i++ {
		name := fmt.Sprintf("bench.m%03d", i)
		fmt.Fprintf(&root, "use %s;\n", name)
		prefix := []byte("module " + name + ";\n")
		source := make([]byte, moduleBytes)
		copy(source, prefix)
		for j := len(prefix); j < len(source); j++ {
			source[j] = ' '
		}
		loader[name] = source
	}
	root.WriteString("fn main() {}\n")
	return []byte(root.String()), loader
}

func BenchmarkModuleGraphSyntheticResolveGraph(b *testing.B) {
	root, loader := benchmarkGraphFixture(48, 8<<10)
	ctx := context.Background()
	b.ReportAllocs()
	b.SetBytes(int64(len(root) + 48*(8<<10)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		graph, err := ResolveGraph(ctx, "root.swyp", root, loader)
		if err != nil {
			b.Fatal(err)
		}
		if len(graph.Nodes) != 49 {
			b.Fatalf("nodes=%d", len(graph.Nodes))
		}
	}
}

func BenchmarkModuleGraphSyntheticResolveModules(b *testing.B) {
	root, loader := benchmarkGraphFixture(48, 8<<10)
	ctx := context.Background()
	b.ReportAllocs()
	b.SetBytes(int64(len(root) + 48*(8<<10)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		graph, modules, err := ResolveModules(ctx, "root.swyp", root, loader)
		if err != nil {
			b.Fatal(err)
		}
		if len(graph.Nodes) != 49 || len(modules) != 49 {
			b.Fatalf("nodes=%d modules=%d", len(graph.Nodes), len(modules))
		}
	}
}
