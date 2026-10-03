package runtimeguard

import (
	"flag"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

func TestExplicitFalseAndZero(t *testing.T) {
	for _, args := range [][]string{nil, {"-no-save=false", "-seed=0"}} {
		fs := flag.NewFlagSet("test", flag.ContinueOnError)
		noSave := fs.Bool("no-save", false, "")
		seed := fs.Int64("seed", 0, "")
		if err := fs.Parse(args); err != nil {
			t.Fatal(err)
		}
		configuredNoSave, configuredSeed := true, int64(17)
		ApplyExplicit(fs, map[string]func(){
			"no-save": func() { configuredNoSave = *noSave },
			"seed":    func() { configuredSeed = *seed },
		})
		if args == nil && (!configuredNoSave || configuredSeed != 17) {
			t.Fatal("absent flag overrode JSON")
		}
		if args != nil && (configuredNoSave || configuredSeed != 0) {
			t.Fatal("explicit zero/false ignored")
		}
	}
}

func TestDirectoryClassification(t *testing.T) {
	dir := t.TempDir()
	for _, p := range []string{dir, filepath.Join(dir, "absent")} {
		empty, err := EmptyStateDir(p)
		if err != nil || !empty {
			t.Fatalf("%s: %v %v", p, empty, err)
		}
	}
	file := filepath.Join(dir, "broken-checkpoint")
	if err := os.WriteFile(file, []byte("DO NOT OVERWRITE"), 0600); err != nil {
		t.Fatal(err)
	}
	if empty, err := EmptyStateDir(dir); err != nil || empty {
		t.Fatal("partial state was classified as fresh", empty, err)
	}
	if _, err := EmptyStateDir(file); err == nil {
		t.Fatal("regular file accepted as a directory")
	}
	if _, err := EmptyStateDir(""); err == nil {
		t.Fatal("empty path accepted")
	}
	if b, _ := os.ReadFile(file); string(b) != "DO NOT OVERWRITE" {
		t.Fatal("classification mutated data")
	}
}

func TestUnicodeTruncation(t *testing.T) {
	cases := []struct {
		s            string
		n            int
		runes, bytes string
	}{
		{"școală", 1, "ș…", "…(truncated)"},
		{"școală", 2, "șc…", "ș…(truncated)"},
		{"🙂abc", 4, "🙂abc", "🙂…(truncated)"},
		{"abcd", 2, "ab…", "ab…(truncated)"},
		{"x", 0, "", ""}, {"x", -1, "", ""},
		{"abc", 20, "abc", "abc"}, {"", 1, "", ""},
	}
	for _, c := range cases {
		r, b := TruncateRunes(c.s, c.n), TruncateBytes(c.s, c.n)
		if r != c.runes || b != c.bytes || !utf8.ValidString(r) || !utf8.ValidString(b) {
			t.Fatalf("%q %d: runes=%q bytes=%q", c.s, c.n, r, b)
		}
	}
}
