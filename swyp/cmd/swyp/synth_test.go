package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/swyplang"
	"swyp-lang/internal/synthesis"
)

func TestSynthCommand_InvalidFlags(t *testing.T) {
	tmpDir := t.TempDir()
	validSpec := filepath.Join(tmpDir, "valid.json")
	if err := os.WriteFile(validSpec, []byte(`{"examples":[{"x":0,"y":1}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	outPath := filepath.Join(tmpDir, "out.swyp")

	tests := []struct {
		name string
		args []string
	}{
		{"nil args", nil},
		{"empty args", []string{}},
		{"missing -o flag", []string{validSpec}},
		{"empty -o value", []string{"-o", "", validSpec}},
		{"missing spec positional arg", []string{"-o", outPath}},
		{"extra positional args", []string{"-o", outPath, validSpec, validSpec}},
		{"unknown flag", []string{"-unknown", validSpec}},
		{"zero timeout", []string{"-timeout", "0s", "-o", outPath, validSpec}},
		{"negative timeout", []string{"-timeout", "-5s", "-o", outPath, validSpec}},
		{"timeout exceeds 60s", []string{"-timeout", "61s", "-o", outPath, validSpec}},
		{"invalid duration format", []string{"-timeout", "invalid", "-o", outPath, validSpec}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := synthCommand(tc.args)
			if err == nil {
				t.Fatalf("expected error for case %q, got nil", tc.name)
			}
			if _, statErr := os.Stat(outPath); statErr == nil {
				t.Fatalf("expected output file not to be created for failing flag case %q", tc.name)
			}
		})
	}
}

func TestSynthCommand_MalformedJSON(t *testing.T) {
	tmpDir := t.TempDir()

	largeData := make([]byte, 64*1024+1)
	for i := range largeData {
		largeData[i] = ' '
	}

	tests := []struct {
		name    string
		content []byte
		missing bool
	}{
		{
			name:    "file does not exist",
			missing: true,
		},
		{
			name:    "empty file",
			content: []byte(""),
		},
		{
			name:    "exceeds 64 KiB",
			content: largeData,
		},
		{
			name:    "syntax error",
			content: []byte(`{"examples": [ {"x": 1`),
		},
		{
			name:    "unknown top-level field",
			content: []byte(`{"examples":[{"x":0,"y":1}],"unknown_key":true}`),
		},
		{
			name:    "unknown field in example",
			content: []byte(`{"examples":[{"x":0,"y":1,"unknown":42}]}`),
		},
		{
			name:    "trailing json object",
			content: []byte(`{"examples":[{"x":0,"y":1}]} {"more": 1}`),
		},
		{
			name:    "trailing number token",
			content: []byte(`{"examples":[{"x":0,"y":1}]} 42`),
		},
		{
			name:    "trailing string token",
			content: []byte(`{"examples":[{"x":0,"y":1}]} "trailing"`),
		},
		{
			name:    "trailing garbage",
			content: []byte(`{"examples":[{"x":0,"y":1}]} trailing_garbage`),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			specPath := filepath.Join(tmpDir, "spec.json")
			if !tc.missing {
				if err := os.WriteFile(specPath, tc.content, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				specPath = filepath.Join(tmpDir, "nonexistent.json")
			}
			outPath := filepath.Join(tmpDir, "out_"+tc.name+".swyp")

			err := synthCommand([]string{"-o", outPath, specPath})
			if err == nil {
				t.Fatalf("expected error for case %q, got nil", tc.name)
			}
			if _, statErr := os.Stat(outPath); statErr == nil {
				t.Fatalf("output file should not exist on malformed JSON for case %q", tc.name)
			}
		})
	}
}

func TestSynthCommand_NoOverwrite(t *testing.T) {
	tmpDir := t.TempDir()
	outPath := filepath.Join(tmpDir, "already_exists.swyp")
	initialContent := "// pre-existing file content\nfn existing() {}\n"
	if err := os.WriteFile(outPath, []byte(initialContent), 0600); err != nil {
		t.Fatal(err)
	}

	specPath := filepath.Join(tmpDir, "spec.json")
	if err := os.WriteFile(specPath, []byte(`{"examples":[{"x":0,"y":1},{"x":1,"y":3}]}`), 0600); err != nil {
		t.Fatal(err)
	}

	err := synthCommand([]string{"-o", outPath, specPath})
	if err == nil {
		t.Fatal("expected error when output file already exists, got nil")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected 'already exists' in error, got %v", err)
	}

	// Verify original content was not overwritten
	currentContent, readErr := os.ReadFile(outPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(currentContent) != initialContent {
		t.Fatalf("file content was overwritten! expected %q, got %q", initialContent, string(currentContent))
	}
}

func TestSynthCommand_ValidOutput(t *testing.T) {
	tmpDir := t.TempDir()
	specPath := filepath.Join(tmpDir, "linear_spec.json")
	specContent := `{
		"examples": [
			{"x": 0, "y": 1},
			{"x": 1, "y": 3},
			{"x": 2, "y": 5}
		],
		"constants": [-1, 0, 1, 2],
		"max_nodes": 7,
		"max_candidates": 20000
	}`
	if err := os.WriteFile(specPath, []byte(specContent), 0600); err != nil {
		t.Fatal(err)
	}

	outPath := filepath.Join(tmpDir, "result.swyp")
	err := synthCommand([]string{"-o", outPath, "-timeout", "5s", specPath})
	if err != nil {
		t.Fatalf("synthCommand failed: %v", err)
	}

	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read synthesized output file: %v", err)
	}
	source := string(data)

	if !strings.Contains(source, "fn predict(x: number) -> number") {
		t.Errorf("output missing predict function declaration:\n%s", source)
	}
	if !strings.Contains(source, "fn main()") {
		t.Errorf("output missing main function declaration:\n%s", source)
	}
	if !strings.Contains(source, "predict(arg(0))") {
		t.Errorf("output missing predict(arg(0)) call:\n%s", source)
	}

	// Parse and check with swyplang
	prog, err := swyplang.Parse(outPath, source)
	if err != nil {
		t.Fatalf("generated source failed swyplang.Parse: %v", err)
	}
	if err := prog.Check(); err != nil {
		t.Fatalf("generated source failed swyplang.Check: %v", err)
	}

	// Evaluate against examples
	for _, tc := range []struct {
		in   float64
		want float64
	}{
		{0, 1},
		{1, 3},
		{2, 5},
		{3, 7},
	} {
		var outBuf bytes.Buffer
		if err := prog.RunArgs(&outBuf, 10000, []float64{tc.in}); err != nil {
			t.Fatalf("execution failed for input %v: %v", tc.in, err)
		}
		val, parseErr := strconv.ParseFloat(strings.TrimSpace(outBuf.String()), 64)
		if parseErr != nil {
			t.Fatalf("failed to parse output %q: %v", outBuf.String(), parseErr)
		}
		if val != tc.want {
			t.Errorf("for input %v, got %v, want %v", tc.in, val, tc.want)
		}
	}
}

func TestSynthCommand_GeneratedSourceCheckFailure(t *testing.T) {
	tmpDir := t.TempDir()
	specPath := filepath.Join(tmpDir, "spec.json")
	if err := os.WriteFile(specPath, []byte(`{"examples":[{"x":0,"y":1}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	outPath := filepath.Join(tmpDir, "broken.swyp")

	// Temporarily override synthesizeFn to return invalid source
	oldFn := synthesizeFn
	defer func() { synthesizeFn = oldFn }()

	synthesizeFn = func(ctx context.Context, spec synthesis.Spec) (synthesis.Result, error) {
		return synthesis.Result{
			Expression: "invalid_syntax +++",
			Source:     "fn predict(x: number) -> number { return syntax error +++; }",
			Candidates: 1,
		}, nil
	}

	err := synthCommand([]string{"-o", outPath, specPath})
	if err == nil {
		t.Fatal("expected error on rejected generated source, got nil")
	}
	if !strings.Contains(err.Error(), "generated source rejected") {
		t.Fatalf("expected 'generated source rejected' in error, got: %v", err)
	}
	if _, statErr := os.Stat(outPath); statErr == nil {
		t.Fatal("output file should not exist when source verification fails")
	}
}

func TestSynthCommand_LinearExampleSpecFile(t *testing.T) {
	// Look for examples/swyp/synthesis-linear.json
	repoSpec := filepath.Join("..", "..", "examples", "swyp", "synthesis-linear.json")
	if _, err := os.Stat(repoSpec); os.IsNotExist(err) {
		repoSpec = filepath.Join("examples", "swyp", "synthesis-linear.json")
	}
	if _, err := os.Stat(repoSpec); err != nil {
		t.Skipf("cannot find examples/swyp/synthesis-linear.json: %v", err)
	}

	tmpDir := t.TempDir()
	outPath := filepath.Join(tmpDir, "linear_repo.swyp")

	if err := synthCommand([]string{"-o", outPath, repoSpec}); err != nil {
		t.Fatalf("failed to run synthCommand on examples/swyp/synthesis-linear.json: %v", err)
	}

	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed to read synthesized output: %v", err)
	}

	prog, err := swyplang.Parse(outPath, string(data))
	if err != nil {
		t.Fatalf("swyplang.Parse failed: %v", err)
	}
	if err := prog.Check(); err != nil {
		t.Fatalf("swyplang.Check failed: %v", err)
	}

	// Verify x=0 -> 1, x=1 -> 3, x=2 -> 5, x=3 -> 7
	for _, tc := range []struct {
		x float64
		y float64
	}{
		{0, 1},
		{1, 3},
		{2, 5},
		{3, 7},
	} {
		var out bytes.Buffer
		if err := prog.RunArgs(&out, 10000, []float64{tc.x}); err != nil {
			t.Fatalf("failed to execute for input %v: %v", tc.x, err)
		}
		got, parseErr := strconv.ParseFloat(strings.TrimSpace(out.String()), 64)
		if parseErr != nil {
			t.Fatalf("failed to parse output %q: %v", out.String(), parseErr)
		}
		if got != tc.y {
			t.Errorf("for input %v: got %v, want %v", tc.x, got, tc.y)
		}
	}
}
