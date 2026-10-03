package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreBuildCommand(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "sum.swyp")
	exe := filepath.Join(dir, "sum.exe")
	if err := os.WriteFile(source, []byte(`
fn sum_to(n:i64)->i64 {
  let i:i64=1;
  let total:i64=0;
  while i<=n {
    total=total+i;
    i=i+1;
  }
  return total;
}

fn main(){}
`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cache := filepath.Join(dir, "cache")
	if err := coreBuildCommand([]string{"-entry", "sum_to", "-profile", "fast", "-cache-dir", cache, "-o", exe, source}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "folded=") {
		t.Fatalf("missing optimization report: %q", out.String())
	}
	result, err := exec.Command(exe, "100").CombinedOutput()
	if err != nil || strings.TrimSpace(string(result)) != "5050" {
		t.Fatalf("run err=%v out=%q", err, result)
	}
	if err := coreBuildCommand([]string{"-entry", "sum_to", "-profile", "fast", "-cache-dir", cache, "-o", exe, source}, &out); err == nil {
		t.Fatal("core-build overwrote existing output")
	}
	exe2 := filepath.Join(dir, "sum2.exe")
	out.Reset()
	if err := coreBuildCommand([]string{"-entry", "sum_to", "-profile", "fast", "-cache-dir", cache, "-o", exe2, source}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "cache hit") {
		t.Fatalf("second build did not report cache hit: %q", out.String())
	}
	result, err = exec.Command(exe2, "100").CombinedOutput()
	if err != nil || strings.TrimSpace(string(result)) != "5050" {
		t.Fatalf("cached run err=%v out=%q", err, result)
	}
}

func TestCoreAOTCacheKeyChangesWithSemantics(t *testing.T) {
	a := coreAOTCacheKey([]byte("A"), "gcc", "main", "fast", "portable", false, false)
	b := coreAOTCacheKey([]byte("B"), "gcc", "main", "fast", "portable", false, false)
	c := coreAOTCacheKey([]byte("A"), "gcc", "main", "safe", "portable", false, false)
	if a == b || a == c || len(a) != 64 {
		t.Fatalf("unexpected keys a=%q b=%q c=%q", a, b, c)
	}
}

func TestNativeCompilerArgs(t *testing.T) {
	args := nativeCompilerArgs("fast", "native", true, true, "program.c", "program.exe")
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-O3",
		"-fomit-frame-pointer",
		"-fno-semantic-interposition",
		"-march=native",
		"-mtune=native",
		"-flto",
		"-s",
		"program.c",
		"-o program.exe",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("compiler args missing %q: %s", want, joined)
		}
	}
}

func TestCoreAOTCacheDistinctFileNamesDoNotShareCache(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	sourceA := filepath.Join(dir, "file_a.swyp")
	sourceB := filepath.Join(dir, "file_b.swyp")
	exeA := filepath.Join(dir, "file_a.exe")
	exeB := filepath.Join(dir, "file_b.exe")
	cache := filepath.Join(dir, "cache")

	content := []byte(`
fn answer(n:i64)->i64 {
  return n + 1;
}
fn main(){}
`)
	if err := os.WriteFile(sourceA, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceB, content, 0600); err != nil {
		t.Fatal(err)
	}

	var outA bytes.Buffer
	if err := coreBuildCommand([]string{"-entry", "answer", "-profile", "fast", "-cache-dir", cache, "-o", exeA, sourceA}, &outA); err != nil {
		t.Fatalf("build A failed: %v", err)
	}
	if strings.Contains(outA.String(), "cache hit") {
		t.Fatalf("first build should not hit cache: %s", outA.String())
	}

	var outB bytes.Buffer
	if err := coreBuildCommand([]string{"-entry", "answer", "-profile", "fast", "-cache-dir", cache, "-o", exeB, sourceB}, &outB); err != nil {
		t.Fatalf("build B failed: %v", err)
	}
	if strings.Contains(outB.String(), "cache hit") {
		t.Fatalf("build B with different filename should not hit cache from A: %s", outB.String())
	}

	entries, err := os.ReadDir(cache)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".exe") {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("expected 2 distinct cache artifacts for distinct files, got %d", count)
	}
}

func TestCoreBuildCacheInstallFailureNonFatal(t *testing.T) {
	if _, err := exec.LookPath("gcc"); err != nil {
		t.Skip("gcc unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "test.swyp")
	exe := filepath.Join(dir, "test.exe")
	badCacheFile := filepath.Join(dir, "bad_cache")
	if err := os.WriteFile(badCacheFile, []byte("blocker"), 0600); err != nil {
		t.Fatal(err)
	}
	badCacheDir := filepath.Join(badCacheFile, "subdir")

	content := []byte(`
fn main(){}
`)
	if err := os.WriteFile(source, content, 0600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	err := coreBuildCommand([]string{"-entry", "main", "-profile", "safe", "-cache-dir", badCacheDir, "-o", exe, source}, &out)
	if err != nil {
		t.Fatalf("expected build to succeed despite cache install failure, got err: %v", err)
	}
	if _, statErr := os.Stat(exe); statErr != nil {
		t.Fatalf("expected output exe to exist: %v", statErr)
	}
	if !strings.Contains(out.String(), "warning:") {
		t.Fatalf("expected warning in output, got %q", out.String())
	}
}
