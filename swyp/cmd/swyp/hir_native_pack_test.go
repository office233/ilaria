package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestHIRNativePackCommandsEmitDecodableArtifacts(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.math;
fn run(x: i64) -> i64 { return lib.math.square(x); }`)
	writeHIRNativeFile(t, root, "lib/math.swyp", `module lib.math;
fn square(x: i64) -> i64 { return x * x; }`)

	x64Path := filepath.Join(root, "module.swx64")
	var out bytes.Buffer
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	x64Bytes, err := os.ReadFile(x64Path)
	if err != nil {
		t.Fatal(err)
	}
	x64, err := coreir.DecodeX64Module(x64Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if x64.Header.Entry != "run" || x64.Header.Result != coreir.I64 || len(x64.Header.Params) != 1 || x64.Header.Params[0] != coreir.I64 {
		t.Fatalf("x64 header=%+v", x64.Header)
	}

	armPath := filepath.Join(root, "module.swa64")
	out.Reset()
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	armBytes, err := os.ReadFile(armPath)
	if err != nil {
		t.Fatal(err)
	}
	arm, err := coreir.DecodeARM64Module(armBytes)
	if err != nil {
		t.Fatal(err)
	}
	if arm.Header.Entry != "run" || arm.Header.Result != coreir.I64 || len(arm.Header.Params) != 1 || arm.Header.Params[0] != coreir.I64 {
		t.Fatalf("arm64 header=%+v", arm.Header)
	}
}

func TestHIRNativePackScalarizesProvenFixedArrayIndex(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> i64 {
    let xs: array<i64,3> = [5,7,9];
    return xs[1];
}`)
	var out bytes.Buffer
	x64Path := filepath.Join(root, "array.swx64")
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	x64Bytes, err := os.ReadFile(x64Path)
	if err != nil {
		t.Fatal(err)
	}
	x64, err := coreir.DecodeX64Module(x64Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if x64.Header.Entry != "run" || x64.Header.Result != coreir.I64 || len(x64.Header.Params) != 0 || len(x64.Code) == 0 {
		t.Fatalf("x64 array header=%+v code=%d", x64.Header, len(x64.Code))
	}

	out.Reset()
	armPath := filepath.Join(root, "array.swa64")
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	armBytes, err := os.ReadFile(armPath)
	if err != nil {
		t.Fatal(err)
	}
	arm, err := coreir.DecodeARM64Module(armBytes)
	if err != nil {
		t.Fatal(err)
	}
	if arm.Header.Entry != "run" || arm.Header.Result != coreir.I64 || len(arm.Header.Params) != 0 || len(arm.Code) == 0 {
		t.Fatalf("arm64 array header=%+v code=%d", arm.Header, len(arm.Code))
	}
}

func TestHIRNativePackLowersDynamicFixedArrayBoundsCFG(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(i: u64) -> i64 {
    let xs: array<i64,3> = [5,7,9];
    return xs[i];
}`)
	var out bytes.Buffer
	x64Path := filepath.Join(root, "array-dynamic.swx64")
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(x64Path); err != nil {
		t.Fatal(err)
	} else if module, err := coreir.DecodeX64Module(data); err != nil || len(module.Header.Params) != 1 || module.Header.Params[0] != coreir.U64 || module.Header.Result != coreir.I64 || len(module.Code) == 0 {
		t.Fatalf("x64 dynamic-array module=%+v err=%v", module, err)
	}

	out.Reset()
	armPath := filepath.Join(root, "array-dynamic.swa64")
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(armPath); err != nil {
		t.Fatal(err)
	} else if module, err := coreir.DecodeARM64Module(data); err != nil || len(module.Header.Params) != 1 || module.Header.Params[0] != coreir.U64 || module.Header.Result != coreir.I64 || len(module.Code) == 0 {
		t.Fatalf("arm64 dynamic-array module=%+v err=%v", module, err)
	}
}

func TestHIRNativePackLowersLocalMutableRefAlias(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(x: u64) -> u64 {
    let r = &mut x;
    store(r, 7);
    drop(r);
    return x;
}`)
	var out bytes.Buffer
	x64Path := filepath.Join(root, "ref.swx64")
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(x64Path); err != nil {
		t.Fatal(err)
	} else if module, err := coreir.DecodeX64Module(data); err != nil || len(module.Header.Params) != 1 || module.Header.Params[0] != coreir.U64 || module.Header.Result != coreir.U64 || len(module.Code) == 0 {
		t.Fatalf("x64 ref module=%+v err=%v", module, err)
	}

	out.Reset()
	armPath := filepath.Join(root, "ref.swa64")
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(armPath); err != nil {
		t.Fatal(err)
	} else if module, err := coreir.DecodeARM64Module(data); err != nil || len(module.Header.Params) != 1 || module.Header.Params[0] != coreir.U64 || module.Header.Result != coreir.U64 || len(module.Code) == 0 {
		t.Fatalf("arm64 ref module=%+v err=%v", module, err)
	}
}

func TestHIRNativePackScalarizesFixedStructProjection(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Point { x: i64; y: i64; }
fn run() -> i64 {
    let p = new Point { x: 5, y: 7 };
    return p.y;
}`)
	var out bytes.Buffer
	x64Path := filepath.Join(root, "struct.swx64")
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	x64Bytes, err := os.ReadFile(x64Path)
	if err != nil {
		t.Fatal(err)
	}
	x64, err := coreir.DecodeX64Module(x64Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if x64.Header.Entry != "run" || x64.Header.Result != coreir.I64 || len(x64.Code) == 0 {
		t.Fatalf("x64 struct header=%+v code=%d", x64.Header, len(x64.Code))
	}
	out.Reset()
	armPath := filepath.Join(root, "struct.swa64")
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	armBytes, err := os.ReadFile(armPath)
	if err != nil {
		t.Fatal(err)
	}
	arm, err := coreir.DecodeARM64Module(armBytes)
	if err != nil {
		t.Fatal(err)
	}
	if arm.Header.Entry != "run" || arm.Header.Result != coreir.I64 || len(arm.Code) == 0 {
		t.Fatalf("arm64 struct header=%+v code=%d", arm.Header, len(arm.Code))
	}
}

func TestHIRNativePackScalarizesKnownOptionMatch(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let value: option<u64> = some(7);
    return match value { None => 0, Some(x) => x, };
}`)
	var out bytes.Buffer
	x64Path := filepath.Join(root, "option.swx64")
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(x64Path); err != nil {
		t.Fatal(err)
	} else if module, err := coreir.DecodeX64Module(data); err != nil || module.Header.Result != coreir.U64 || len(module.Code) == 0 {
		t.Fatalf("x64 option module=%+v err=%v", module, err)
	}
	out.Reset()
	armPath := filepath.Join(root, "option.swa64")
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(armPath); err != nil {
		t.Fatal(err)
	} else if module, err := coreir.DecodeARM64Module(data); err != nil || module.Header.Result != coreir.U64 || len(module.Code) == 0 {
		t.Fatalf("arm64 option module=%+v err=%v", module, err)
	}
}

func TestHIRNativePackRemainsPureOnly(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.clock;
fn run() -> u64 { return lib.clock.now(); }`)
	writeHIRNativeFile(t, root, "lib/clock.swyp", `module lib.clock;
fn now() -> u64 { return clock(); }`)

	var out bytes.Buffer
	err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "bad.swx64"), app}, &out)
	if err == nil || (!strings.Contains(err.Error(), "requires pure function") && !strings.Contains(err.Error(), "process backend")) {
		t.Fatalf("x64 effectful packed error=%v output=%s", err, out.String())
	}
	out.Reset()
	err = hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "bad.swa64"), app}, &out)
	if err == nil || (!strings.Contains(err.Error(), "requires pure function") && !strings.Contains(err.Error(), "process backend")) {
		t.Fatalf("arm64 effectful packed error=%v output=%s", err, out.String())
	}
}

func TestHIRNativePackPreservesImportedIEEE64Calls(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.math;
fn run(x: ieee64) -> ieee64 { return lib.math.twice(x); }`)
	writeHIRNativeFile(t, root, "lib/math.swyp", `module lib.math;
fn twice(x: ieee64) -> ieee64 {
    let y: ieee64 = x;
    let n: u64 = 0;
    while n < 1 {
        y = y + x;
        n = n + 1;
    }
    return y;
}`)

	x64Path := filepath.Join(root, "fp.swx64")
	var out bytes.Buffer
	if err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", x64Path, app}, &out); err != nil {
		t.Fatal(err)
	}
	x64Bytes, err := os.ReadFile(x64Path)
	if err != nil {
		t.Fatal(err)
	}
	x64, err := coreir.DecodeX64Module(x64Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if x64.Header.ABI != coreir.X64CFGMachineFPCallsABI || x64.Header.Result != coreir.IEEE64 {
		t.Fatalf("x64 fp header=%+v", x64.Header)
	}

	armPath := filepath.Join(root, "fp.swa64")
	out.Reset()
	if err := hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", armPath, app}, &out); err != nil {
		t.Fatal(err)
	}
	armBytes, err := os.ReadFile(armPath)
	if err != nil {
		t.Fatal(err)
	}
	arm, err := coreir.DecodeARM64Module(armBytes)
	if err != nil {
		t.Fatal(err)
	}
	if arm.Header.ABI != coreir.ARM64CFGMachineFPCallsABI || arm.Header.Result != coreir.IEEE64 {
		t.Fatalf("arm64 fp header=%+v", arm.Header)
	}
}

func TestHIRNativePackFailsClosedForCoreStorageOps(t *testing.T) {
	root := t.TempDir()
	values := make([]string, 65)
	for i := range values {
		values[i] = strconv.Itoa(i)
	}
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(i: u64) -> u64 {
    let xs: array<u64,65> = [`+strings.Join(values, ",")+`];
    return xs[i];
}`)
	var out bytes.Buffer
	err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "storage.swx64"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), `unsupported operation "storage.alloc_u64"`) {
		t.Fatalf("x64 storage boundary error=%v output=%s", err, out.String())
	}
	out.Reset()
	err = hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "storage.swa64"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), `unsupported operation "storage.alloc_u64"`) {
		t.Fatalf("arm64 storage boundary error=%v output=%s", err, out.String())
	}
}

func TestHIRNativePackFailsClosedForStorageBackedVec(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10,20,30];
    let x: u64 = v[1];
    drop(v);
    return x;
}`)
	var out bytes.Buffer
	err := hirX64PackCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "vec.swx64"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), `storage.alloc_u64 requires standalone process backend`) {
		t.Fatalf("x64 vec storage boundary error=%v output=%s", err, out.String())
	}
	out.Reset()
	err = hirARM64PackCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "vec.swa64"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), `unsupported operation "storage.alloc_u64"`) {
		t.Fatalf("arm64 vec storage boundary error=%v output=%s", err, out.String())
	}
}

func writeHIRNativeFile(t *testing.T, root, rel, source string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
