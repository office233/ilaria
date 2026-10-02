package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/swyplang"
)

// The native runtime parity corpus executes the same Swyp programs, arguments
// and expectations on every standalone executable target that can really run
// on the host: Windows x86-64 PE, Linux x86-64 static ELF and PIE, and Linux
// AArch64 static ELF and PIE (natively, or under the qemu-aarch64 user-mode
// emulator named by SWYP_QEMU_AARCH64). Structural ELF checks elsewhere do not
// prove runtime behavior; this corpus does.
const nativeParityQEMUEnv = "SWYP_QEMU_AARCH64"

type nativeParityTarget struct {
	name   string
	arch   string // "x64" or "arm64"
	format string // "pe" or "elf"
	pie    bool
	runner string // optional user-mode emulator
}

type nativeParityProgram struct {
	core    string            // single-file Core source
	modules map[string]string // HIR modules; app/main.swyp is the root module
	entry   string
	grants  []string
	output  string // executable base name; defaults to "program"
}

type nativeParityRun struct {
	args   []string
	exit   int
	stdout *string // nil requires empty stdout
	stderr *string // nil requires empty stderr
}

type nativeParityCase struct {
	name    string
	program nativeParityProgram
	files   map[string]string
	runs    []nativeParityRun
	// oracle derives every run's exit status from the Core reference
	// interpreter instead of a fixed expectation.
	oracle bool
	verify func(t *testing.T, dir string)
}

type nativeParityResult struct {
	exit           int
	stdout, stderr string
	err            error
}

func nativeParityTargets(t *testing.T) []nativeParityTarget {
	t.Helper()
	var targets []nativeParityTarget
	switch {
	case runtime.GOOS == "windows" && runtime.GOARCH == "amd64":
		targets = append(targets, nativeParityTarget{name: "x64-pe", arch: "x64", format: "pe"})
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		targets = append(targets,
			nativeParityTarget{name: "x64-elf", arch: "x64", format: "elf"},
			nativeParityTarget{name: "x64-elf-pie", arch: "x64", format: "elf", pie: true})
	case runtime.GOOS == "linux" && runtime.GOARCH == "arm64":
		targets = append(targets,
			nativeParityTarget{name: "arm64-elf", arch: "arm64", format: "elf"},
			nativeParityTarget{name: "arm64-elf-pie", arch: "arm64", format: "elf", pie: true})
	}
	if qemu := os.Getenv(nativeParityQEMUEnv); qemu != "" && runtime.GOOS == "linux" && runtime.GOARCH != "arm64" {
		info, err := os.Stat(qemu)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			// An explicitly configured emulator must work; never fall back silently.
			t.Fatalf("%s=%q is not an executable qemu-aarch64 user-mode emulator (err=%v)", nativeParityQEMUEnv, qemu, err)
		}
		targets = append(targets,
			nativeParityTarget{name: "arm64-elf-qemu", arch: "arm64", format: "elf", runner: qemu},
			nativeParityTarget{name: "arm64-elf-pie-qemu", arch: "arm64", format: "elf", pie: true, runner: qemu})
	}
	if len(targets) == 0 {
		t.Skipf("no standalone native target executes on %s/%s (on Linux set %s to run AArch64 under qemu-user)", runtime.GOOS, runtime.GOARCH, nativeParityQEMUEnv)
	}
	return targets
}

// exitFor maps a 64-bit entry result to the status observed by the host:
// Windows keeps the low 32 bits of ExitProcess, Linux keeps the low 8 bits.
func (target nativeParityTarget) exitFor(raw uint64) int {
	if target.format == "pe" {
		return int(uint32(raw))
	}
	return int(uint8(raw))
}

func (target nativeParityTarget) build(t *testing.T, dir string, program nativeParityProgram) string {
	t.Helper()
	name := program.output
	if name == "" {
		name = "program"
	}
	if target.format == "pe" {
		name += ".exe"
	}
	output := filepath.Join(dir, name)
	var flags []string
	if target.arch == "x64" {
		flags = append(flags, "-format", target.format)
	}
	if target.pie {
		flags = append(flags, "-pie")
	}
	flags = append(flags, program.grants...)
	var args []string
	var command func([]string, io.Writer) error
	if program.core != "" {
		source := filepath.Join(dir, "program.swyp")
		if err := os.WriteFile(source, []byte(program.core), 0o600); err != nil {
			t.Fatal(err)
		}
		args = append(append([]string{"-entry", program.entry}, flags...), "-o", output, source)
		command = coreX64ExeCommand
		if target.arch == "arm64" {
			command = coreARM64ExeCommand
		}
	} else {
		root := filepath.Join(dir, "src")
		for rel, source := range program.modules {
			writeHIRNativeFile(t, root, rel, source)
		}
		app := filepath.Join(root, "app", "main.swyp")
		args = append(append([]string{"-root", root, "-entry", program.entry}, flags...), "-o", output, app)
		command = hirX64ExeCommand
		if target.arch == "arm64" {
			command = hirARM64ExeCommand
		}
	}
	var log bytes.Buffer
	if err := command(args, &log); err != nil {
		t.Fatalf("%s build %v: %v\n%s", target.name, args, err, log.String())
	}
	return output
}

func (target nativeParityTarget) run(t *testing.T, dir, exe string, args ...string) nativeParityResult {
	t.Helper()
	name, argv := exe, args
	if target.runner != "" {
		name, argv = target.runner, append([]string{exe}, args...)
	}
	for attempt := 0; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		cmd := exec.CommandContext(ctx, name, argv...)
		cmd.Dir = dir
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		timedOut := ctx.Err() != nil
		cancel()
		if cmd.ProcessState == nil {
			// Linux reports ETXTBSY when a concurrently forked test process
			// briefly inherited the just-written executable's descriptor.
			if err != nil && strings.Contains(err.Error(), "text file busy") && attempt < 50 {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			t.Fatalf("%s: %s did not start: %v", target.name, exe, err)
		}
		if timedOut {
			t.Fatalf("%s: %s %q timed out", target.name, exe, args)
		}
		return nativeParityResult{exit: cmd.ProcessState.ExitCode(), stdout: stdout.String(), stderr: stderr.String(), err: err}
	}
}

// nativeParityOracle evaluates a Core entry with the reference interpreter. A
// semantic trap maps to the standalone backend-failure exit status 1.
func nativeParityOracle(t *testing.T, target nativeParityTarget, program nativeParityProgram, args []string) int {
	t.Helper()
	entry := program.entry
	var module coreir.Module
	if program.core != "" {
		parsed, err := swyplang.ParseCore("oracle.swyp", program.core)
		if err != nil {
			t.Fatalf("oracle parse: %v", err)
		}
		module, err = parsed.CoreIR(entry)
		if err != nil {
			t.Fatalf("oracle lower: %v", err)
		}
	} else {
		module = nativeParityHIRModule(t, program)
	}
	executable, err := coreir.Prepare(module)
	if err != nil {
		t.Fatalf("oracle prepare: %v", err)
	}
	var params []coreir.Parameter
	found := false
	for _, f := range module.Functions {
		if f.Name == entry {
			params, found = f.Params, true
			break
		}
	}
	if !found || len(params) != len(args) {
		t.Fatalf("oracle entry %q found=%v params=%d args=%d", entry, found, len(params), len(args))
	}
	values := make([]coreir.Value, len(args))
	for i, arg := range args {
		value, err := coreir.ParseValue(params[i].Type, arg)
		if err != nil {
			t.Fatalf("oracle argument %d %q: %v", i, arg, err)
		}
		values[i] = value
	}
	result, err := executable.Run(context.Background(), entry, values, coreir.MaxFuel)
	if err != nil {
		var d *coreir.Diagnostic
		if errors.As(err, &d) {
			switch d.Code {
			case "overflow", "division_by_zero", "shift_out_of_range", "bounds", "non_finite":
				return 1
			case "unreachable":
				if program.core == "" {
					return 1 // HIR checked descriptor guards use an unreachable failure block.
				}
			}
		}
		t.Fatalf("oracle %s%q: non-semantic interpreter failure: %v", entry, args, err)
	}
	switch value := result.Value; value.Type() {
	case coreir.Bool:
		if b, _ := value.Boolean(); b {
			return 1
		}
		return 0
	case coreir.I64:
		i, _ := value.Int64()
		return target.exitFor(uint64(i))
	case coreir.U64:
		u, _ := value.Uint64()
		return target.exitFor(u)
	}
	t.Fatalf("oracle result type %v has no process exit mapping", result.Value.Type())
	return 0
}

func nativeParityHIRModule(t *testing.T, program nativeParityProgram) coreir.Module {
	t.Helper()
	root := t.TempDir()
	for rel, source := range program.modules {
		writeHIRNativeFile(t, root, rel, source)
	}
	var out bytes.Buffer
	if err := hirCoreCommand([]string{"-root", root, "-entry", program.entry, filepath.Join(root, "app", "main.swyp")}, &out); err != nil {
		t.Fatalf("oracle HIR lower: %v", err)
	}
	module, err := coreir.Decode(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return module
}

func TestNativeRuntimeParity(t *testing.T) {
	targets := nativeParityTargets(t)
	for _, custom := range nativeParityCustomCases() {
		custom := custom
		t.Run(custom.name, func(t *testing.T) {
			for _, target := range targets {
				target := target
				t.Run(target.name, func(t *testing.T) { custom.run(t, target, t.TempDir()) })
			}
		})
	}
	for _, tc := range nativeParityCases() {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, target := range targets {
				target := target
				t.Run(target.name, func(t *testing.T) {
					dir := t.TempDir()
					for name, content := range tc.files {
						if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
							t.Fatal(err)
						}
					}
					exe := target.build(t, dir, tc.program)
					for _, want := range tc.runs {
						if tc.oracle {
							want.exit = nativeParityOracle(t, target, tc.program, want.args)
						}
						wantStdout, wantStderr := "", ""
						if want.stdout != nil {
							wantStdout = *want.stdout
						}
						if want.stderr != nil {
							wantStderr = *want.stderr
						}
						got := target.run(t, dir, exe, want.args...)
						if got.exit != want.exit || got.stdout != wantStdout || got.stderr != wantStderr {
							t.Errorf("%s args=%q: exit=%d stdout=%q stderr=%q (%v); want exit=%d stdout=%q stderr=%q",
								target.name, want.args, got.exit, got.stdout, got.stderr, got.err, want.exit, wantStdout, wantStderr)
						}
					}
					if tc.verify != nil {
						tc.verify(t, dir)
					}
				})
			}
		})
	}
}

func nativeParityText(s string) *string { return &s }

func nativeParityExit(exit int, args ...string) nativeParityRun {
	return nativeParityRun{args: args, exit: exit}
}

func nativeParityPrints(exit int, stdout string, args ...string) nativeParityRun {
	return nativeParityRun{args: args, exit: exit, stdout: nativeParityText(stdout)}
}

func nativeParityCore(source, entry string, grants ...string) nativeParityProgram {
	return nativeParityProgram{core: source + " fn main(){}", entry: entry, grants: grants}
}

func nativeParityHIR(entry string, modules map[string]string, grants ...string) nativeParityProgram {
	return nativeParityProgram{modules: modules, entry: entry, grants: grants}
}

func nativeParityApp(source string) map[string]string {
	return map[string]string{"app/main.swyp": "module app.main;\n" + source}
}

func nativeParityFileEquals(name, want string) func(t *testing.T, dir string) {
	return func(t *testing.T, dir string) {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("expected %s: %v", name, err)
		}
		if string(data) != want {
			t.Fatalf("%s=%q want=%q", name, data, want)
		}
	}
}

func nativeParityNumbers(n int, last string) string {
	values := make([]string, n)
	for i := range values {
		values[i] = strconv.Itoa(i)
	}
	if last != "" {
		values[n-1] = last
	}
	return strings.Join(values, ",")
}

// nativeParitySpillSource keeps 24 values live at once so every backend's
// register allocator must spill and reload general-purpose registers.
func nativeParitySpillSource() string {
	const live = 24
	var b strings.Builder
	b.WriteString("fn spill(a:i64,b:i64)->i64{")
	for i := 1; i <= live; i++ {
		fmt.Fprintf(&b, "let x%d:i64=a*%d+b*%d;", i, i, live+1-i)
	}
	b.WriteString("let total:i64=0")
	for i := 1; i <= live; i++ {
		fmt.Fprintf(&b, "+x%d", i)
	}
	b.WriteString(";return total%251;}")
	return b.String()
}

// nativeParityFPSpillSource keeps 24 ieee64 values live at once, forcing XMM
// and D-register spills; every value is a dyadic rational so sums stay exact.
func nativeParityFPSpillSource() string {
	const live = 24
	var b strings.Builder
	b.WriteString("fn fspill(x:ieee64,y:ieee64)->bool{")
	for i := 1; i <= live; i++ {
		fmt.Fprintf(&b, "let v%d:ieee64=x*%d.0+y*%d.0;", i, i, live+1-i)
	}
	b.WriteString("let total:ieee64=0.0")
	for i := 1; i <= live; i++ {
		fmt.Fprintf(&b, "+v%d", i)
	}
	b.WriteString(";return total==300.0*(x+y);}")
	return b.String()
}

// nativeParitySpillAcrossCallSource keeps many values live across a real
// native call, so caller-saved registers and spill slots must survive it.
func nativeParitySpillAcrossCallSource() string {
	const live = 16
	var b strings.Builder
	b.WriteString("fn k(x:i64)->i64{let s:i64=0;let i:i64=0;while i<3{s=s+x;i=i+1;}return s;} fn f(a:i64,b:i64)->i64{")
	for i := 1; i <= live; i++ {
		fmt.Fprintf(&b, "let x%d:i64=a*%d+b;", i, i)
	}
	b.WriteString("let c:i64=k(a);let total:i64=c")
	for i := 1; i <= live; i++ {
		fmt.Fprintf(&b, "+x%d", i)
	}
	b.WriteString(";return total%251;}")
	return b.String()
}

func nativeParityCases() []nativeParityCase {
	const minI64, maxI64, maxU64 = "-9223372036854775808", "9223372036854775807", "18446744073709551615"
	cases := []nativeParityCase{
		{name: "core/answer", program: nativeParityCore("fn answer()->i64{return 42;}", "answer"), runs: []nativeParityRun{nativeParityExit(42)}},
		{name: "core/bool-result", program: nativeParityCore("fn truth()->bool{return true;}", "truth"), runs: []nativeParityRun{nativeParityExit(1)}},
		{name: "core/integer-args", program: nativeParityCore("fn add(x:i64,y:i64)->i64{return x+y;}", "add"), runs: []nativeParityRun{nativeParityExit(42, "20", "22")}},
		{name: "core/signed-arg", program: nativeParityCore("fn abs(x:i64)->i64{if x<0{return -x;}return x;}", "abs"), runs: []nativeParityRun{
			nativeParityExit(7, "-7"), nativeParityExit(7, "7"), nativeParityExit(0, "0"),
		}},
		{name: "core/unsigned-arg", program: nativeParityCore("fn idu(x:u64)->u64{return x;}", "idu"), runs: []nativeParityRun{nativeParityExit(42, "42")}},
		{name: "core/i64-boundaries", program: nativeParityCore("fn eqi(x:i64,y:i64)->bool{return x==y;}", "eqi"), runs: []nativeParityRun{
			nativeParityExit(1, minI64, minI64), nativeParityExit(1, maxI64, maxI64), nativeParityExit(0, minI64, maxI64),
		}},
		{name: "core/u64-boundaries", program: nativeParityCore("fn equ(x:u64,y:u64)->bool{return x==y;}", "equ"), runs: []nativeParityRun{
			nativeParityExit(1, maxU64, maxU64), nativeParityExit(0, maxU64, "0"),
		}},
		{name: "core/bool-args", program: nativeParityCore("fn choose(c:bool,x:i64,y:i64)->i64{if c{return x;}return y;}", "choose"), runs: []nativeParityRun{
			nativeParityExit(7, "true", "7", "9"), nativeParityExit(9, "false", "7", "9"),
			nativeParityExit(7, "1", "7", "9"), nativeParityExit(9, "0", "7", "9"),
		}},
		{name: "core/invalid-args", program: nativeParityCore("fn id(x:i64)->i64{return x;}", "id"), runs: []nativeParityRun{
			nativeParityExit(2), nativeParityExit(2, "abc"), nativeParityExit(2, "9223372036854775808"),
			nativeParityExit(2, "-9223372036854775809"), nativeParityExit(2, "1", "2"),
		}},
		{name: "core/ieee64-args", program: nativeParityCore("fn cmp(x:ieee64,y:ieee64)->bool{return x>y;}", "cmp"), runs: []nativeParityRun{
			nativeParityExit(1, "3.25", "2.5"), nativeParityExit(0, "-1.25", "0.5"), nativeParityExit(1, ".5", "0.25"),
			nativeParityExit(1, "1.", "0.5"), nativeParityExit(1, "1e2", "99.5"), nativeParityExit(0, "1E-2", "0.02"),
			nativeParityExit(1, "1e400", "0"), nativeParityExit(2, ".", "0"), nativeParityExit(2, "1e", "0"),
			nativeParityExit(2, "--1", "0"), nativeParityExit(2, "1.2.3", "0"),
		}},
		{name: "core/bytes-len", program: nativeParityCore(`fn length()->u64{return bytes_len("hello");}`, "length"), runs: []nativeParityRun{nativeParityExit(5)}},
		{name: "core/bytes-get", program: nativeParityCore(`fn first()->u64{return bytes_get("abc",0);}`, "first"), runs: []nativeParityRun{nativeParityExit('a')}},
		{
			name:    "core/fs-write",
			program: nativeParityCore(`fn save()->i64{write_file("written-by-swyp.txt","hello-from-swyp");return 7;}`, "save", "-allow-fs-write"),
			runs:    []nativeParityRun{nativeParityExit(7)},
			verify:  nativeParityFileEquals("written-by-swyp.txt", "hello-from-swyp"),
		},
		{
			name:    "core/fs-read",
			program: nativeParityCore(`fn load()->u64{let b:bytes=read_file("input.txt");return bytes_get(b,0)+bytes_len(b);}`, "load", "-allow-fs-read"),
			files:   map[string]string{"input.txt": "hello"},
			runs:    []nativeParityRun{nativeParityExit('h' + 5)},
		},
		{
			name:    "core/fs-read-arena-monotonic",
			program: nativeParityCore(`fn load()->u64{let a:bytes=read_file("first.txt");let b:bytes=read_file("second.txt");return bytes_get(a,0)+bytes_get(b,0);}`, "load", "-allow-fs-read"),
			files:   map[string]string{"first.txt": "A", "second.txt": "B"},
			runs:    []nativeParityRun{nativeParityExit('A' + 'B')},
		},
		{
			name:    "core/fs-read-oversized",
			program: nativeParityCore(`fn load()->u64{let b:bytes=read_file("large.bin");return bytes_len(b);}`, "load", "-allow-fs-read"),
			files:   map[string]string{"large.bin": strings.Repeat("\x00", coreir.DefaultProcessRuntimeArenaBytes)},
			runs:    []nativeParityRun{nativeParityExit(1)},
		},
		{name: "core/fs-read-missing-file", program: nativeParityCore(`fn load()->u64{let b:bytes=read_file("absent.txt");return bytes_len(b);}`, "load", "-allow-fs-read"), runs: []nativeParityRun{nativeParityExit(1)}},
		{name: "core/print-i64", program: nativeParityCore("fn emit(x:i64)->i64{print(x);return x;} fn answer(x:i64)->i64{return emit(x);}", "answer"), runs: []nativeParityRun{
			nativeParityPrints(42, "42\n", "42"), nativeParityPrints(0, "0\n", "0"),
		}},
		{name: "core/print-negative-i64", program: nativeParityCore("fn show(x:i64)->i64{print(x);return 0;}", "show"), runs: []nativeParityRun{
			nativeParityPrints(0, "-9223372036854775808\n", minI64), nativeParityPrints(0, "-1\n", "-1"),
		}},
		{name: "core/print-u64", program: nativeParityCore("fn show(x:u64)->u64{print(x);return 0;}", "show"), runs: []nativeParityRun{
			nativeParityPrints(0, maxU64+"\n", maxU64),
		}},
		{name: "core/print-bool", program: nativeParityCore("fn show(x:bool)->i64{print(x);return 0;}", "show"), runs: []nativeParityRun{
			nativeParityPrints(0, "true\n", "true"), nativeParityPrints(0, "false\n", "false"),
		}},
		{name: "core/stdout-stderr", program: nativeParityCore("fn show(x:i64)->i64{print(x);eprint(x);return 0;}", "show"), runs: []nativeParityRun{
			{args: []string{"42"}, stdout: nativeParityText("42\n"), stderr: nativeParityText("42\n")},
		}},
		{name: "core/print-ieee64", program: nativeParityCore("fn show(x:ieee64)->i64{print(x);return 0;}", "show"), runs: []nativeParityRun{
			nativeParityPrints(0, "0x1.8000000000000p+0\n", "1.5"), nativeParityPrints(0, "-0x1.2000000000000p+1\n", "-2.25"),
			nativeParityPrints(0, "0x0p+0\n", "0"), nativeParityPrints(0, "-0x0p+0\n", "-0"),
			nativeParityPrints(0, "0x1.9000000000000p+6\n", "100"),
		}},
		{name: "core/ieee64-streams", program: nativeParityCore("fn show(x:ieee64)->i64{print(x);eprint(x);return 0;}", "show"), runs: []nativeParityRun{
			{args: []string{"1.5"}, stdout: nativeParityText("0x1.8000000000000p+0\n"), stderr: nativeParityText("0x1.8000000000000p+0\n")},
		}},
	}
	special := "fn tiny()->i64{let x:ieee64=5e-324;print(x);return 0;} " +
		"fn pinf()->i64{let one:ieee64=1;let zero:ieee64=0;print(one/zero);return 0;} " +
		"fn ninf()->i64{let one:ieee64=-1;let zero:ieee64=0;print(one/zero);return 0;} " +
		"fn qnan()->i64{let zero:ieee64=0;print(zero/zero);return 0;}"
	for _, tc := range []struct{ entry, want string }{
		{"tiny", "0x0.0000000000001p-1022\n"}, {"pinf", "inf\n"}, {"ninf", "-inf\n"}, {"qnan", "nan\n"},
	} {
		cases = append(cases, nativeParityCase{
			name:    "core/print-ieee64-" + tc.entry,
			program: nativeParityCore(special, tc.entry),
			runs:    []nativeParityRun{nativeParityPrints(0, tc.want)},
		})
	}
	cases = append(cases, nativeParityOracleCases()...)
	return append(cases, nativeParityHIRCases()...)
}

// nativeParityOracleCases are differential: the expected exit status of every
// run comes from the Core reference interpreter, so checked arithmetic, traps,
// loops, spills and calls must agree with Core semantics on every target.
func nativeParityOracleCases() []nativeParityCase {
	const minI64, maxI64, maxU64 = "-9223372036854775808", "9223372036854775807", "18446744073709551615"
	oracle := func(name, source, entry string, argSets ...[]string) nativeParityCase {
		runs := make([]nativeParityRun, len(argSets))
		for i, args := range argSets {
			runs[i] = nativeParityRun{args: args}
		}
		return nativeParityCase{name: "oracle/" + name, program: nativeParityCore(source, entry), runs: runs, oracle: true}
	}
	return []nativeParityCase{
		oracle("i64-add", "fn f(x:i64,y:i64)->i64{return x+y;}", "f",
			[]string{"20", "22"}, []string{maxI64, "1"}, []string{minI64, "-1"}, []string{"-50", "8"}),
		oracle("i64-sub", "fn f(x:i64,y:i64)->i64{return x-y;}", "f",
			[]string{"50", "8"}, []string{minI64, "1"}, []string{maxI64, "-1"}, []string{"8", "50"}),
		oracle("i64-mul", "fn f(x:i64,y:i64)->i64{return x*y;}", "f",
			[]string{"6", "7"}, []string{maxI64, "2"}, []string{minI64, "-1"}, []string{"4294967296", "4294967296"}, []string{"-6", "7"}),
		oracle("i64-div", "fn f(x:i64,y:i64)->i64{return x/y;}", "f",
			[]string{"85", "2"}, []string{"-85", "-2"}, []string{"-85", "2"}, []string{"1", "0"}, []string{minI64, "-1"}),
		oracle("i64-rem", "fn f(x:i64,y:i64)->i64{return x%y;}", "f",
			[]string{"47", "5"}, []string{"47", "-5"}, []string{"-47", "5"}, []string{"1", "0"}, []string{minI64, "-1"}),
		oracle("i64-neg", "fn f(x:i64)->i64{return -x;}", "f", []string{"-42"}, []string{minI64}, []string{"42"}),
		oracle("u64-add", "fn f(x:u64,y:u64)->u64{return x+y;}", "f", []string{"200", "55"}, []string{maxU64, "1"}),
		oracle("u64-sub", "fn f(x:u64,y:u64)->u64{return x-y;}", "f", []string{"50", "8"}, []string{"1", "2"}),
		oracle("u64-mul", "fn f(x:u64,y:u64)->u64{return x*y;}", "f", []string{"6", "7"}, []string{"4294967296", "4294967296"}),
		oracle("u64-div-rem", "fn f(x:u64,y:u64)->u64{return x/y+x%y;}", "f", []string{"100", "7"}, []string{"1", "0"}),
		oracle("loop-collatz", "fn f(n:u64)->u64{let m:u64=n;let steps:u64=0;while m!=1{if m%2==0{m=m/2;}else{m=3*m+1;}steps=steps+1;}return steps;}", "f",
			[]string{"27"}, []string{"1"}, []string{"97"}),
		oracle("spill-pressure", nativeParitySpillSource(), "spill", []string{"3", "5"}, []string{"-7", "11"}),
		oracle("spill-across-call", nativeParitySpillAcrossCallSource(), "f", []string{"3", "5"}, []string{"-7", "11"}),
		oracle("ieee64-spill-pressure", nativeParityFPSpillSource(), "fspill", []string{"1.5", "2.25"}, []string{"-0.5", "4.0"}),
		// Callees contain loops so the optimizer keeps them as real native calls.
		oracle("scalar-calls", "fn g(a:i64,b:i64,c:i64,d:i64)->i64{let s:i64=0;let i:i64=0;while i<4{s=s+a*8+b*4+c*2+d;i=i+1;}return s;} fn f(a:i64,b:i64,c:i64,d:i64)->i64{return g(d,c,b,a)-g(a,b,c,d);}", "f",
			[]string{"1", "2", "3", "4"}, []string{"9", "0", "1", "1"}),
		oracle("ieee64-arith", "fn f(x:ieee64,y:ieee64)->bool{let z:ieee64=x*y+x/y-y;return z>10.5;}", "f",
			[]string{"5.0", "2.5"}, []string{"3.5", "2.0"}),
		// Exact-result probes: if a backend let the destination clobber the
		// right operand, sub/div/add/mul would yield 0, 1, 2a or a*a instead.
		oracle("ieee64-sub-exact", "fn f(x:ieee64,y:ieee64)->bool{let m:ieee64=x*y;let z:ieee64=m-y;return z==10.0;}", "f",
			[]string{"5.0", "2.5"}, []string{"4.0", "2.5"}),
		oracle("ieee64-div-exact", "fn f(x:ieee64,y:ieee64)->bool{let m:ieee64=x*y;let z:ieee64=m/y;return z==5.0;}", "f",
			[]string{"5.0", "2.5"}, []string{"4.0", "2.5"}),
		oracle("ieee64-add-exact", "fn f(x:ieee64,y:ieee64)->bool{let m:ieee64=x*3.0;let z:ieee64=m+y;return z==17.5;}", "f",
			[]string{"5.0", "2.5"}, []string{"4.0", "2.5"}),
		oracle("ieee64-mul-exact", "fn f(x:ieee64,y:ieee64)->bool{let m:ieee64=x+1.0;let z:ieee64=m*y;return z==15.0;}", "f",
			[]string{"5.0", "2.5"}, []string{"4.0", "2.5"}),
		oracle("mixed-call", "fn h(a:i64,x:ieee64,b:i64,y:ieee64)->i64{let i:i64=0;let r:i64=b;while i<2{if x>y{r=a;}i=i+1;}return r;} fn f(a:i64,x:ieee64,b:i64,y:ieee64)->i64{return h(a,x,b,y)+1;}", "f",
			[]string{"7", "2.5", "9", "1.5"}, []string{"7", "0.5", "9", "1.5"}),
	}
}

func nativeParityHIRCases() []nativeParityCase {
	hir := func(name string, modules map[string]string, runs ...nativeParityRun) nativeParityCase {
		return nativeParityCase{name: "hir/" + name, program: nativeParityHIR("run", modules), runs: runs}
	}
	pairStruct := "struct Pair { a: u64; b: i64; }\n"
	nested := "struct Inner { value: i64; code: u64; }\nstruct Outer { inner: Inner; ratio: ieee64; }\n"
	cases := []nativeParityCase{
		hir("imported-call", map[string]string{
			"app/main.swyp": "module app.main;\nuse lib.math;\nfn run(x: i64) -> i64 { return lib.math.square(x); }",
			"lib/math.swyp": "module lib.math;\nfn square(x: i64) -> i64 { return x * x; }",
		}, nativeParityExit(81, "9")),
		hir("fixed-array-constant-index", nativeParityApp(`fn run() -> i64 {
    let xs: array<i64,3> = [5,7,9];
    return xs[1];
}`), nativeParityExit(7)),
		hir("fixed-array-dynamic-index", nativeParityApp(`fn run(i: u64) -> i64 {
    let xs: array<i64,3> = [5,7,9];
    return xs[i];
}`), nativeParityExit(9, "2"), nativeParityExit(5, "0"), nativeParityExit(1, "3")),
		hir("fixed-slice-dynamic-index", nativeParityApp(`fn run(i: u64) -> i64 {
    let xs: array<i64,4> = [5,7,9,11];
    let s = xs[1:4];
    return s[i];
}`), nativeParityExit(11, "2"), nativeParityExit(1, "3")),
		hir("dynamic-slice-range", nativeParityApp(`fn run(start: u64, end: u64, i: u64) -> i64 {
    let xs: array<i64,4> = [5,7,9,11];
    let s = xs[start:end];
    return s[i];
}`), nativeParityExit(9, "1", "4", "1"), nativeParityExit(1, "3", "2", "0"), nativeParityExit(1, "0", "5", "0")),
		hir("local-mutable-ref", nativeParityApp(`fn run(x: u64) -> u64 {
    let r = &mut x;
    store(r, 7);
    drop(r);
    return x;
}`), nativeParityExit(7, "1")),
		hir("fixed-struct-projection", nativeParityApp(`struct Point { x: i64; y: i64; }
fn run() -> i64 {
    let p = new Point { x: 5, y: 7 };
    return p.y;
}`), nativeParityExit(7)),
		hir("known-option-match", nativeParityApp(`fn run() -> u64 {
    let value: option<u64> = some(7);
    return match value { None => 0, Some(x) => x, };
}`), nativeParityExit(7)),
		hir("storage-array", nativeParityApp(`fn run() -> u64 {
    let xs: array<u64,65> = [`+nativeParityNumbers(65, "")+`];
    return xs[64];
}`), nativeParityExit(64)),
		{
			name: "hir/storage-and-fs-read-arenas",
			program: nativeParityHIR("run", nativeParityApp(`fn run() -> u64 {
    let xs: array<u64,65> = [`+nativeParityNumbers(65, "")+`];
    let data: bytes = read_file("probe.txt");
    let n: u64 = bytes_len(data);
    if n == 1 { return xs[64]; }
    return 1;
}`), "-allow-fs-read"),
			files: map[string]string{"probe.txt": "x"},
			runs:  []nativeParityRun{nativeParityExit(64)},
		},
		{
			name: "hir/imported-fs-write",
			program: nativeParityHIR("run", map[string]string{
				"app/main.swyp": "module app.main;\nuse lib.fs;\nfn run() -> i64 { return lib.fs.save(); }",
				"lib/fs.swyp":   "module lib.fs;\nfn save() -> i64 { write_file(\"hir-native-capability.tmp\", \"x\"); return 0; }",
			}, "-allow-fs-write"),
			runs:   []nativeParityRun{nativeParityExit(0)},
			verify: nativeParityFileEquals("hir-native-capability.tmp", "x"),
		},
		hir("vec", nativeParityApp(`fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let x: u64 = v[1];
    drop(v);
    return x;
}`), nativeParityExit(20)),
		hir("vec-slice-view", nativeParityApp(`fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30, 40];
    let s: slice<u64> = v[1:4];
    let x: u64 = s[1];
    drop(s);
    drop(v);
    return x;
}`), nativeParityExit(30)),
		hir("vec-ref", nativeParityApp(`fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let r = &mut v[1];
    store(r, 25);
    let x: u64 = *r;
    drop(r);
    drop(v);
    return x;
}`), nativeParityExit(25)),
		hir("vec-ref-dynamic", nativeParityApp(`fn run(i: u64) -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let r = &mut v[i];
    store(r, 26);
    let x: u64 = *r;
    drop(r);
    drop(v);
    return x;
}`), nativeParityExit(26, "2"), nativeParityExit(1, "3")),
		hir("vec-len-capacity", nativeParityApp(`fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let n: u64 = vec_len(v);
    let c: u64 = vec_capacity(v);
    drop(v);
    return n + c;
}`), nativeParityExit(6)),
		hir("vec-push-growth", nativeParityApp(`fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    vec_push(v, 40);
    vec_push(v, 50);
    let x: u64 = v[4];
    let n: u64 = vec_len(v);
    let c: u64 = vec_capacity(v);
    drop(v);
    return x + n + c;
}`), nativeParityExit(61)),
		hir("vec-push-across-if", nativeParityApp(`fn run(flag: u64) -> u64 {
    let v: vec<u64> = [10];
    if flag == 1 { vec_push(v, 20); }
    let n: u64 = vec_len(v);
    drop(v);
    return n;
}`), nativeParityExit(1, "0"), nativeParityExit(2, "1")),
		hir("vec-push-across-loop", nativeParityApp(`fn run(n: u64) -> u64 {
    let v: vec<u64> = [10];
    let i: u64 = 0;
    while i < n {
        vec_push(v, i);
        i = i + 1;
    }
    let result: u64 = vec_len(v);
    drop(v);
    return result;
}`), nativeParityExit(4, "3"), nativeParityExit(41, "40")),
		hir("vec-function-abi", nativeParityApp(`fn consume(v: vec<u64>) -> u64 {
    let n: u64 = vec_len(v);
    let x: u64 = v[2];
    drop(v);
    return n + x;
}
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    return consume(v);
}`), nativeParityExit(33)),
		hir("vec-module-abi", map[string]string{
			"app/main.swyp": `module app.main;
use lib.vec;
fn run() -> u64 {
    let v: vec<u64> = [7, 8, 9];
    return lib.vec.consume(v);
}`,
			"lib/vec.swyp": `module lib.vec;
fn consume(v: vec<u64>) -> u64 {
    let n: u64 = vec_len(v);
    let x: u64 = v[1];
    drop(v);
    return n + x;
}`,
		}, nativeParityExit(11)),
		hir("vec-i64-storage-abi", nativeParityApp(`fn consume(v: vec<i64>) -> i64 {
    vec_push(v, -5);
    let r = &mut v[0];
    store(r, -7);
    let x: i64 = *r;
    drop(r);
    let y: i64 = v[3];
    drop(v);
    return y - x;
}
fn run() -> i64 {
    let v: vec<i64> = [-10, 20, 30];
    return consume(v);
}`), nativeParityExit(2)),
		hir("large-i64-array-slice-ref", nativeParityApp(`fn run() -> i64 {
    let xs: array<i64,65> = [`+nativeParityNumbers(65, "-7")+`];
    let r = &mut xs[64];
    store(r, -9);
    let a: i64 = *r;
    drop(r);
    let s: slice<i64> = xs[60:65];
    let b: i64 = s[4];
    drop(s);
    return a - b + 3;
}`), nativeParityExit(3)),
		hir("vec-ieee64-storage-abi", nativeParityApp(`fn consume(v: vec<ieee64>) -> bool {
    vec_push(v, -3.5);
    let r = &mut v[0];
    store(r, 4.5);
    let x: ieee64 = *r;
    drop(r);
    let y: ieee64 = v[3];
    drop(v);
    return x + y == 1.0;
}
fn run() -> bool {
    let v: vec<ieee64> = [1.5, 2.5, 3.5];
    return consume(v);
}`), nativeParityExit(1)),
		hir("vec-return-abi", nativeParityApp(`fn make() -> vec<u64> {
    let v: vec<u64> = [10, 20, 30];
    return v;
}
fn run() -> u64 {
    let v: vec<u64> = make();
    let n: u64 = vec_len(v);
    let x: u64 = v[2];
    drop(v);
    return n + x;
}`), nativeParityExit(33)),
		hir("vec-return-module-abi", map[string]string{
			"app/main.swyp": `module app.main;
use lib.vec;
fn run() -> u64 {
    let v: vec<u64> = lib.vec.make();
    let x: u64 = v[1];
    drop(v);
    return x;
}`,
			"lib/vec.swyp": `module lib.vec;
fn make() -> vec<u64> {
    let v: vec<u64> = [7, 8, 9];
    return v;
}`,
		}, nativeParityExit(8)),
		hir("defer-drop-early-return", nativeParityApp(`fn run(flag: u64) -> u64 {
    let v: vec<u64> = [10, 20];
    defer_drop(v);
    if flag == 1 { return v[1]; }
    vec_push(v, 30);
    return v[2];
}`), nativeParityExit(20, "1"), nativeParityExit(30, "0")),
		hir("flat-struct-vec-abi", nativeParityApp(`struct Pair { a: u64; b: u64; }
fn make() -> vec<Pair> {
    let v: vec<Pair> = [new Pair { a: 10, b: 20 }, new Pair { a: 30, b: 40 }];
    return v;
}
fn consume(v: vec<Pair>) -> u64 {
    let first: u64 = v[0].b;
    vec_push(v, new Pair { a: 50, b: 60 });
    let last: u64 = v[2].b;
    let n: u64 = vec_len(v);
    drop(v);
    return first + last + n;
}
fn run() -> u64 {
    let v: vec<Pair> = make();
    return consume(v);
}`), nativeParityExit(83)),
		hir("cross-module-struct-vec", map[string]string{
			"app/main.swyp": `module app.main;
use lib.types;
fn run() -> u64 {
    let v: vec<lib.types.Pair> = lib.types.make();
    let x: u64 = v[1].b;
    drop(v);
    return x;
}`,
			"lib/types.swyp": `module lib.types;
struct Pair { a: u64; b: u64; }
fn make() -> vec<Pair> {
    let v: vec<Pair> = [new Pair { a: 7, b: 8 }, new Pair { a: 9, b: 42 }];
    return v;
}`,
		}, nativeParityExit(42)),
		hir("mixed-raw64-struct-vec", nativeParityApp(`struct Sample { signed: i64; ratio: ieee64; code: u64; }
fn run() -> bool {
    let v: vec<Sample> = [new Sample { signed: -7, ratio: 2.5, code: 9 }];
    let a: i64 = v[0].signed;
    let b: ieee64 = v[0].ratio;
    let c: u64 = v[0].code;
    drop(v);
    return a == -7 && b == 2.5 && c == 9;
}`), nativeParityExit(1)),
		hir("struct-vec-field-ref", nativeParityApp(pairStruct+`fn run() -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let r = &mut v[1].b;
    store(r, -9);
    let x: i64 = *r;
    drop(r);
    let y: i64 = v[1].b;
    drop(v);
    return x == -9 && y == -9;
}`), nativeParityExit(1)),
		hir("struct-vec-field-ref-dynamic", nativeParityApp(pairStruct+`fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let r = &mut v[i].b;
    store(r, -11);
    let x: i64 = *r;
    drop(r);
    let y: i64 = v[i].b;
    drop(v);
    return x == -11 && y == -11;
}`), nativeParityExit(1, "0"), nativeParityExit(1, "1")),
		hir("struct-element-copy", nativeParityApp(pairStruct+`fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let p: Pair = v[i];
    let a: u64 = p.a;
    let b: i64 = p.b;
    drop(v);
    return (i == 0 && a == 10 && b == -2) || (i == 1 && a == 20 && b == 4);
}`), nativeParityExit(1, "0"), nativeParityExit(1, "1")),
		hir("struct-slice-view", nativeParityApp(pairStruct+`fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let direct: i64 = s[i].b;
    let p: Pair = s[i];
    let copied: i64 = p.b;
    drop(s);
    drop(v);
    return (i == 0 && direct == 4 && copied == 4) || (i == 1 && direct == 8 && copied == 8);
}`), nativeParityExit(1, "0"), nativeParityExit(1, "1")),
		hir("struct-slice-shared-ref", nativeParityApp(pairStruct+`fn run(i: u64) -> i64 {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let r = &s[i].b;
    let x: i64 = *r;
    drop(r);
    drop(s);
    drop(v);
    return x;
}`), nativeParityExit(4, "0"), nativeParityExit(8, "1")),
		hir("struct-slice-oob", nativeParityApp(`struct Pair { a: u64; b: u64; }
fn run(i: u64) -> u64 {
    let v: vec<Pair> = [new Pair { a: 10, b: 4 }, new Pair { a: 20, b: 8 }, new Pair { a: 30, b: 12 }];
    let s: slice<Pair> = v[1:3];
    let x: u64 = s[i].b;
    drop(s);
    drop(v);
    return x;
}`), nativeParityExit(8, "0"), nativeParityExit(12, "1"), nativeParityExit(1, "2")),
		hir("nested-struct-vec", nativeParityApp(nested+`fn run() -> bool {
    let v: vec<Outer> = [
        new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 1.5 },
        new Outer { inner: new Inner { value: 4, code: 2 }, ratio: 2.5 }
    ];
    vec_push(v, new Outer { inner: new Inner { value: 12, code: 3 }, ratio: 3.5 });
    let before: i64 = v[1].inner.value;
    let copied: Outer = v[1];
    let copied_before: i64 = copied.inner.value;
    let local: Outer = new Outer { inner: new Inner { value: -7, code: 99 }, ratio: 9.5 };
    let local_value: i64 = local.inner.value;
    let local_ref = &mut copied.inner.value;
    store(local_ref, -6);
    let copied_after: i64 = *local_ref;
    drop(local_ref);
    let r = &mut v[1].inner.value;
    store(r, -9);
    let after: i64 = *r;
    drop(r);
    let pushed: i64 = v[2].inner.value;
    let ratio: ieee64 = v[2].ratio;
    drop(v);
    return before == 4 && copied_before == 4 && copied_after == -6 && local_value == -7 && after == -9 && pushed == 12 && ratio == 3.5;
}`), nativeParityExit(1)),
		hir("nested-struct-slice", nativeParityApp(nested+`fn run(i: u64) -> bool {
    let v: vec<Outer> = [
        new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 1.5 },
        new Outer { inner: new Inner { value: 4, code: 2 }, ratio: 2.5 },
        new Outer { inner: new Inner { value: 8, code: 3 }, ratio: 3.5 }
    ];
    let s: slice<Outer> = v[1:3];
    let direct: i64 = s[i].inner.value;
    let copied: Outer = s[i];
    let copied_value: i64 = copied.inner.value;
    let r = &s[i].inner.value;
    let via_ref: i64 = *r;
    drop(r);
    drop(s);
    drop(v);
    return (i == 0 && direct == 4 && copied_value == 4 && via_ref == 4) || (i == 1 && direct == 8 && copied_value == 8 && via_ref == 8);
}`), nativeParityExit(1, "0"), nativeParityExit(1, "1")),
		hir("defer-drop-parameter", nativeParityApp(`fn consume(v: vec<u64>) -> u64 {
    defer_drop(v);
    vec_push(v, 40);
    return vec_len(v);
}
fn run() -> u64 {
    let v: vec<u64> = [10,20,30];
    return consume(v);
}`), nativeParityExit(4)),
	}
	return append(cases, boolStorageParityCases()...)
}

type nativeParityCustomCase struct {
	name string
	run  func(t *testing.T, target nativeParityTarget, dir string)
}

// Custom cases need host-side state (loopback servers, nondeterministic values
// or special paths); they run sequentially to avoid ephemeral-port reuse races.
func nativeParityCustomCases() []nativeParityCustomCase {
	return []nativeParityCustomCase{
		{name: "core/executable-path-with-spaces", run: func(t *testing.T, target nativeParityTarget, dir string) {
			spaced := filepath.Join(dir, "directory with spaces")
			if err := os.MkdirAll(spaced, 0o700); err != nil {
				t.Fatal(err)
			}
			program := nativeParityCore("fn add(x:i64,y:i64)->i64{return x+y;}", "add")
			program.output = "add with spaces"
			exe := target.build(t, spaced, program)
			if got := target.run(t, spaced, exe, "19", "23"); got.exit != 42 {
				t.Fatalf("exit=%d (%v) want=42", got.exit, got.err)
			}
		}},
		{name: "core/clock", run: func(t *testing.T, target nativeParityTarget, dir string) {
			exe := target.build(t, dir, nativeParityCore("fn now()->u64{let t:u64=clock();print(t);return 0;}", "now"))
			got := target.run(t, dir, exe)
			value, err := strconv.ParseUint(strings.TrimSuffix(got.stdout, "\n"), 10, 64)
			if got.exit != 0 || err != nil || value == 0 || !strings.HasSuffix(got.stdout, "\n") || got.stderr != "" {
				t.Fatalf("clock exit=%d stdout=%q stderr=%q parse=%v", got.exit, got.stdout, got.stderr, err)
			}
			monotonic := t.TempDir()
			exe = target.build(t, monotonic, nativeParityCore("fn check()->bool{let a:u64=clock();let b:u64=clock();return b>=a;}", "check"))
			if got := target.run(t, monotonic, exe); got.exit != 1 {
				t.Fatalf("monotonic clock exit=%d (%v) want=1", got.exit, got.err)
			}
		}},
		{name: "core/random", run: func(t *testing.T, target nativeParityTarget, dir string) {
			exe := target.build(t, dir, nativeParityCore("fn sample()->u64{let x:u64=random();print(x);return 0;}", "sample"))
			seen := map[string]bool{}
			for i := 0; i < 3; i++ {
				got := target.run(t, dir, exe)
				if _, err := strconv.ParseUint(strings.TrimSuffix(got.stdout, "\n"), 10, 64); got.exit != 0 || err != nil || got.stderr != "" {
					t.Fatalf("random exit=%d stdout=%q stderr=%q parse=%v", got.exit, got.stdout, got.stderr, err)
				}
				seen[got.stdout] = true
			}
			if len(seen) < 2 {
				t.Fatalf("three random() processes produced %d distinct values: %v", len(seen), seen)
			}
		}},
		{name: "core/tcp-connect-loopback", run: func(t *testing.T, target nativeParityTarget, dir string) {
			listener, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			accepted := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err == nil {
					_ = conn.Close()
				}
				accepted <- err
			}()
			// 7 = connected and 9 = refused keep both outcomes distinct from
			// the backend-failure exit status 1.
			exe := target.build(t, dir, nativeParityCore(fmt.Sprintf(`fn ping()->u64{if tcp_connect("127.0.0.1",%d){return 7;}return 9;}`, port), "ping", "-allow-net-connect"))
			if got := target.run(t, dir, exe); got.exit != 7 {
				_ = listener.Close()
				t.Fatalf("connected exit=%d (%v) stderr=%q want=7", got.exit, got.err, got.stderr)
			}
			if err := nativeParityAwait(t, accepted, "listener accept"); err != nil {
				t.Fatalf("listener accept: %v", err)
			}
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			if got := target.run(t, dir, exe); got.exit != 9 {
				t.Fatalf("refused exit=%d (%v) stderr=%q want=9", got.exit, got.err, got.stderr)
			}
		}},
		{name: "core/tcp-connect-invalid-endpoint", run: func(t *testing.T, target nativeParityTarget, dir string) {
			for _, tc := range []struct {
				host string
				port uint64
			}{{"localhost", 80}, {"127.0.0.1", 0}, {"127.0.0.1", 65536}, {"256.0.0.1", 80}, {"127.0.0.1x", 80}, {"1.2.3", 80}, {"1.2.3.4.5", 80}} {
				sub := t.TempDir()
				exe := target.build(t, sub, nativeParityCore(fmt.Sprintf(`fn ping()->u64{if tcp_connect(%q,%d){return 7;}return 9;}`, tc.host, tc.port), "ping", "-allow-net-connect"))
				if got := target.run(t, sub, exe); got.exit != 1 {
					t.Fatalf("host=%q port=%d exit=%d (%v) stderr=%q want=1 backend failure", tc.host, tc.port, got.exit, got.err, got.stderr)
				}
			}
		}},
		{name: "core/http-fetch-loopback", run: func(t *testing.T, target nativeParityTarget, dir string) {
			response := "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
			port, requests, done := nativeParityHTTPServer(t, []byte(response))
			exe := target.build(t, dir, nativeParityCore(fmt.Sprintf(`fn load()->u64{let b:bytes=http_fetch("127.0.0.1",%d,"/health");return bytes_len(b);}`, port), "load", "-allow-net-fetch"))
			if got := target.run(t, dir, exe); got.exit != len(response) {
				t.Fatalf("fetch exit=%d (%v) stderr=%q want=%d", got.exit, got.err, got.stderr, len(response))
			}
			if err := nativeParityAwait(t, done, "loopback server"); err != nil {
				t.Fatalf("loopback server: %v", err)
			}
			request := <-requests
			if !strings.HasPrefix(request, "GET /health HTTP/1.1\r\n") || !strings.Contains(request, "\r\nHost: 127.0.0.1\r\n") || !strings.HasSuffix(request, "\r\nConnection: close\r\n\r\n") {
				t.Fatalf("request=%q", request)
			}
		}},
		{name: "core/http-fetch-invalid-policy", run: func(t *testing.T, target nativeParityTarget, dir string) {
			for _, tc := range []struct {
				host string
				port uint64
				path string
			}{{"localhost", 80, "/"}, {"127.0.0.1", 0, "/"}, {"127.0.0.1", 65536, "/"}, {"127.0.0.1", 80, "health"}, {"127.0.0.1", 80, "/bad path"}, {"127.0.0.1x", 80, "/"}, {"1.2.3", 80, "/"}} {
				sub := t.TempDir()
				exe := target.build(t, sub, nativeParityCore(fmt.Sprintf(`fn load()->u64{let b:bytes=http_fetch(%q,%d,%q);return bytes_len(b);}`, tc.host, tc.port, tc.path), "load", "-allow-net-fetch"))
				if got := target.run(t, sub, exe); got.exit != 1 {
					t.Fatalf("host=%q port=%d path=%q exit=%d (%v) want=1", tc.host, tc.port, tc.path, got.exit, got.err)
				}
			}
		}},
		{name: "core/http-fetch-oversized-response", run: func(t *testing.T, target nativeParityTarget, dir string) {
			payload := bytes.Repeat([]byte{'x'}, coreir.DefaultProcessRuntimeArenaBytes+1024)
			port, requests, done := nativeParityHTTPServer(t, payload)
			exe := target.build(t, dir, nativeParityCore(fmt.Sprintf(`fn load()->u64{let b:bytes=http_fetch("127.0.0.1",%d,"/");return bytes_len(b);}`, port), "load", "-allow-net-fetch"))
			if got := target.run(t, dir, exe); got.exit != 1 {
				t.Fatalf("oversized fetch exit=%d (%v) stderr=%q want=1", got.exit, got.err, got.stderr)
			}
			// The client must really have connected and sent its request;
			// otherwise exit 1 would not prove the overflow guard.
			select {
			case <-requests:
			case <-time.After(15 * time.Second):
				t.Fatal("oversized fetch exited without sending a request")
			}
			if err := nativeParityAwait(t, done, "loopback server"); err != nil {
				// A reset or broken pipe is expected once the bounded client
				// observes overflow and closes its side of the socket.
				message := strings.ToLower(err.Error())
				if !strings.Contains(message, "reset") && !strings.Contains(message, "broken pipe") && !strings.Contains(message, "aborted") {
					t.Fatalf("loopback server: %v", err)
				}
			}
		}},
	}
}

// nativeParityAwait bounds every wait on loopback helpers so a native program
// that never connects fails the test instead of hanging it.
func nativeParityAwait(t *testing.T, ch <-chan error, what string) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(15 * time.Second):
		t.Fatalf("%s: no connection completed within 15s", what)
		return nil
	}
}

// nativeParityHTTPServer serves exactly one loopback connection: it reads the
// request head, publishes it, writes response and reports the write result.
func nativeParityHTTPServer(t *testing.T, response []byte) (int, <-chan string, <-chan error) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	requests := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
		buf := make([]byte, 4096)
		n := 0
		for n < len(buf) {
			read, readErr := conn.Read(buf[n:])
			n += read
			if bytes.Contains(buf[:n], []byte("\r\n\r\n")) {
				break
			}
			if readErr != nil {
				done <- readErr
				return
			}
		}
		requests <- string(buf[:n])
		_, err = conn.Write(response)
		done <- err
	}()
	return listener.Addr().(*net.TCPAddr).Port, requests, done
}
