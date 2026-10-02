package main

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
	"swyp-lang/internal/hircore"
)

func boolStorageParityCases() []nativeParityCase {
	hir := func(name string, modules map[string]string, runs ...nativeParityRun) nativeParityCase {
		for path, source := range modules {
			if strings.Contains(source, "fn ") {
				modules[path] = source + "\nfn same(a: bool, b: bool) -> bool { return (a && b) || (!a && !b); }"
			}
		}
		return nativeParityCase{name: "hir/bool-" + name, program: nativeParityHIR("run", modules), runs: runs, oracle: true}
	}
	max := strconv.FormatUint(^uint64(0), 10)
	booleans := make([]string, 65)
	for i := range booleans {
		booleans[i] = strconv.FormatBool(i%2 == 0)
	}
	booleans[64] = "flag"
	return []nativeParityCase{
		hir("vec-index", nativeParityApp(`fn run(i: u64, flag: bool) -> u64 {
    let v: vec<bool> = [false, flag, true];
    let x: bool = v[i];
    drop(v);
    if x { return 23; }
    return 17;
}`), nativeParityExit(17, "0", "true"), nativeParityExit(17, "1", "false"),
			nativeParityExit(23, "1", "true"), nativeParityExit(23, "2", "false"),
			nativeParityExit(1, "3", "true"), nativeParityExit(1, max, "false")),
		hir("vec-growth-cfg", nativeParityApp(`fn run(flag: bool) -> u64 {
    let v: vec<bool> = [];
    defer_drop(v);
    vec_push(v, flag);
    vec_push(v, !flag);
    if flag { vec_push(v, false); } else { vec_push(v, true); }
    let i: u64 = 0;
    while i < 3 {
        vec_push(v, i % 2 == 0);
        i = i + 1;
    }
    let s: slice<bool> = v[3:6];
    let a: bool = s[0];
    let b: bool = s[1];
    let c: bool = s[2];
    drop(s);
    let n: u64 = vec_len(v);
    let capacity: u64 = vec_capacity(v);
    if n == 6 && capacity == 8 && same(v[0], flag) && same(v[1], !flag) && same(v[2], !flag) && a && !b && c {
        return 43;
    }
    return 19;
}`), nativeParityExit(43, "true"), nativeParityExit(43, "false")),
		hir("vec-module-abi", map[string]string{
			"app/main.swyp": `module app.main;
use lib.flags;
fn run(flag: bool) -> u64 {
    let v: vec<bool> = lib.flags.make(flag);
    return lib.flags.consume(v, flag);
}`,
			"lib/flags.swyp": `module lib.flags;
fn make(flag: bool) -> vec<bool> {
    let v: vec<bool> = [flag, false];
    vec_push(v, true);
    return v;
}
fn consume(v: vec<bool>, flag: bool) -> u64 {
    defer_drop(v);
    vec_push(v, false);
    let r = &mut v[0];
    store(r, !flag);
    let a: bool = *r;
    drop(r);
    let shared_ref = &v[2];
    let b: bool = *shared_ref;
    drop(shared_ref);
    let n: u64 = vec_len(v);
    let capacity: u64 = vec_capacity(v);
    if same(a, !flag) && !v[1] && b && !v[3] && n == 4 && capacity == 4 { return 67; }
    return 19;
}`,
		}, nativeParityExit(67, "true"), nativeParityExit(67, "false")),
		hir("vec-ref", nativeParityApp(`fn run(i: u64, flag: bool) -> u64 {
    let v: vec<bool> = [true, false];
    let r = &mut v[i];
    store(r, flag);
    let a: bool = *r;
    drop(r);
    let shared_ref = &v[i];
    let b: bool = *shared_ref;
    drop(shared_ref);
    let c: bool = v[i];
    drop(v);
    if same(a, flag) && same(b, flag) && same(c, flag) { return 29; }
    return 19;
}`), nativeParityExit(29, "0", "false"), nativeParityExit(29, "1", "true"),
			nativeParityExit(1, "2", "false"), nativeParityExit(1, max, "true")),
		hir("vec-slice-bounds", nativeParityApp(`fn run(start: u64, end: u64, i: u64, flag: bool) -> u64 {
    let v: vec<bool> = [false, flag, true];
    let s: slice<bool> = v[start:end];
    let x: bool = s[i];
    drop(s);
    drop(v);
    if x { return 31; }
    return 29;
}`), nativeParityExit(29, "1", "3", "0", "false"), nativeParityExit(31, "1", "3", "0", "true"),
			nativeParityExit(31, "1", "3", "1", "false"), nativeParityExit(1, "1", "3", "2", "true"),
			nativeParityExit(1, "2", "1", "0", "false"), nativeParityExit(1, "0", "4", "0", "false"),
			nativeParityExit(1, "1", "1", "0", "false"), nativeParityExit(1, "0", max, "0", "true"),
			nativeParityExit(1, "0", "3", max, "true")),
		hir("flat-struct-abi", nativeParityApp(`struct Sample { enabled: bool; signed: i64; ratio: ieee64; code: u64; ready: bool; }
fn make(flag: bool) -> vec<Sample> {
    let v: vec<Sample> = [new Sample { ready: !flag, code: 9, ratio: 2.5, signed: -7, enabled: flag }];
    return v;
}
fn consume(v: vec<Sample>, i: u64) -> u64 {
    let flag: bool = v[0].enabled;
    vec_push(v, new Sample { enabled: !flag, signed: -11, ratio: 3.5, code: 17, ready: flag });
    let r = &mut v[0].enabled;
    store(r, !flag);
    drop(r);
    let shared_ref = &v[0].enabled;
    let mutated: bool = *shared_ref;
    drop(shared_ref);
    let p: Sample = v[0];
    let s: slice<Sample> = v[0:2];
    let q: Sample = s[i];
    let slice_ref = &s[i].ready;
    let ready: bool = *slice_ref;
    drop(slice_ref);
    let direct: bool = s[i].ready;
    drop(s);
    drop(v);
    if same(mutated, !flag) && same(p.enabled, !flag) && p.signed == -7 && p.ratio == 2.5 && p.code == 9 && same(p.ready, !flag) && same(q.enabled, !flag) && same(ready, direct) && same(q.ready, ready) {
        if i == 0 && q.signed == -7 && q.ratio == 2.5 && q.code == 9 && same(ready, !flag) { return 41; }
        if i == 1 && q.signed == -11 && q.ratio == 3.5 && q.code == 17 && same(ready, flag) { return 41; }
    }
    return 19;
}
fn run(i: u64, flag: bool) -> u64 {
    let v: vec<Sample> = make(flag);
    return consume(v, i);
}`), nativeParityExit(41, "0", "false"), nativeParityExit(41, "0", "true"),
			nativeParityExit(41, "1", "false"), nativeParityExit(41, "1", "true"),
			nativeParityExit(1, "2", "true"), nativeParityExit(1, max, "false")),
		hir("nested-record-module-abi", map[string]string{
			"app/main.swyp": `module app.main;
use lib.flags;
fn run(i: u64, flag: bool) -> u64 {
    let v: vec<lib.flags.Outer> = lib.flags.make(flag);
    return lib.flags.consume(v, i);
}`,
			"lib/flags.swyp": `module lib.flags;
use lib.bits;
struct Outer { ready: bool; bits: lib.bits.Bits; code: u64; }
fn make(flag: bool) -> vec<Outer> {
    let v: vec<Outer> = [new Outer { code: 7, bits: new lib.bits.Bits { second: !flag, first: flag }, ready: flag }];
    return v;
}
fn consume(v: vec<Outer>, i: u64) -> u64 {
    defer_drop(v);
    let flag: bool = v[0].ready;
    vec_push(v, new Outer { ready: !flag, bits: new lib.bits.Bits { first: !flag, second: flag }, code: 9 });
    let r = &mut v[0].bits.first;
    store(r, !flag);
    let mutated: bool = *r;
    drop(r);
    let p: Outer = v[0];
    let local_ref = &mut p.bits.second;
    store(local_ref, flag);
    drop(local_ref);
    let s: slice<Outer> = v[0:2];
    let q: Outer = s[i];
    let slice_ref = &s[i].bits.second;
    let via_ref: bool = *slice_ref;
    drop(slice_ref);
    let direct: bool = s[i].bits.second;
    drop(s);
    if same(mutated, !flag) && same(p.bits.first, !flag) && same(p.bits.second, flag) && p.code == 7 && same(q.bits.second, via_ref) && same(via_ref, direct) {
        if i == 0 && same(q.ready, flag) && same(q.bits.first, !flag) && same(via_ref, !flag) && q.code == 7 { return 47; }
        if i == 1 && same(q.ready, !flag) && same(q.bits.first, !flag) && same(via_ref, flag) && q.code == 9 { return 47; }
    }
    return 19;
}`,
			"lib/bits.swyp": `module lib.bits;
record Bits { field first: bool; field second: bool; }`,
		}, nativeParityExit(47, "0", "false"), nativeParityExit(47, "0", "true"),
			nativeParityExit(47, "1", "false"), nativeParityExit(47, "1", "true"),
			nativeParityExit(1, "2", "true"), nativeParityExit(1, max, "false")),
		hir("struct-ref-bounds", nativeParityApp(`struct Bits { first: bool; second: bool; }
fn run(i: u64, flag: bool) -> u64 {
    let v: vec<Bits> = [new Bits { first: flag, second: !flag }];
    let r = &mut v[i].second;
    store(r, flag);
    let x: bool = *r;
    drop(r);
    let p: Bits = v[i];
    drop(v);
    if same(x, flag) && same(p.first, flag) && same(p.second, flag) { return 53; }
    return 19;
}`), nativeParityExit(53, "0", "false"), nativeParityExit(53, "0", "true"),
			nativeParityExit(1, "1", "true"), nativeParityExit(1, max, "false")),
		hir("large-array", nativeParityApp(`fn run(i: u64, flag: bool) -> u64 {
    let xs: array<bool,65> = [`+strings.Join(booleans, ",")+`];
    let before: bool = xs[i];
    let r = &mut xs[64];
    store(r, !flag);
    let after: bool = *r;
    drop(r);
    let shared_ref = &xs[64];
    let shared: bool = *shared_ref;
    drop(shared_ref);
    let s: slice<bool> = xs[60:65];
    let sliced: bool = s[4];
    drop(s);
    if same(after, !flag) && same(shared, after) && same(sliced, after) {
        if i == 64 && same(before, flag) { return 59; }
        if i < 64 && same(before, i % 2 == 0) { return 59; }
    }
    return 19;
}`), nativeParityExit(59, "0", "false"), nativeParityExit(59, "1", "true"),
			nativeParityExit(59, "64", "false"), nativeParityExit(59, "64", "true"),
			nativeParityExit(1, "65", "true"), nativeParityExit(1, max, "false")),
	}
}

func TestHIRBoolStorageInterpreterProfiles(t *testing.T) {
	for _, tc := range boolStorageParityCases() {
		t.Run(tc.name, func(t *testing.T) {
			module := nativeParityHIRModule(t, tc.program)
			executable, err := coreir.Prepare(module)
			if err != nil {
				t.Fatal(err)
			}
			var params []coreir.Parameter
			for _, f := range module.Functions {
				if f.Name == tc.program.entry {
					params = f.Params
					break
				}
			}
			profiles := map[string]func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error){
				"run": executable.Run, "fast": executable.RunFast, "turbo": executable.RunTurbo,
			}
			for profile, run := range profiles {
				t.Run(profile, func(t *testing.T) {
					for _, want := range tc.runs {
						if len(want.args) != len(params) {
							t.Fatalf("params=%d args=%q", len(params), want.args)
						}
						args := make([]coreir.Value, len(params))
						for i, param := range params {
							args[i], err = coreir.ParseValue(param.Type, want.args[i])
							if err != nil {
								t.Fatal(err)
							}
						}
						got, err := run(context.Background(), tc.program.entry, args, coreir.MaxFuel)
						if want.exit == 1 {
							var diagnostic *coreir.Diagnostic
							if !errors.As(err, &diagnostic) || (diagnostic.Code != "bounds" && diagnostic.Code != "unreachable") {
								t.Fatalf("args=%q: value=%v error=%v, want checked bounds failure", want.args, got.Value, err)
							}
							continue
						}
						if err != nil {
							t.Fatalf("args=%q: %v", want.args, err)
						}
						value, ok := got.Value.Uint64()
						if !ok || value != uint64(want.exit) {
							t.Fatalf("args=%q: value=%v want=%d", want.args, got.Value, want.exit)
						}
					}
				})
			}
		})
	}
}

func TestHIRBoolStorageKeepsUnsupportedOperationsFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name, source, message string
	}{
		{"mutable-slice", `struct Bits { on: bool; }
fn run() {
    let v: vec<Bits> = [new Bits { on: true }];
    let s: slice<Bits> = v[0:1];
    let r = &mut s[0].on;
    store(r, false);
    drop(r); drop(s); drop(v);
}`, "mutable-slice contract"},
		{"non-raw-leaf", `struct Bits { on: bool; value: f64; }
fn run() { let v: vec<Bits> = [new Bits { on: true, value: 2.5 }]; drop(v); }`, "does not support f64"},
		{"aggregate-parameter", `struct Bits { on: bool; }
fn consume(p: Bits) -> bool { return p.on; }
fn run() -> bool { let p: Bits = new Bits { on: true }; return consume(p); }`, "parameter p"},
		{"aggregate-return", `struct Bits { on: bool; }
fn make() -> Bits { return new Bits { on: true }; }
fn run() -> bool { let p: Bits = make(); return p.on; }`, "does not support type"},
		{"aggregate-push-variable", `struct Bits { on: bool; }
fn run() {
    let p: Bits = new Bits { on: true };
    let v: vec<Bits> = [];
    vec_push(v, p);
    drop(v);
}`, "constructor"},
		{"slice-parameter", `fn consume(s: slice<bool>) -> bool { return s[0]; }
fn run() -> bool {
    let v: vec<bool> = [true];
    let s: slice<bool> = v[0:1];
    let x: bool = consume(s);
    drop(s); drop(v);
    return x;
}`, "compound type slice"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeHIRNativeFile(t, root, "app/main.swyp", "module app.main;\n"+tc.source)
			bundle, err := buildHIRBundle(filepath.Join(root, "app", "main.swyp"), root)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := hircore.Lower(bundle, "run"); err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("error=%v want explicit %q rejection", err, tc.message)
			}
		})
	}
}

func TestHIRBoolStorageNoncanonicalWord(t *testing.T) {
	targets := nativeParityTargets(t)
	for _, word := range []uint64{0, 1, 2, 255, 1 << 63, ^uint64(0)} {
		t.Run(strconv.FormatUint(word, 10), func(t *testing.T) {
			module := nativeParityHIRModule(t, nativeParityHIR("run", nativeParityApp(`fn run() -> u64 {
    let v: vec<bool> = [false];
    let x: bool = v[0];
    drop(v);
    if x { return 23; }
    return 17;
}`)))
			injected := false
			for fi := range module.Functions {
				f := &module.Functions[fi]
				for bi := range f.Blocks {
					block := &f.Blocks[bi]
					for ii, ins := range block.Instructions {
						if injected || ins.Op != "storage.store_u64" {
							continue
						}
						slot := len(f.Slots)
						f.Slots = append(f.Slots, coreir.U64)
						literal := coreir.Uint(word).Literal()
						ins.Args = []int{ins.Args[0], ins.Args[1], slot}
						replacement := append([]coreir.Instruction(nil), block.Instructions[:ii]...)
						replacement = append(replacement, coreir.Instruction{Op: "const", Dest: slot, Constant: &literal}, ins)
						block.Instructions = append(replacement, block.Instructions[ii+1:]...)
						injected = true
						break
					}
				}
			}
			if !injected {
				t.Fatal("test did not inject a raw bool storage word")
			}
			executable, err := coreir.Prepare(module)
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if word < 2 {
				want = 17 + int(word)*6
			}
			for profile, run := range map[string]func(context.Context, string, []coreir.Value, int) (coreir.RunResult, error){
				"run": executable.Run, "fast": executable.RunFast, "turbo": executable.RunTurbo,
			} {
				t.Run(profile, func(t *testing.T) {
					got, err := run(context.Background(), "run", nil, coreir.MaxFuel)
					if word > 1 {
						var diagnostic *coreir.Diagnostic
						if !errors.As(err, &diagnostic) || diagnostic.Code != "unreachable" {
							t.Fatalf("value=%v error=%v, want noncanonical-word trap", got.Value, err)
						}
					} else if value, ok := got.Value.Uint64(); err != nil || !ok || value != uint64(want) {
						t.Fatalf("value=%v error=%v want=%d", got.Value, err, want)
					}
				})
			}
			for _, target := range targets {
				t.Run(target.name, func(t *testing.T) {
					var image []byte
					var err error
					if target.arch == "x64" {
						artifact, prepareErr := prepareX64ModuleIR(module, "run", true, true)
						if prepareErr != nil {
							t.Fatal(prepareErr)
						}
						image, _, _, err = encodeX64StandaloneArtifact(artifact, target.format, target.pie)
					} else {
						artifact, prepareErr := prepareARM64ModuleIR(module, "run", true)
						if prepareErr != nil {
							t.Fatal(prepareErr)
						}
						image, _, _, err = encodeARM64StandaloneArtifact(artifact, target.pie)
					}
					if err != nil {
						t.Fatal(err)
					}
					dir := t.TempDir()
					name := "word"
					if target.format == "pe" {
						name += ".exe"
					}
					exe := filepath.Join(dir, name)
					if err := writeExecutable(exe, image); err != nil {
						t.Fatal(err)
					}
					got := target.run(t, dir, exe)
					if got.exit != want || got.stdout != "" || got.stderr != "" {
						t.Fatalf("exit=%d stdout=%q stderr=%q error=%v want=%d", got.exit, got.stdout, got.stderr, got.err, want)
					}
				})
			}
		})
	}
}
