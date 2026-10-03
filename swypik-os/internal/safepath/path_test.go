package safepath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExistingBoundary(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	child := filepath.Join(root, "child")
	sibling := root + "-private"
	for _, p := range []string{root, child, sibling} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if !WithinExisting(child, root) || !WithinExisting(root, root) {
		t.Fatal("valid path rejected")
	}
	for _, p := range []string{base, sibling, filepath.Join(root, "missing"), ""} {
		if WithinExisting(p, root) {
			t.Fatalf("accepted %q", p)
		}
	}
	for _, p := range []string{"..", "../workspace-private", sibling, "C:/Windows", "child\\.."} {
		if _, err := ResolveRelative(root, p); err == nil {
			t.Fatalf("accepted %q", p)
		}
	}
	if got, err := ResolveRelative(root, "child"); err != nil || got == "" {
		t.Fatal(got, err)
	}
}
func TestSymlinksAreResolvedOnBothSides(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, p := range []string{root, outside} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlink privilege unavailable:", err)
	}
	if WithinExisting(link, root) {
		t.Fatal("unresolved symlink escaped root")
	}
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	if !WithinExisting(root, alias) || !WithinExisting(alias, root) {
		t.Fatal("root aliases disagree")
	}
}
