package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	vm "swyp-lang/internal/stv2"
	"swyp-lang/internal/swyplang"
)

const swypbCLISum = `fn main() -> number {
 let n = arg(0); let total = 0;
 while n > 0 { total = total + n; n = n - 1; }
 return total;
}`

func swypbCLIWrite(t testing.TB, dir, name, source string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func swypbCLIResult(t testing.TB, data []byte, want any) {
	t.Helper()
	var result struct {
		Format      string
		Version     int
		Profile     string
		Target      string
		Value       any
		ModuleBytes int `json:"module_bytes"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(string(data), err)
	}
	if result.Format != "SWYPB" || result.Version != 1 || result.Profile != "swyp-safe-integer" || result.Target != "stv2" || result.Value != want || result.ModuleBytes <= 48 {
		t.Fatalf("unexpected result %s", data)
	}
}

func TestSWYPBModuleCLICompileExec(t *testing.T) {
	dir := t.TempDir()
	src := swypbCLIWrite(t, dir, "sum.swyp", swypbCLISum)
	path := filepath.Join(dir, "sum.swypb")
	var out bytes.Buffer
	if err := compileModuleCommand([]string{"--target", "stv2", "-o", path, src}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "STV2") {
		t.Fatal(out.String())
	}
	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		n    string
		want float64
	}{{"0", 0}, {"100", 5050}, {"-5", 0}, {"1000", 500500}} {
		out.Reset()
		if err := execModuleCommand([]string{path, tc.n}, &out); err != nil {
			t.Fatal(err)
		}
		swypbCLIResult(t, out.Bytes(), tc.want)
	}
	boolean := swypbCLIWrite(t, dir, "bool.swyp", "fn main() -> bool { return arg(0) == 7; }")
	boolPath := filepath.Join(dir, "bool.swypb")
	if err := compileModuleCommand([]string{"-o", boolPath, boolean}, io.Discard); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		s string
		v bool
	}{{"7", true}, {"8", false}} {
		out.Reset()
		if err := execModuleCommand([]string{boolPath, tc.s}, &out); err != nil {
			t.Fatal(err)
		}
		swypbCLIResult(t, out.Bytes(), tc.v)
	}
}

func TestSWYPBModuleCLINoExecutionAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	src := swypbCLIWrite(t, dir, "loop.swyp", "fn main() -> number { while true {} return 0; }")
	path := filepath.Join(dir, "loop.swypb")
	if err := compileModuleCommand([]string{"-o", path, src}, io.Discard); err != nil {
		t.Fatal("compile must not run guest", err)
	}
	var out bytes.Buffer
	if err := execModuleCommand([]string{"-steps", "20", path}, &out); err == nil || !strings.Contains(err.Error(), "fuel") {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatal("failed execution printed success")
	}
	before, _ := os.ReadFile(path)
	if err := compileModuleCommand([]string{"-o", path, src}, io.Discard); !os.IsExist(err) {
		t.Fatalf("no overwrite: %v", err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("output changed")
	}
	original, _ := os.ReadFile(src)
	if err := compileModuleCommand([]string{"-o", src, src}, io.Discard); !os.IsExist(err) {
		t.Fatalf("source no overwrite: %v", err)
	}
	after, _ = os.ReadFile(src)
	if !bytes.Equal(original, after) {
		t.Fatal("source overwritten")
	}
	bad := swypbCLIWrite(t, dir, "bad.swyp", "fn main() -> number { return 0.5; }")
	badOutput := filepath.Join(dir, "bad.swypb")
	if err := compileModuleCommand([]string{"-o", badOutput, bad}, io.Discard); err == nil {
		t.Fatal("unsupported source accepted")
	}
	if _, err := os.Stat(badOutput); !os.IsNotExist(err) {
		t.Fatal("failed compilation created output")
	}
}

func TestSWYPBModuleCLIInvalidInputs(t *testing.T) {
	dir := t.TempDir()
	src := swypbCLIWrite(t, dir, "sum.swyp", swypbCLISum)
	path := filepath.Join(dir, "sum.swypb")
	if err := compileModuleCommand([]string{"-o", path, src}, io.Discard); err != nil {
		t.Fatal(err)
	}
	largeSource := swypbCLIWrite(t, dir, "big.swyp", strings.Repeat(" ", (1<<20)+1))
	largeModule := swypbCLIWrite(t, dir, "big.swypb", strings.Repeat("x", swyplang.MaxSWYPBBytes+1))
	rawProgram, err := vm.AssembleV2("halt r0")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := vm.EncodeV2(rawProgram)
	if err != nil {
		t.Fatal(err)
	}
	rawPath := swypbCLIWrite(t, dir, "raw.stv2", string(raw))
	invalid := swypbCLIWrite(t, dir, "invalid.swypb", "not a module")
	for _, args := range [][]string{
		nil, {src}, {"-o", path}, {"-o", path, src, "unexpected"}, {"--target", "go", "-o", path, src},
		{"-unknown"}, {"-o", filepath.Join(dir, "large.swypb"), largeSource}, {"-o", path, filepath.Join(dir, "absent")},
	} {
		var out bytes.Buffer
		if err := compileModuleCommand(args, &out); err == nil {
			t.Fatalf("accepted compile args %q", args)
		}
		if out.Len() != 0 {
			t.Fatal("failed compile printed success")
		}
	}
	for _, args := range [][]string{
		nil, {"-unknown"}, {path}, {path, "1", "2"}, {path, "1.5"}, {path, "NaN"}, {path, "9223372036854775808"},
		{path, "9007199254740992"}, {path, "-9007199254740992"}, {"-steps", "0", path, "1"},
		{"-steps", "1000001", path, "1"}, {"-steps", "bad", path, "1"}, {largeModule}, {rawPath}, {invalid}, {dir},
		{filepath.Join(dir, "absent")},
	} {
		var out bytes.Buffer
		if err := execModuleCommand(args, &out); err == nil {
			t.Fatalf("accepted exec args %q", args)
		}
		if out.Len() != 0 {
			t.Fatal("failed exec printed success")
		}
	}
}

type swypbBrokenWriter struct{}

func (swypbBrokenWriter) Write([]byte) (int, error) { return 0, fmt.Errorf("broken output") }

func TestSWYPBModuleCLIOutputErrorsAndDeterminism(t *testing.T) {
	dir := t.TempDir()
	a := swypbCLIWrite(t, dir, "a.swyp", swypbCLISum)
	b := swypbCLIWrite(t, dir, "b.swyp", swypbCLISum)
	first := filepath.Join(dir, "first.swypb")
	second := filepath.Join(dir, "second.swypb")
	if err := compileModuleCommand([]string{"-o", first, a}, swypbBrokenWriter{}); err == nil {
		t.Fatal("output error ignored")
	}
	// A reporting error does not undo the already successful module write.
	if err := compileModuleCommand([]string{"-o", second, b}, io.Discard); err != nil {
		t.Fatal(err)
	}
	x, _ := os.ReadFile(first)
	y, _ := os.ReadFile(second)
	if len(x) == 0 || !bytes.Equal(x, y) {
		t.Fatal("module depends on source path")
	}
	if err := execModuleCommand([]string{second, "10"}, swypbBrokenWriter{}); err == nil {
		t.Fatal("output error ignored")
	}
	if err := writeNewModule(filepath.Join(dir, "missing", "file.swypb"), x); err == nil {
		t.Fatal("bad path accepted")
	}
}

func TestSWYPBModuleCLIConcurrentWritersAndSymlink(t *testing.T) {
	dir := t.TempDir()
	src := swypbCLIWrite(t, dir, "sum.swyp", swypbCLISum)
	dst := filepath.Join(dir, "shared.swypb")
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- compileModuleCommand([]string{"-o", dst, src}, io.Discard) }()
	}
	wg.Wait()
	close(errs)
	success := 0
	for err := range errs {
		if err == nil {
			success++
		} else if !os.IsExist(err) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatalf("%d writers succeeded", success)
	}
	data, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := swyplang.LoadSWYPB(data); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.swypb")
	if err := os.Symlink(src, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	before, _ := os.ReadFile(src)
	if err := compileModuleCommand([]string{"-o", link, src}, io.Discard); !os.IsExist(err) {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(src)
	if !bytes.Equal(before, after) {
		t.Fatal("symlink target overwritten")
	}
}

// A helper test process invokes the same command implementations in a fresh
// address space. CI additionally tests the complete cmd/swyp executable.
func TestSWYPBCommandProcess(t *testing.T) {
	if os.Getenv("SWYPB_COMMAND_HELPER") != "1" {
		return
	}
	var args []string
	for i, a := range os.Args {
		if a == "--" {
			args = os.Args[i+1:]
			break
		}
	}
	var err error
	if len(args) == 0 {
		err = fmt.Errorf("missing helper command")
	} else if args[0] == "compile" {
		err = compileModuleCommand(args[1:], os.Stdout)
	} else if args[0] == "exec" {
		err = execModuleCommand(args[1:], os.Stdout)
	} else {
		err = fmt.Errorf("invalid helper command")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestSWYPBModuleCLIFreshProcessWithoutSource(t *testing.T) {
	dir := t.TempDir()
	src := swypbCLIWrite(t, dir, "sum.swyp", swypbCLISum)
	dst := filepath.Join(dir, "sum.swypb")
	process := func(args ...string) []byte {
		t.Helper()
		cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestSWYPBCommandProcess$", "--"}, args...)...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "SWYPB_COMMAND_HELPER=1", "PATH="+dir)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v", out, err)
		}
		return out
	}
	process("compile", "--target", "stv2", "-o", dst, src)
	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}
	out := process("exec", dst, "100")
	swypbCLIResult(t, out, float64(5050))
	t.Logf("fresh-process output with deleted source and tool-free PATH: %s", out)
}
