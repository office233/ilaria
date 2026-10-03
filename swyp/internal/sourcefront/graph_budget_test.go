package sourcefront

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func sizedModuleSource(t *testing.T, name string, uses []string, size int) []byte {
	t.Helper()
	var prefix strings.Builder
	fmt.Fprintf(&prefix, "module %s;\n", name)
	for _, use := range uses {
		fmt.Fprintf(&prefix, "use %s;\n", use)
	}
	prefix.WriteString("fn value() {}\n")
	if prefix.Len() > size {
		t.Fatalf("module %s preamble/body is %d bytes, exceeds requested fixture size %d", name, prefix.Len(), size)
	}
	source := make([]byte, size)
	copy(source, prefix.String())
	for i := prefix.Len(); i < len(source); i++ {
		source[i] = ' '
	}
	return source
}

type countingBytesLoader struct {
	sources map[string][]byte
	calls   map[string]int
}

func (l *countingBytesLoader) LoadModule(_ context.Context, module string) ([]byte, error) {
	l.calls[module]++
	source, ok := l.sources[module]
	if !ok {
		return nil, fmt.Errorf("missing %s", module)
	}
	return source, nil
}

func TestResolveGraphWithLimitsExactAggregateAndSharedDependency(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.a", "lib.b"}, 160)
	a := sizedModuleSource(t, "lib.a", []string{"lib.shared"}, 128)
	b := sizedModuleSource(t, "lib.b", []string{"lib.shared"}, 128)
	shared := sizedModuleSource(t, "lib.shared", nil, 96)
	total := int64(len(root) + len(a) + len(b) + len(shared))
	loader := &countingBytesLoader{
		sources: map[string][]byte{"lib.a": a, "lib.b": b, "lib.shared": shared},
		calls:   map[string]int{},
	}
	limits := ModuleGraphLimits{MaxNodes: 4, MaxModuleSourceBytes: 256, MaxTotalSourceBytes: total}

	graph, err := ResolveGraphWithLimits(context.Background(), "root.swyp", root, loader, limits)
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Nodes) != 4 || loader.calls["lib.shared"] != 1 {
		t.Fatalf("nodes=%d shared calls=%d graph=%+v", len(graph.Nodes), loader.calls["lib.shared"], graph)
	}
	if got := []string{graph.Nodes[0].Module, graph.Nodes[1].Module, graph.Nodes[2].Module, graph.Nodes[3].Module}; !reflect.DeepEqual(got, []string{"app.root", "lib.a", "lib.b", "lib.shared"}) {
		t.Fatalf("node order=%v", got)
	}

	over := append([]byte(nil), a...)
	over = append(over, ' ')
	loader = &countingBytesLoader{
		sources: map[string][]byte{"lib.a": over, "lib.b": b, "lib.shared": shared},
		calls:   map[string]int{},
	}
	graph, err = ResolveGraphWithLimits(context.Background(), "root.swyp", root, loader, limits)
	if err == nil || !strings.Contains(err.Error(), "source bytes exceed") || !reflect.DeepEqual(graph, Graph{}) {
		t.Fatalf("+1 aggregate byte: graph=%+v err=%v", graph, err)
	}
}

func TestResolveGraphBudgetAdmissionPrecedesPreambleCopy(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.bad"}, 80)
	// Invalid preamble on purpose. Aggregate admission must reject the +1 byte
	// before ParsePreamble converts/parses this buffer.
	bad := bytes.Repeat([]byte{'x'}, 65)
	limits := ModuleGraphLimits{MaxNodes: 2, MaxModuleSourceBytes: 128, MaxTotalSourceBytes: int64(len(root) + 64)}
	loader := &countingBytesLoader{sources: map[string][]byte{"lib.bad": bad}, calls: map[string]int{}}

	_, err := ResolveGraphWithLimits(context.Background(), "root.swyp", root, loader, limits)
	if err == nil || !strings.Contains(err.Error(), "source bytes exceed") || strings.Contains(err.Error(), "preamble") {
		t.Fatalf("budget admission order err=%v", err)
	}
}

func TestResolveGraphWithLimitsExactPerModuleAndPlusOne(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.a"}, 72)
	dependency := sizedModuleSource(t, "lib.a", nil, 96)
	limits := ModuleGraphLimits{
		MaxNodes:             2,
		MaxModuleSourceBytes: len(dependency),
		MaxTotalSourceBytes:  int64(len(root) + len(dependency) + 1),
	}
	loader := &countingBytesLoader{sources: map[string][]byte{"lib.a": dependency}, calls: map[string]int{}}
	if _, err := ResolveGraphWithLimits(context.Background(), "root.swyp", root, loader, limits); err != nil {
		t.Fatalf("exact per-module limit rejected: %v", err)
	}

	loader.sources["lib.a"] = append(append([]byte(nil), dependency...), ' ')
	if _, err := ResolveGraphWithLimits(context.Background(), "root.swyp", root, loader, limits); err == nil || !strings.Contains(err.Error(), "source size") {
		t.Fatalf("+1 per-module byte err=%v", err)
	}
}

func TestModuleGraphLimitsValidationAndNilContext(t *testing.T) {
	valid := DefaultModuleGraphLimits()
	for name, mutate := range map[string]func(*ModuleGraphLimits){
		"zero nodes":        func(l *ModuleGraphLimits) { l.MaxNodes = 0 },
		"too many nodes":    func(l *ModuleGraphLimits) { l.MaxNodes = MaxModuleGraphNodes + 1 },
		"zero module bytes": func(l *ModuleGraphLimits) { l.MaxModuleSourceBytes = 0 },
		"module too large":  func(l *ModuleGraphLimits) { l.MaxModuleSourceBytes = MaxModuleSourceBytes + 1 },
		"zero total":        func(l *ModuleGraphLimits) { l.MaxTotalSourceBytes = 0 },
		"total too large":   func(l *ModuleGraphLimits) { l.MaxTotalSourceBytes = MaxModuleGraphSourceBytes + 1 },
	} {
		t.Run(name, func(t *testing.T) {
			limits := valid
			mutate(&limits)
			if err := ValidateModuleGraphLimits(limits); err == nil {
				t.Fatalf("accepted limits %+v", limits)
			}
		})
	}

	root := []byte("module app.root; fn main() {}")
	loader := &countingBytesLoader{sources: map[string][]byte{}, calls: map[string]int{}}
	if graph, err := ResolveGraphWithLimits(nil, "root.swyp", root, loader, valid); err == nil || !strings.Contains(err.Error(), "non-nil context") || !reflect.DeepEqual(graph, Graph{}) {
		t.Fatalf("nil graph context: graph=%+v err=%v", graph, err)
	}
	if graph, modules, err := ResolveModulesWithLimits(nil, "root.swyp", root, loader, valid); err == nil || !strings.Contains(err.Error(), "non-nil context") || !reflect.DeepEqual(graph, Graph{}) || modules != nil {
		t.Fatalf("nil module context: graph=%+v modules=%v err=%v", graph, modules, err)
	}
	if _, err := (FSLoader{}).LoadModule(nil, "lib.a"); err == nil || !strings.Contains(err.Error(), "non-nil context") {
		t.Fatalf("nil FSLoader context err=%v", err)
	}
}

type cancelOnLoadLoader struct {
	cancel context.CancelFunc
	source []byte
}

func (l cancelOnLoadLoader) LoadModule(_ context.Context, _ string) ([]byte, error) {
	l.cancel()
	return l.source, nil
}

func TestResolveGraphChecksCancellationImmediatelyAfterLoader(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.a"}, 80)
	ctx, cancel := context.WithCancel(context.Background())
	loader := cancelOnLoadLoader{cancel: cancel, source: sizedModuleSource(t, "lib.a", nil, 80)}
	graph, err := ResolveGraphWithLimits(ctx, "root.swyp", root, loader, DefaultModuleGraphLimits())
	if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(graph, Graph{}) {
		t.Fatalf("graph=%+v err=%v", graph, err)
	}
}

type cancelOnReloadLoader struct {
	cancel context.CancelFunc
	source []byte
	calls  int
}

func (l *cancelOnReloadLoader) LoadModule(_ context.Context, _ string) ([]byte, error) {
	l.calls++
	if l.calls == 2 {
		l.cancel()
	}
	return l.source, nil
}

func TestResolveModulesChecksCancellationImmediatelyAfterReload(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.a"}, 80)
	ctx, cancel := context.WithCancel(context.Background())
	loader := &cancelOnReloadLoader{cancel: cancel, source: sizedModuleSource(t, "lib.a", nil, 80)}
	graph, modules, err := ResolveModulesWithLimits(ctx, "root.swyp", root, loader, DefaultModuleGraphLimits())
	if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(graph, Graph{}) || modules != nil || loader.calls != 2 {
		t.Fatalf("graph=%+v modules=%v calls=%d err=%v", graph, modules, loader.calls, err)
	}
}

type changingLoader struct {
	first, second []byte
	calls         int
}

func (l *changingLoader) LoadModule(_ context.Context, _ string) ([]byte, error) {
	l.calls++
	if l.calls == 1 {
		return l.first, nil
	}
	return l.second, nil
}

func TestResolveModulesRejectsDependencyChangeWithoutPartialOutput(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.a"}, 80)
	first := sizedModuleSource(t, "lib.a", nil, 96)
	second := append([]byte(nil), first...)
	second[len(second)-1] = '\n'
	loader := &changingLoader{first: first, second: second}

	graph, modules, err := ResolveModulesWithLimits(context.Background(), "root.swyp", root, loader, DefaultModuleGraphLimits())
	if err == nil || !strings.Contains(err.Error(), "changed during graph resolution") || !reflect.DeepEqual(graph, Graph{}) || modules != nil {
		t.Fatalf("graph=%+v modules=%v err=%v", graph, modules, err)
	}
}

type reusedBufferLoader struct {
	buf     []byte
	sources map[string][]byte
}

func (l *reusedBufferLoader) LoadModule(_ context.Context, module string) ([]byte, error) {
	source, ok := l.sources[module]
	if !ok {
		return nil, fmt.Errorf("missing %s", module)
	}
	if cap(l.buf) < len(source) {
		l.buf = make([]byte, len(source))
	}
	l.buf = l.buf[:len(source)]
	copy(l.buf, source)
	return l.buf, nil
}

func TestResolveModulesOwnsSourcesWithReusedLoaderBuffer(t *testing.T) {
	root := sizedModuleSource(t, "app.root", []string{"lib.a", "lib.b"}, 112)
	originalRoot := append([]byte(nil), root...)
	a := sizedModuleSource(t, "lib.a", nil, 128)
	b := sizedModuleSource(t, "lib.b", nil, 128)
	originalA, originalB := append([]byte(nil), a...), append([]byte(nil), b...)
	loader := &reusedBufferLoader{
		buf:     make([]byte, 0, 256),
		sources: map[string][]byte{"lib.a": a, "lib.b": b},
	}

	graph, modules, err := ResolveModulesWithLimits(context.Background(), "root.swyp", root, loader, DefaultModuleGraphLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Nodes) != 3 || len(modules) != 3 {
		t.Fatalf("graph=%+v modules=%+v", graph, modules)
	}

	wantSources := map[string][]byte{"app.root": originalRoot, "lib.a": originalA, "lib.b": originalB}
	for _, node := range graph.Nodes {
		sum := sha256.Sum256(wantSources[node.Module])
		if node.SourceSHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("%s hash=%s", node.Module, node.SourceSHA256)
		}
	}
	for _, module := range modules {
		if !bytes.Equal(module.Source, wantSources[module.Name]) {
			t.Fatalf("%s source mutated before return", module.Name)
		}
	}

	for i := range root {
		root[i] = 'R'
	}
	for i := range loader.buf {
		loader.buf[i] = 'L'
	}
	for _, module := range modules {
		if !bytes.Equal(module.Source, wantSources[module.Name]) {
			t.Fatalf("%s result aliases caller/loader storage", module.Name)
		}
	}
}

func TestResolveGraphWithLimitsCycleMismatchAndCompatibility(t *testing.T) {
	root := []byte("module app.main; use lib.a; fn main() {}")
	limits := DefaultModuleGraphLimits()

	if graph, err := ResolveGraphWithLimits(context.Background(), "main.swyp", root, mapLoader{
		"lib.a": "module lib.a; use app.main; fn a() {}",
	}, limits); err == nil || !strings.Contains(err.Error(), "cycle") || !reflect.DeepEqual(graph, Graph{}) {
		t.Fatalf("cycle graph=%+v err=%v", graph, err)
	}
	if graph, err := ResolveGraphWithLimits(context.Background(), "main.swyp", root, mapLoader{
		"lib.a": "module wrong.name; fn a() {}",
	}, limits); err == nil || !strings.Contains(err.Error(), "declares wrong.name") || !reflect.DeepEqual(graph, Graph{}) {
		t.Fatalf("mismatch graph=%+v err=%v", graph, err)
	}

	loader := mapLoader{"lib.a": "module lib.a; fn a() {}"}
	wrapped, err := ResolveGraph(context.Background(), "main.swyp", root, loader)
	if err != nil {
		t.Fatal(err)
	}
	explicit, err := ResolveGraphWithLimits(context.Background(), "main.swyp", root, loader, DefaultModuleGraphLimits())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(wrapped, explicit) {
		t.Fatalf("wrapper graph=%+v explicit=%+v", wrapped, explicit)
	}

	wrappedGraph, wrappedModules, err := ResolveModules(context.Background(), "main.swyp", root, loader)
	if err != nil {
		t.Fatal(err)
	}
	explicitGraph, explicitModules, err := ResolveModulesWithLimits(context.Background(), "main.swyp", root, loader, DefaultModuleGraphLimits())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(wrappedGraph, explicitGraph) || !reflect.DeepEqual(wrappedModules, explicitModules) {
		t.Fatalf("wrapper modules differ: graph=%+v/%+v modules=%+v/%+v", wrappedGraph, explicitGraph, wrappedModules, explicitModules)
	}
}
