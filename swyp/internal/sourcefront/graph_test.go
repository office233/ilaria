package sourcefront

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mapLoader map[string]string

func (m mapLoader) LoadModule(_ context.Context, module string) ([]byte, error) {
	source, ok := m[module]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return []byte(source), nil
}

func TestResolveGraphDeterministicAndContentAddressed(t *testing.T) {
	root := []byte("module app.main;\nuse lib.math;\nuse lib.text;\nfn main() {}\n")
	loader := mapLoader{
		"lib.math": "module lib.math;\nuse lib.base;\nfn square() {}\n",
		"lib.text": "module lib.text;\nfn render() {}\n",
		"lib.base": "module lib.base;\nfn value() {}\n",
	}
	g, err := ResolveGraph(context.Background(), "main.swyp", root, loader)
	if err != nil {
		t.Fatal(err)
	}
	if g.Version != GraphVersion || g.Root != "app.main" || len(g.Nodes) != 4 {
		t.Fatalf("graph=%+v", g)
	}
	gotOrder := make([]string, 0, len(g.Nodes))
	for _, node := range g.Nodes {
		gotOrder = append(gotOrder, node.Module)
	}
	if strings.Join(gotOrder, ",") != "app.main,lib.base,lib.math,lib.text" {
		t.Fatalf("node order=%v", gotOrder)
	}
	sum := sha256.Sum256([]byte(loader["lib.math"]))
	for _, node := range g.Nodes {
		if node.Module == "lib.math" && node.SourceSHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("lib.math hash=%q", node.SourceSHA256)
		}
	}
}

func TestResolveGraphRejectsCycleAndModuleMismatch(t *testing.T) {
	root := []byte("module app.main; use lib.a; fn main() {}")
	_, err := ResolveGraph(context.Background(), "main.swyp", root, mapLoader{
		"lib.a": "module lib.a; use app.main; fn a() {}",
	})
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("cycle error=%v", err)
	}

	_, err = ResolveGraph(context.Background(), "main.swyp", root, mapLoader{
		"lib.a": "module wrong.name; fn a() {}",
	})
	if err == nil || !strings.Contains(err.Error(), "declares wrong.name") {
		t.Fatalf("mismatch error=%v", err)
	}
}

func TestFSLoaderUsesExplicitRoot(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "lib", "math.swyp")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	source := "module lib.math; fn square() {}"
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := (FSLoader{Root: root}).LoadModule(context.Background(), "lib.math")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != source {
		t.Fatalf("source=%q", data)
	}
	if _, err := (FSLoader{Root: root}).LoadModule(context.Background(), "../escape"); err == nil {
		t.Fatal("invalid module path accepted")
	}
}
