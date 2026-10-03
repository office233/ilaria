package main

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestHIRX64ExecutableRunsImportedCallOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.math;
fn run(x: i64) -> i64 { return lib.math.square(x); }`)
	writeHIRNativeFile(t, root, "lib/math.swyp", `module lib.math;
fn square(x: i64) -> i64 { return x * x; }`)
	exe := filepath.Join(root, "app.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	peFile, err := pe.Open(exe)
	if err != nil {
		t.Fatal(err)
	}
	_ = peFile.Close()
	cmd := exec.Command(exe, "9")
	err = cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 81")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 81 {
		t.Fatalf("native imported call exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64ExecutableRunsScalarizedFixedArrayIndexOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> i64 {
    let xs: array<i64,3> = [5,7,9];
    return xs[1];
}`)
	exe := filepath.Join(root, "array.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 7")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 7 {
		t.Fatalf("native fixed-array exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64ExecutableRunsDynamicFixedArrayIndexOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(i: u64) -> i64 {
    let xs: array<i64,3> = [5,7,9];
    return xs[i];
}`)
	exe := filepath.Join(root, "array-dynamic.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "2")
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 9")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 9 {
		t.Fatalf("native dynamic fixed-array exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64ExecutableRunsFixedSliceDynamicIndexOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(i: u64) -> i64 {
    let xs: array<i64,4> = [5,7,9,11];
    let s = xs[1:4];
    return s[i];
}`)
	exe := filepath.Join(root, "slice-dynamic.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "2")
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 11")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 11 {
		t.Fatalf("native fixed-slice exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}

	cmd = exec.Command(exe, "3")
	err = cmd.Run()
	if err == nil {
		t.Fatal("out-of-range fixed slice execution unexpectedly succeeded")
	}
	exit, ok = err.(*exec.ExitError)
	// Machine code reports bounds status 3; the standalone process wrapper maps
	// any non-zero machine status to its generic process failure exit code 1.
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("native fixed-slice OOB exit=%v code=%d want=1", err, exitCode(err))
	}
}

func TestHIRX64ExecutableRunsDynamicSliceRangeOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(start: u64, end: u64, i: u64) -> i64 {
    let xs: array<i64,4> = [5,7,9,11];
    let s = xs[start:end];
    return s[i];
}`)
	exe := filepath.Join(root, "slice-range.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "1", "4", "1")
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 9")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 9 {
		t.Fatalf("native dynamic slice exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}

	cmd = exec.Command(exe, "3", "2", "0")
	err = cmd.Run()
	if err == nil {
		t.Fatal("reversed dynamic slice range unexpectedly succeeded")
	}
	exit, ok = err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("native dynamic slice invalid-range exit=%v code=%d want=1", err, exitCode(err))
	}
}

func TestHIRX64ExecutableRunsLocalMutableRefAliasOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(x: u64) -> u64 {
    let r = &mut x;
    store(r, 7);
    drop(r);
    return x;
}`)
	exe := filepath.Join(root, "ref.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "1")
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 7")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 7 {
		t.Fatalf("native local-ref exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64ExecutableRunsScalarizedFixedStructProjectionOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Point { x: i64; y: i64; }
fn run() -> i64 {
    let p = new Point { x: 5, y: 7 };
    return p.y;
}`)
	exe := filepath.Join(root, "struct.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 7")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 7 {
		t.Fatalf("native fixed-struct exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64ExecutableRunsScalarizedKnownOptionMatchOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let value: option<u64> = some(7);
    return match value { None => 0, Some(x) => x, };
}`)
	exe := filepath.Join(root, "option.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	err := cmd.Run()
	if err == nil {
		t.Fatal("native executable returned exit code 0, want 7")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 7 {
		t.Fatalf("native option-match exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64ExecutableIsStructuralELF(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.math;
fn run(x: i64) -> i64 { return lib.math.square(x); }`)
	writeHIRNativeFile(t, root, "lib/math.swyp", `module lib.math;
fn square(x: i64) -> i64 { return x * x; }`)
	path := filepath.Join(root, "app-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || !bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		t.Fatalf("not ELF: size=%d head=%x", len(data), data[:min(len(data), 16)])
	}
	if machine := binary.LittleEndian.Uint16(data[18:20]); machine != 183 {
		t.Fatalf("ELF e_machine=%d want AArch64(183)", machine)
	}
}

func TestHIRNativeExecutablesPropagateSensitiveCapabilityGates(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.fs;
fn run() -> i64 { return lib.fs.save(); }`)
	writeHIRNativeFile(t, root, "lib/fs.swyp", `module lib.fs;
fn save() -> i64 { write_file("hir-native-capability.tmp", "x"); return 0; }`)

	var out bytes.Buffer
	err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "bad.exe"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), "workspace_write") {
		t.Fatalf("x64 missing grant error=%v", err)
	}
	x64Granted := filepath.Join(root, "granted.exe")
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-allow-fs-write", "-o", x64Granted, app}, &out); err != nil {
		t.Fatalf("x64 granted effect failed: %v", err)
	}
	if info, err := os.Stat(x64Granted); err != nil || info.Size() == 0 {
		t.Fatalf("x64 granted executable stat=%v err=%v", info, err)
	}
	if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		proof := filepath.Join(root, "hir-native-capability.tmp")
		cmd := exec.Command(x64Granted)
		cmd.Dir = root
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("x64 granted executable runtime failed: %v output=%s", err, output)
		}
		data, err := os.ReadFile(proof)
		if err != nil {
			t.Fatalf("x64 imported fs.write did not create proof file: %v", err)
		}
		if string(data) != "x" {
			t.Fatalf("x64 imported fs.write content=%q", data)
		}
	}

	out.Reset()
	err = hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "bad-arm64"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), "workspace_write") {
		t.Fatalf("arm64 missing grant error=%v", err)
	}
	armGranted := filepath.Join(root, "granted-arm64")
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-allow-fs-write", "-o", armGranted, app}, &out); err != nil {
		t.Fatalf("arm64 granted effect failed: %v", err)
	}
	if info, err := os.Stat(armGranted); err != nil || info.Size() == 0 {
		t.Fatalf("arm64 granted executable stat=%v err=%v", info, err)
	}
}

func TestHIRImportedProcessExecRemainsFailClosedAfterGrant(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.proc;
fn run() -> u64 { return lib.proc.launch(); }`)
	writeHIRNativeFile(t, root, "lib/proc.swyp", `module lib.proc;
fn launch() -> u64 { return process_exec("tool.exe", 0, "", "", "", ""); }`)

	var out bytes.Buffer
	err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "proc.exe"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), "process_exec") {
		t.Fatalf("x64 process.exec missing-grant error=%v", err)
	}
	err = hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-allow-process-exec", "-o", filepath.Join(root, "proc-granted.exe"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), "process.exec runtime is not implemented") {
		t.Fatalf("x64 process.exec granted error=%v", err)
	}

	err = hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", filepath.Join(root, "proc-arm64"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), "process_exec") {
		t.Fatalf("arm64 process.exec missing-grant error=%v", err)
	}
	err = hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-allow-process-exec", "-o", filepath.Join(root, "proc-arm64-granted"), app}, &out)
	if err == nil || !strings.Contains(err.Error(), "process.exec runtime is not implemented") {
		t.Fatalf("arm64 process.exec granted error=%v", err)
	}
}

func TestHIRX64StandaloneRunsNativeStorageArrayOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	values := make([]string, 65)
	for i := range values {
		values[i] = strconv.Itoa(i)
	}
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let xs: array<u64,65> = [`+strings.Join(values, ",")+`];
    return xs[64];
}`)
	exe := filepath.Join(root, "storage.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(exe); err != nil || info.Size() == 0 {
		t.Fatalf("storage executable stat=%v err=%v", info, err)
	}
	cmd := exec.Command(exe)
	err := cmd.Run()
	if err == nil {
		t.Fatal("native storage executable returned exit code 0, want 64")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 64 {
		t.Fatalf("native storage exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsNativeStorageArrayELF(t *testing.T) {
	root := t.TempDir()
	values := make([]string, 65)
	for i := range values {
		values[i] = strconv.Itoa(i)
	}
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let xs: array<u64,65> = [`+strings.Join(values, ",")+`];
    return xs[64];
}`)
	path := filepath.Join(root, "storage-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || !bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		t.Fatalf("not ELF: size=%d head=%x", len(data), data[:min(len(data), 16)])
	}
	if machine := binary.LittleEndian.Uint16(data[18:20]); machine != 183 {
		t.Fatalf("ELF e_machine=%d want AArch64(183)", machine)
	}
}

func TestHIRX64StandaloneStorageAndFSReadUseDisjointRuntimeArenas(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "probe.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	values := make([]string, 65)
	for i := range values {
		values[i] = strconv.Itoa(i)
	}
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let xs: array<u64,65> = [`+strings.Join(values, ",")+`];
    let data: bytes = read_file("probe.txt");
    let n: u64 = bytes_len(data);
    if n == 1 { return xs[64]; }
    return 1;
}`)
	exe := filepath.Join(root, "storage-fs.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-allow-fs-read", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Dir = root
	err := cmd.Run()
	if err == nil {
		t.Fatal("storage+fs executable returned exit code 0, want 64")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 64 {
		t.Fatalf("storage+fs exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsStorageBackedVecOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let x: u64 = v[1];
    drop(v);
    return x;
}`)
	exe := filepath.Join(root, "vec.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("storage-backed vec executable returned exit code 0, want 20")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 20 {
		t.Fatalf("storage-backed vec exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsStorageBackedVecELF(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let x: u64 = v[1];
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "vec-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || !bytes.Equal(data[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		t.Fatalf("not ELF: size=%d", len(data))
	}
	if machine := binary.LittleEndian.Uint16(data[18:20]); machine != 183 {
		t.Fatalf("ELF e_machine=%d want AArch64(183)", machine)
	}
}

func TestHIRX64StandaloneRunsVecSliceViewOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30, 40];
    let s: slice<u64> = v[1:4];
    let x: u64 = s[1];
    drop(s);
    drop(v);
    return x;
}`)
	exe := filepath.Join(root, "vec-slice.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec-slice executable returned exit code 0, want 30")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 30 {
		t.Fatalf("vec-slice exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsStorageBackedVecRefOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let r = &mut v[1];
    store(r, 25);
    let x: u64 = *r;
    drop(r);
    drop(v);
    return x;
}`)
	exe := filepath.Join(root, "vec-ref.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec-ref executable returned exit code 0, want 25")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 25 {
		t.Fatalf("vec-ref exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsDynamicStorageBackedVecRefOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(i: u64) -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let r = &mut v[i];
    store(r, 26);
    let x: u64 = *r;
    drop(r);
    drop(v);
    return x;
}`)
	exe := filepath.Join(root, "vec-ref-dynamic.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "2")
	err := cmd.Run()
	if err == nil {
		t.Fatal("dynamic vec-ref executable returned exit code 0, want 26")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 26 {
		t.Fatalf("dynamic vec-ref exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}

	cmd = exec.Command(exe, "3")
	err = cmd.Run()
	if err == nil {
		t.Fatal("out-of-range dynamic vec-ref unexpectedly succeeded")
	}
	exit, ok = err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("dynamic vec-ref OOB exit=%v code=%d want=1", err, exitCode(err))
	}
}

func TestHIRARM64StandaloneBuildsStorageBackedVecRefELF(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let r = &mut v[1];
    store(r, 25);
    let x: u64 = *r;
    drop(r);
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "vec-ref-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsVecLenCapacityOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    let n: u64 = vec_len(v);
    let c: u64 = vec_capacity(v);
    drop(v);
    return n + c;
}`)
	exe := filepath.Join(root, "vec-meta.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec metadata executable returned exit code 0, want 6")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 6 {
		t.Fatalf("vec metadata exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsVecPushGrowthOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    vec_push(v, 40);
    vec_push(v, 50);
    let x: u64 = v[4];
    let n: u64 = vec_len(v);
    let c: u64 = vec_capacity(v);
    drop(v);
    return x + n + c;
}`)
	exe := filepath.Join(root, "vec-push.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec-push executable returned exit code 0, want 61")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 61 {
		t.Fatalf("vec-push exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneVecPushAcrossIfOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(flag: u64) -> u64 {
    let v: vec<u64> = [10];
    if flag == 1 { vec_push(v, 20); }
    let n: u64 = vec_len(v);
    drop(v);
    return n;
}`)
	var out bytes.Buffer
	exe := filepath.Join(root, "vec-push-if.exe")
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		arg  string
		want int
	}{{"0", 1}, {"1", 2}} {
		err := exec.Command(exe, tc.arg).Run()
		if err == nil {
			t.Fatalf("vec-push if arg=%s returned exit code 0, want %d", tc.arg, tc.want)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != tc.want {
			t.Fatalf("vec-push if arg=%s exit=%v code=%d want=%d", tc.arg, err, exitCode(err), tc.want)
		}
	}
}

func TestHIRX64StandaloneVecPushAcrossLoopOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(n: u64) -> u64 {
    let v: vec<u64> = [10];
    let i: u64 = 0;
    while i < n {
        vec_push(v, i);
        i = i + 1;
    }
    let result: u64 = vec_len(v);
    drop(v);
    return result;
}`)
	var out bytes.Buffer
	exe := filepath.Join(root, "vec-push-loop.exe")
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe, "3").Run()
	if err == nil {
		t.Fatal("vec-push loop returned exit code 0, want 4")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 4 {
		t.Fatalf("vec-push loop exit=%v code=%d want=4 output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsVecPushGrowthELF(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    vec_push(v, 40);
    vec_push(v, 50);
    let x: u64 = v[4];
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "vec-push-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 vec-push ELF size=%d", len(data))
	}
}

func TestHIRX64StandalonePassesVecAcrossFunctionABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<u64>) -> u64 {
    let n: u64 = vec_len(v);
    let x: u64 = v[2];
    drop(v);
    return n + x;
}
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    return consume(v);
}`)
	exe := filepath.Join(root, "vec-abi.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec ABI executable returned exit code 0, want 33")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 33 {
		t.Fatalf("vec ABI exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsVecFunctionABI(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<u64>) -> u64 {
    let x: u64 = v[1];
    drop(v);
    return x;
}
fn run() -> u64 {
    let v: vec<u64> = [10, 20, 30];
    return consume(v);
}`)
	path := filepath.Join(root, "vec-abi-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 vec ABI ELF size=%d", len(data))
	}
}

func TestHIRX64StandalonePassesVecAcrossModuleABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.vec;
fn run() -> u64 {
    let v: vec<u64> = [7, 8, 9];
    return lib.vec.consume(v);
}`)
	writeHIRNativeFile(t, root, "lib/vec.swyp", `module lib.vec;
fn consume(v: vec<u64>) -> u64 {
    let n: u64 = vec_len(v);
    let x: u64 = v[1];
    drop(v);
    return n + x;
}`)
	exe := filepath.Join(root, "vec-module-abi.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("cross-module vec ABI executable returned exit code 0, want 11")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 11 {
		t.Fatalf("cross-module vec ABI exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsVecI64StorageAndABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<i64>) -> i64 {
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
}`)
	exe := filepath.Join(root, "vec-i64.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec<i64> executable returned exit code 0, want 2")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 2 {
		t.Fatalf("vec<i64> exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsVecI64StorageAndABI(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<i64>) -> i64 {
    vec_push(v, -5);
    let x: i64 = v[3];
    drop(v);
    return x;
}
fn run() -> i64 {
    let v: vec<i64> = [-10, 20, 30];
    return consume(v);
}`)
	path := filepath.Join(root, "vec-i64-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 vec<i64> ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsLargeI64ArraySliceAndRefOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	values := make([]string, 65)
	for i := 0; i < 64; i++ {
		values[i] = strconv.Itoa(i)
	}
	values[64] = "-7"
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> i64 {
    let xs: array<i64,65> = [`+strings.Join(values, ",")+`];
    let r = &mut xs[64];
    store(r, -9);
    let a: i64 = *r;
    drop(r);
    let s: slice<i64> = xs[60:65];
    let b: i64 = s[4];
    drop(s);
    return a - b + 3;
}`)
	exe := filepath.Join(root, "array-i64.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("large i64 array executable returned exit code 0, want 3")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 3 {
		t.Fatalf("large i64 array exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsLargeI64ArraySliceAndRef(t *testing.T) {
	root := t.TempDir()
	values := make([]string, 65)
	for i := 0; i < 64; i++ {
		values[i] = strconv.Itoa(i)
	}
	values[64] = "-7"
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> i64 {
    let xs: array<i64,65> = [`+strings.Join(values, ",")+`];
    let r = &mut xs[64];
    store(r, -9);
    drop(r);
    let s: slice<i64> = xs[60:65];
    let b: i64 = s[4];
    drop(s);
    return b;
}`)
	path := filepath.Join(root, "array-i64-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 large i64 array ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsVecIEEE64StorageAndABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<ieee64>) -> bool {
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
}`)
	exe := filepath.Join(root, "vec-ieee64.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec<ieee64> executable returned exit code 0, want true/1")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("vec<ieee64> exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsVecIEEE64StorageAndABI(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<ieee64>) -> bool {
    vec_push(v, -3.5);
    let y: ieee64 = v[3];
    drop(v);
    return y == -3.5;
}
fn run() -> bool {
    let v: vec<ieee64> = [1.5, 2.5, 3.5];
    return consume(v);
}`)
	path := filepath.Join(root, "vec-ieee64-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 vec<ieee64> ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneReturnsVecAcrossFunctionABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn make() -> vec<u64> {
    let v: vec<u64> = [10, 20, 30];
    return v;
}
fn run() -> u64 {
    let v: vec<u64> = make();
    let n: u64 = vec_len(v);
    let x: u64 = v[2];
    drop(v);
    return n + x;
}`)
	exe := filepath.Join(root, "vec-return.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("vec-return executable returned exit code 0, want 33")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 33 {
		t.Fatalf("vec-return exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneReturnsVecAcrossModuleABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.vec;
fn run() -> u64 {
    let v: vec<u64> = lib.vec.make();
    let x: u64 = v[1];
    drop(v);
    return x;
}`)
	writeHIRNativeFile(t, root, "lib/vec.swyp", `module lib.vec;
fn make() -> vec<u64> {
    let v: vec<u64> = [7, 8, 9];
    return v;
}`)
	exe := filepath.Join(root, "vec-return-module.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("cross-module vec-return executable returned exit code 0, want 8")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 8 {
		t.Fatalf("cross-module vec-return exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsVecReturnABI(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn make() -> vec<u64> {
    let v: vec<u64> = [10, 20, 30];
    return v;
}
fn run() -> u64 {
    let v: vec<u64> = make();
    let x: u64 = v[2];
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "vec-return-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 vec-return ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneDeferDropCleansVecOnEarlyReturn(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run(flag: u64) -> u64 {
    let v: vec<u64> = [10, 20];
    defer_drop(v);
    if flag == 1 { return v[1]; }
    vec_push(v, 30);
    return v[2];
}`)
	exe := filepath.Join(root, "defer-drop.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		arg  string
		want int
	}{{"1", 20}, {"0", 30}} {
		cmd := exec.Command(exe, tc.arg)
		err := cmd.Run()
		if err == nil {
			t.Fatalf("defer-drop %s returned exit 0 want=%d", tc.arg, tc.want)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != tc.want {
			t.Fatalf("defer-drop arg=%s exit=%v code=%d want=%d output=%s", tc.arg, err, exitCode(err), tc.want, out.String())
		}
	}
}

func TestHIRARM64StandaloneBuildsDeferDropVecCleanup(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn run() -> u64 {
    let v: vec<u64> = [10,20,30];
    defer_drop(v);
    return v[2];
}`)
	path := filepath.Join(root, "defer-drop-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 defer-drop ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsFlatStructVecStorageABIOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: u64; }
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
}`)
	exe := filepath.Join(root, "vec-struct.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("flat-struct vec executable returned exit code 0, want 83")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 83 {
		t.Fatalf("flat-struct vec exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsFlatStructVecStorageABI(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: u64; }
fn make() -> vec<Pair> {
    let v: vec<Pair> = [new Pair { a: 10, b: 20 }, new Pair { a: 30, b: 40 }];
    return v;
}
fn run() -> u64 {
    let v: vec<Pair> = make();
    vec_push(v, new Pair { a: 50, b: 60 });
    let x: u64 = v[2].b;
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "vec-struct-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 flat-struct vec ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsCrossModuleFlatStructVecOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
use lib.types;
fn run() -> u64 {
    let v: vec<lib.types.Pair> = lib.types.make();
    let x: u64 = v[1].b;
    drop(v);
    return x;
}`)
	writeHIRNativeFile(t, root, "lib/types.swyp", `module lib.types;
struct Pair { a: u64; b: u64; }
fn make() -> vec<Pair> {
    let v: vec<Pair> = [new Pair { a: 7, b: 8 }, new Pair { a: 9, b: 42 }];
    return v;
}`)
	exe := filepath.Join(root, "vec-struct-module.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("cross-module flat-struct vec returned exit code 0, want 42")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 42 {
		t.Fatalf("cross-module flat-struct vec exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsMixedRaw64StructVecOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Sample { signed: i64; ratio: ieee64; code: u64; }
fn run() -> bool {
    let v: vec<Sample> = [new Sample { signed: -7, ratio: 2.5, code: 9 }];
    let a: i64 = v[0].signed;
    let b: ieee64 = v[0].ratio;
    let c: u64 = v[0].code;
    drop(v);
    return a == -7 && b == 2.5 && c == 9;
}`)
	exe := filepath.Join(root, "vec-struct-mixed.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("mixed raw64 struct vec returned exit code 0, want true/1")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("mixed raw64 struct vec exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRX64StandaloneRunsStructVecFieldRefOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run() -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let r = &mut v[1].b;
    store(r, -9);
    let x: i64 = *r;
    drop(r);
    let y: i64 = v[1].b;
    drop(v);
    return x == -9 && y == -9;
}`)
	exe := filepath.Join(root, "vec-struct-ref.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("struct vec field ref returned exit code 0, want true/1")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("struct vec field ref exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsStructVecFieldRef(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run() -> i64 {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let r = &mut v[1].b;
    store(r, -9);
    let x: i64 = *r;
    drop(r);
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "vec-struct-ref-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 struct-vec-ref ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsDynamicStructVecFieldRefOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let r = &mut v[i].b;
    store(r, -11);
    let x: i64 = *r;
    drop(r);
    let y: i64 = v[i].b;
    drop(v);
    return x == -11 && y == -11;
}`)
	exe := filepath.Join(root, "vec-struct-ref-dynamic.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, index := range []string{"0", "1"} {
		err := exec.Command(exe, index).Run()
		if err == nil {
			t.Fatalf("dynamic struct vec field ref index=%s returned exit code 0, want true/1", index)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != 1 {
			t.Fatalf("dynamic struct vec field ref index=%s exit=%v code=%d output=%s", index, err, exitCode(err), out.String())
		}
	}
}

func TestHIRX64StandaloneCopiesStructElementFromVecOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let p: Pair = v[i];
    let a: u64 = p.a;
    let b: i64 = p.b;
    drop(v);
    return (i == 0 && a == 10 && b == -2) || (i == 1 && a == 20 && b == 4);
}`)
	exe := filepath.Join(root, "vec-struct-copy.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, index := range []string{"0", "1"} {
		err := exec.Command(exe, index).Run()
		if err == nil {
			t.Fatalf("struct element copy index=%s returned exit code 0, want true/1", index)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != 1 {
			t.Fatalf("struct element copy index=%s exit=%v code=%d output=%s", index, err, exitCode(err), out.String())
		}
	}
}

func TestHIRARM64StandaloneBuildsStructVecElementCopy(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> i64 {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }];
    let p: Pair = v[i];
    let b: i64 = p.b;
    drop(v);
    return b;
}`)
	path := filepath.Join(root, "vec-struct-copy-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 struct-vec-copy ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsStructSliceViewOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> bool {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let direct: i64 = s[i].b;
    let p: Pair = s[i];
    let copied: i64 = p.b;
    drop(s);
    drop(v);
    return (i == 0 && direct == 4 && copied == 4) || (i == 1 && direct == 8 && copied == 8);
}`)
	exe := filepath.Join(root, "slice-struct.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, index := range []string{"0", "1"} {
		err := exec.Command(exe, index).Run()
		if err == nil {
			t.Fatalf("struct slice index=%s returned exit code 0, want true/1", index)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != 1 {
			t.Fatalf("struct slice index=%s exit=%v code=%d output=%s", index, err, exitCode(err), out.String())
		}
	}
}

func TestHIRARM64StandaloneBuildsStructSliceView(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> i64 {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let x: i64 = s[i].b;
    drop(s);
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "slice-struct-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 struct-slice ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsStructSliceSharedRefOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: i64; }
fn run(i: u64) -> i64 {
    let v: vec<Pair> = [new Pair { a: 10, b: -2 }, new Pair { a: 20, b: 4 }, new Pair { a: 30, b: 8 }];
    let s: slice<Pair> = v[1:3];
    let r = &s[i].b;
    let x: i64 = *r;
    drop(r);
    drop(s);
    drop(v);
    return x;
}`)
	exe := filepath.Join(root, "slice-struct-ref.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		index string
		want  int
	}{{"0", 4}, {"1", 8}} {
		err := exec.Command(exe, tc.index).Run()
		if err == nil {
			t.Fatalf("struct slice shared ref index=%s returned exit 0 want=%d", tc.index, tc.want)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != tc.want {
			t.Fatalf("struct slice shared ref index=%s exit=%v code=%d want=%d output=%s", tc.index, err, exitCode(err), tc.want, out.String())
		}
	}
}

func TestHIRX64StandaloneStructSliceOOBFailsClosedOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Pair { a: u64; b: u64; }
fn run(i: u64) -> u64 {
    let v: vec<Pair> = [new Pair { a: 10, b: 4 }, new Pair { a: 20, b: 8 }, new Pair { a: 30, b: 12 }];
    let s: slice<Pair> = v[1:3];
    let x: u64 = s[i].b;
    drop(s);
    drop(v);
    return x;
}`)
	exe := filepath.Join(root, "slice-struct-oob.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		index string
		want  int
	}{{"0", 8}, {"1", 12}, {"2", 1}} {
		err := exec.Command(exe, tc.index).Run()
		if err == nil {
			t.Fatalf("struct slice index=%s returned exit 0 want=%d", tc.index, tc.want)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != tc.want {
			t.Fatalf("struct slice index=%s exit=%v code=%d want=%d output=%s", tc.index, err, exitCode(err), tc.want, out.String())
		}
	}
}

func TestHIRX64StandaloneRunsNestedStructVecStorageOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run() -> bool {
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
}`)
	exe := filepath.Join(root, "nested-vec.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("nested struct vec returned exit code 0, want true/1")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 {
		t.Fatalf("nested struct vec exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsNestedStructVecStorage(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run() -> i64 {
    let v: vec<Outer> = [new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 1.5 }];
    vec_push(v, new Outer { inner: new Inner { value: 12, code: 3 }, ratio: 3.5 });
    let copied: Outer = v[1];
    let x: i64 = copied.inner.value;
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "nested-vec-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 nested-struct vec ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneRunsNestedStructSliceOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run(i: u64) -> bool {
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
}`)
	exe := filepath.Join(root, "nested-slice.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	for _, index := range []string{"0", "1"} {
		err := exec.Command(exe, index).Run()
		if err == nil {
			t.Fatalf("nested slice index=%s returned exit 0 want true/1", index)
		}
		exit, ok := err.(*exec.ExitError)
		if !ok || exit.ExitCode() != 1 {
			t.Fatalf("nested slice index=%s exit=%v code=%d output=%s", index, err, exitCode(err), out.String())
		}
	}
}

func TestHIRARM64StandaloneBuildsNestedStructSlice(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
struct Inner { value: i64; code: u64; }
struct Outer { inner: Inner; ratio: ieee64; }
fn run(i: u64) -> i64 {
    let v: vec<Outer> = [
        new Outer { inner: new Inner { value: -2, code: 1 }, ratio: 1.5 },
        new Outer { inner: new Inner { value: 4, code: 2 }, ratio: 2.5 }
    ];
    let s: slice<Outer> = v[0:2];
    let x: i64 = s[i].inner.value;
    drop(s);
    drop(v);
    return x;
}`)
	path := filepath.Join(root, "nested-slice-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 nested-slice ELF size=%d", len(data))
	}
}

func TestHIRX64StandaloneDeferDropsVecParameterOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		t.Skip("runtime validation requires Windows x86-64")
	}
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<u64>) -> u64 {
    defer_drop(v);
    vec_push(v, 40);
    return vec_len(v);
}
fn run() -> u64 {
    let v: vec<u64> = [10,20,30];
    return consume(v);
}`)
	exe := filepath.Join(root, "defer-drop-param.exe")
	var out bytes.Buffer
	if err := hirX64ExeCommand([]string{"-root", root, "-entry", "run", "-format", "pe", "-o", exe, app}, &out); err != nil {
		t.Fatal(err)
	}
	err := exec.Command(exe).Run()
	if err == nil {
		t.Fatal("defer_drop parameter executable returned exit 0, want 4")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 4 {
		t.Fatalf("defer_drop parameter exit=%v code=%d output=%s", err, exitCode(err), out.String())
	}
}

func TestHIRARM64StandaloneBuildsDeferDropVecParameter(t *testing.T) {
	root := t.TempDir()
	app := writeHIRNativeFile(t, root, "app/main.swyp", `module app.main;
fn consume(v: vec<u64>) -> u64 {
    defer_drop(v);
    return vec_len(v);
}
fn run() -> u64 {
    let v: vec<u64> = [10,20,30];
    return consume(v);
}`)
	path := filepath.Join(root, "defer-drop-param-arm64")
	var out bytes.Buffer
	if err := hirARM64ExeCommand([]string{"-root", root, "-entry", "run", "-o", path, app}, &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 64 || binary.LittleEndian.Uint16(data[18:20]) != 183 {
		t.Fatalf("invalid AArch64 defer-drop-param ELF size=%d", len(data))
	}
}

func exitCode(err error) int {
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode()
	}
	return -1
}
