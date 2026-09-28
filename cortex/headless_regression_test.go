package cortex

import (
	"context"
	"errors"
	"flag"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

func TestConfigExplicitOverridesRetainNoSave(t *testing.T) {
	cfg := DefaultConfig()
	cfg.NoSave = true
	cfg.Seed = 17
	fs := flag.NewFlagSet("headless", flag.ContinueOnError)
	noSave := fs.Bool("no-save", false, "")
	seed := fs.Int64("seed", 0, "")
	apply := func() error {
		return ApplyConfigFlags(&cfg, fs, map[string]func(){
			"no-save": func() { cfg.NoSave = *noSave }, "seed": func() { cfg.Seed = *seed },
		})
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if err := apply(); err != nil {
		t.Fatal(err)
	}
	if !cfg.NoSave || cfg.Seed != 17 {
		t.Fatal("defaults replaced configured values")
	}
	if err := fs.Parse([]string{"-no-save=false", "-seed=0"}); err != nil {
		t.Fatal(err)
	}
	if err := apply(); err != nil {
		t.Fatal(err)
	}
	if cfg.NoSave || cfg.Seed != 0 {
		t.Fatal("explicit false/zero ignored")
	}
}

func TestOpenOrganismCorruptStateIsPreserved(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DataDir = t.TempDir()
	p := filepath.Join(cfg.DataDir, "vocab.json")
	before := []byte("corrupt: do not overwrite")
	if err := os.WriteFile(p, before, 0600); err != nil {
		t.Fatal(err)
	}
	for _, fresh := range []bool{false, true} {
		cfg.Fresh = fresh
		if _, err := OpenOrganism(cfg, rand.New(rand.NewSource(42))); err == nil {
			t.Fatal("bad state accepted")
		}
		b, err := os.ReadFile(p)
		if err != nil || string(b) != string(before) {
			t.Fatal("original data changed", err)
		}
	}
}

func TestBiomedChatCancellationBeforeIO(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tool := NewBiomedChatTool(filepath.Join(t.TempDir(), "not-created"))
	if _, err := tool.Call(ctx, "test query"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel lost: %v", err)
	}
}

func TestToolDefaultRefusesHostExecution(t *testing.T) {
	tool := GoRunChatTool{}
	if _, err := tool.Call(context.Background(), "package main; func main() {}"); err == nil {
		t.Fatal("zero-value tool executed host code")
	}
}

func TestTruncationPreservesRomanian(t *testing.T) {
	if got := truncStr("școală", 1); got != "ș…" || !utf8.ValidString(got) {
		t.Fatal(got)
	}
	if got := truncateForTool("școală", 1); !utf8.ValidString(got) {
		t.Fatal("invalid UTF-8")
	}
}
