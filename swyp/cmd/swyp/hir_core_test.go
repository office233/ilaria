package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestHIRCoreCommandEmitsExecutableStandardCoreIR(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app", "main.swyp")
	lib := filepath.Join(root, "lib", "math.swyp")
	if err := os.MkdirAll(filepath.Dir(app), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(lib), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app, []byte(`module app.main;
use lib.math;
fn run(x: i64) -> i64 { return lib.math.square(x); }`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lib, []byte(`module lib.math;
fn square(x: i64) -> i64 { return x * x; }`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", "run", app}, &out); err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	result, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Int(8)}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := result.Value.Int64()
	if !ok || value != 64 {
		t.Fatalf("result=%v value=%d ok=%v", result.Value, value, ok)
	}
}

func TestHIRCoreOutputMetadataUsesCanonicalIRHash(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app", "main.swyp")
	if err := os.MkdirAll(filepath.Dir(app), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app, []byte(`module app.main;
fn run(x: i64) -> i64 { return x + 1; }`), 0o600); err != nil {
		t.Fatal(err)
	}
	outPath := filepath.Join(root, "linked.core.json")
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", "run", "-o", outPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		IRSHA256 string `json:"ir_sha256"`
	}
	if err := json.Unmarshal(out.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := json.Marshal(module)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.IRSHA256 != coreHash(canonical) {
		t.Fatalf("metadata hash=%s canonical=%s", metadata.IRSHA256, coreHash(canonical))
	}
}

func TestHIRCoreCommandRunsFixedSliceViewWithDynamicIndex(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app", "main.swyp")
	if err := os.MkdirAll(filepath.Dir(app), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app, []byte(`module app.main;
fn run(i: u64) -> u64 {
    let xs: array<u64,4> = [10,20,30,40];
    let s = xs[1:4];
    return s[i];
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", "run", app}, &out); err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		index uint64
		want  uint64
	}{{0, 20}, {1, 30}, {2, 40}} {
		result, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(tc.index)}, 5000)
		if err != nil {
			t.Fatalf("index %d: %v", tc.index, err)
		}
		got, ok := result.Value.Uint64()
		if !ok || got != tc.want {
			t.Fatalf("index %d got=%d ok=%v want=%d", tc.index, got, ok, tc.want)
		}
	}
	if _, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(3)}, 5000); err == nil {
		t.Fatal("out-of-range fixed slice index unexpectedly succeeded")
	}
}

func TestHIRCoreCommandRunsDynamicSliceRangeAndIndex(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app", "main.swyp")
	if err := os.MkdirAll(filepath.Dir(app), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app, []byte(`module app.main;
fn run(start: u64, end: u64, i: u64) -> u64 {
    let xs: array<u64,4> = [10,20,30,40];
    let s = xs[start:end];
    return s[i];
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", "run", app}, &out); err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	result, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(1), coreir.Uint(4), coreir.Uint(1)}, 10000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := result.Value.Uint64()
	if !ok || got != 30 {
		t.Fatalf("got=%d ok=%v want=30", got, ok)
	}
	if _, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(3), coreir.Uint(2), coreir.Uint(0)}, 10000); err == nil {
		t.Fatal("reversed runtime slice range unexpectedly succeeded")
	}
}

func TestHIRCoreCommandUsesStorageForLargeU64Array(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app", "main.swyp")
	if err := os.MkdirAll(filepath.Dir(app), 0o755); err != nil {
		t.Fatal(err)
	}
	values := make([]string, 65)
	for i := range values {
		values[i] = strconv.Itoa(100 + i)
	}
	source := `module app.main;
fn run(i: u64) -> u64 {
    let xs: array<u64,65> = [` + strings.Join(values, ",") + `];
    return xs[i];
}`
	if err := os.WriteFile(app, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", "run", app}, &out); err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	result, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(64)}, 10000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := result.Value.Uint64()
	if !ok || got != 164 {
		t.Fatalf("got=%d ok=%v want=164", got, ok)
	}
	if _, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(65)}, 10000); err == nil {
		t.Fatal("large storage array OOB unexpectedly succeeded")
	}
}

func TestHIRCoreCommandUsesStorageBackedSliceForLargeArray(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "app", "main.swyp")
	if err := os.MkdirAll(filepath.Dir(app), 0o755); err != nil {
		t.Fatal(err)
	}
	values := make([]string, 65)
	for i := range values {
		values[i] = strconv.Itoa(i)
	}
	source := `module app.main;
fn run(start: u64, end: u64, i: u64) -> u64 {
    let xs: array<u64,65> = [` + strings.Join(values, ",") + `];
    let s = xs[start:end];
    return s[i];
}`
	if err := os.WriteFile(app, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", "run", app}, &out); err != nil {
		t.Fatal(err)
	}
	module, err := coreir.Decode(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatal(err)
	}
	result, err := executable.Run(context.Background(), "run", []coreir.Value{coreir.Uint(60), coreir.Uint(65), coreir.Uint(4)}, 20000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := result.Value.Uint64()
	if !ok || got != 64 {
		t.Fatalf("got=%d ok=%v want=64", got, ok)
	}
}
