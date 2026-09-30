package main

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestCoreARM64ExeCommandCreatesStandaloneELF(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "answer.swyp")
	exePath := filepath.Join(dir, "answer")
	if err := os.WriteFile(source, []byte("fn answer()->i64{return 42;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_EXEC || f.Machine != elf.EM_AARCH64 || f.Entry == 0 {
		t.Fatalf("type=%v machine=%v entry=0x%x", f.Type, f.Machine, f.Entry)
	}
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	if err := coreARM64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err == nil {
		t.Fatal("core-arm64-exe overwrote existing executable")
	}
}

func TestCoreARM64ExeCommandAcceptsScalarParameters(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "id.swyp")
	if err := os.WriteFile(source, []byte("fn id(x:i64)->i64{return x;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "id", "-o", filepath.Join(dir, "id"), source}, &out); err != nil {
		t.Fatal(err)
	}
}

func TestCoreARM64ExeCommandAcceptsIEEE64Parameters(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "cmp.swyp")
	if err := os.WriteFile(source, []byte("fn cmp(c:bool,x:ieee64,y:ieee64)->bool{if c{return x>y;}return x<y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "cmp", "-o", filepath.Join(dir, "cmp"), source}, &out); err != nil {
		t.Fatal(err)
	}
}

func TestCoreARM64ExeCommandPIE(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "answer.swyp")
	exePath := filepath.Join(dir, "answer-pie")
	if err := os.WriteFile(source, []byte("fn answer()->i64{return 42;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-pie", "-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_DYN || f.Machine != elf.EM_AARCH64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
}

func TestCoreARM64ExeCommandRequiresExplicitNetConnectGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "net.swyp")
	if err := os.WriteFile(source, []byte(`fn ping()->bool{return tcp_connect("127.0.0.1",9);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreARM64ExeCommand([]string{"-entry", "ping", "-o", filepath.Join(dir, "net"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "network_connect") || !strings.Contains(err.Error(), "-allow-net-connect") {
		t.Fatalf("net.connect grant error=%v", err)
	}
}

func TestCoreARM64ExeCommandRequiresExplicitNetFetchGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fetch.swyp")
	if err := os.WriteFile(source, []byte(`fn load()->u64{let b:bytes=http_fetch("127.0.0.1",8080,"/");return bytes_len(b);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreARM64ExeCommand([]string{"-entry", "load", "-o", filepath.Join(dir, "fetch"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "network_fetch") || !strings.Contains(err.Error(), "-allow-net-fetch") {
		t.Fatalf("net.fetch grant error=%v", err)
	}
}

func TestCoreARM64ExeCommandProcessExecIsExplicitAndFailClosed(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "exec.swyp")
	if err := os.WriteFile(source, []byte(`fn run()->u64{return process_exec("tool",1,"arg","","","");} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreARM64ExeCommand([]string{"-entry", "run", "-o", filepath.Join(dir, "exec"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "process_exec") || !strings.Contains(err.Error(), "-allow-process-exec") {
		t.Fatalf("process.exec grant error=%v", err)
	}
	err = coreARM64ExeCommand([]string{"-allow-process-exec", "-entry", "run", "-o", filepath.Join(dir, "exec"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "process.exec runtime is not implemented") {
		t.Fatalf("process.exec runtime error=%v", err)
	}
}

func TestCoreARM64ExeCommandRequiresExplicitFSReadGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "read.swyp")
	if err := os.WriteFile(source, []byte(`fn load()->u64{let b:bytes=read_file("input.txt");return bytes_len(b);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreARM64ExeCommand([]string{"-entry", "load", "-o", filepath.Join(dir, "read"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "workspace_read") || !strings.Contains(err.Error(), "-allow-fs-read") {
		t.Fatalf("fs.read grant error=%v", err)
	}
}

func TestCoreARM64ExeCommandLowersFSReadSyscallsAndMutableArena(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "read.swyp")
	exePath := filepath.Join(dir, "read")
	program := `fn load()->u64{let b:bytes=read_file("input.txt");return bytes_get(b,0)+bytes_len(b);} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-allow-fs-read", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	data := f.Section(".data")
	if data == nil || data.Size != coreir.DefaultProcessRuntimeArenaBytes || data.Flags&elf.SHF_WRITE == 0 || data.Flags&elf.SHF_EXECINSTR != 0 {
		t.Fatalf("data=%v", data)
	}
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	found := map[uint32]bool{56: false, 57: false, 62: false, 63: false}
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if word&0xffe0001f == 0xd2800008 && next == 0xd4000001 {
			imm := (word >> 5) & 0xffff
			if _, ok := found[imm]; ok {
				found[imm] = true
			}
		}
	}
	for syscall, ok := range found {
		if !ok {
			t.Fatalf("ARM64 fs.read helper missing syscall %d: %x", syscall, text)
		}
	}
}

func TestCoreARM64ExeCommandLowersStandaloneBytesGet(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "bytes.swyp")
	exePath := filepath.Join(dir, "bytes")
	if err := os.WriteFile(source, []byte(`fn first()->u64{return bytes_get("abc",0);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "first", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Section(".rodata") == nil {
		t.Fatal("ARM64 bytes.get executable missing immutable byte arena")
	}
}

func TestCoreARM64ExeCommandLowersNetConnectSyscalls(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "net.swyp")
	exePath := filepath.Join(dir, "net")
	if err := os.WriteFile(source, []byte(`fn ping()->bool{return tcp_connect("127.0.0.1",9);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-allow-net-connect", "-entry", "ping", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	found := map[uint32]bool{198: false, 203: false, 57: false}
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if word&0xffe0001f == 0xd2800008 && next == 0xd4000001 {
			imm := (word >> 5) & 0xffff
			if _, ok := found[imm]; ok {
				found[imm] = true
			}
		}
	}
	for syscall, ok := range found {
		if !ok {
			t.Fatalf("ARM64 net.connect helper missing syscall %d: %x", syscall, text)
		}
	}
}

func TestCoreARM64ExeCommandLowersNetFetchSyscallsAndMutableArena(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fetch.swyp")
	exePath := filepath.Join(dir, "fetch")
	program := `fn load()->u64{let b:bytes=http_fetch("127.0.0.1",8080,"/health");return bytes_get(b,0)+bytes_len(b);} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-allow-net-fetch", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	data := f.Section(".data")
	if data == nil || data.Size != coreir.DefaultProcessRuntimeArenaBytes || data.Flags&elf.SHF_WRITE == 0 || data.Flags&elf.SHF_EXECINSTR != 0 {
		t.Fatalf("data=%v", data)
	}
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	found := map[uint32]bool{25: false, 57: false, 63: false, 73: false, 198: false, 203: false, 206: false, 208: false, 209: false}
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if word&0xffe0001f == 0xd2800008 && next == 0xd4000001 {
			imm := (word >> 5) & 0xffff
			if _, ok := found[imm]; ok {
				found[imm] = true
			}
		}
	}
	for syscall, ok := range found {
		if !ok {
			t.Fatalf("ARM64 net.fetch helper missing syscall %d: %x", syscall, text)
		}
	}
}

func TestCoreARM64ExeCommandLowersProcessStdout(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "print.swyp")
	exePath := filepath.Join(dir, "print")
	program := `
fn emit(x:i64)->i64 { print(x); return x; }
fn answer(x:i64)->i64 { return emit(x); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	foundWriteSyscall := false
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		// MOVZ x8,#64 followed eventually by SVC #0; accepting adjacency keeps
		// this test focused on the synthesized runtime helper, not wrapper exit(93).
		if word == 0xd2800808 && next == 0xd4000001 {
			foundWriteSyscall = true
			break
		}
	}
	if !foundWriteSyscall {
		t.Fatalf("ARM64 process stdout helper missing write(64) syscall: %x", text)
	}
}

func TestCoreARM64ExeLowersIEEE64PrintFormatter(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-print.swyp")
	exePath := filepath.Join(dir, "show")
	if err := os.WriteFile(source, []byte(`fn show(x:ieee64)->i64{print(x);return 0;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "show", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	foundWrite := false
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if word == 0xd2800808 && next == 0xd4000001 {
			foundWrite = true
			break
		}
	}
	if !foundWrite {
		t.Fatalf("ARM64 ieee64 formatter missing write syscall: %x", text)
	}
}

func TestCoreARM64ExeCommandLowersClockAndStdout(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "clock.swyp")
	exePath := filepath.Join(dir, "clock")
	program := `fn now()->u64{let t:u64=clock();print(t);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "now", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	foundClock, foundWrite := false, false
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if word == 0xd2800e28 && next == 0xd4000001 {
			foundClock = true
		}
		if word == 0xd2800808 && next == 0xd4000001 {
			foundWrite = true
		}
	}
	if !foundClock || !foundWrite {
		t.Fatalf("clock=%v write=%v text=%x", foundClock, foundWrite, text)
	}
}

func TestCoreARM64ExeCommandLowersRNGAndStdout(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "rng.swyp")
	exePath := filepath.Join(dir, "rng")
	program := `fn sample()->u64{let x:u64=random();print(x);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "sample", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	foundRNG, foundWrite := false, false
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if next != 0xd4000001 {
			continue
		}
		if word == 0xd28022c8 { // mov x8,#278 (getrandom)
			foundRNG = true
		}
		if word == 0xd2800808 { // mov x8,#64 (write)
			foundWrite = true
		}
	}
	if !foundRNG || !foundWrite {
		t.Fatalf("rng=%v write=%v text=%x", foundRNG, foundWrite, text)
	}
}

func TestCoreARM64ExeCommandLowersFSWrite(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "write.swyp")
	exePath := filepath.Join(dir, "write-pie")
	program := `fn save()->i64{write_file("swyp-arm64-test.txt","hello-arm64");return 7;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-allow-fs-write", "-pie", "-entry", "save", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_DYN || f.Machine != elf.EM_AARCH64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	foundADR, foundOpenat, foundWrite, foundClose := false, false, false, false
	for i := 0; i+8 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		next := binary.LittleEndian.Uint32(text[i+4 : i+8])
		if word&0x9f000000 == 0x10000000 {
			foundADR = true
		}
		if next == 0xd4000001 {
			switch word {
			case 0xd2800708: // mov x8,#56
				foundOpenat = true
			case 0xd2800808: // mov x8,#64
				foundWrite = true
			case 0xd2800728: // mov x8,#57
				foundClose = true
			}
		}
	}
	if !foundADR || !foundOpenat || !foundWrite || !foundClose {
		t.Fatalf("fs.write runtime missing adr=%v openat=%v write=%v close=%v", foundADR, foundOpenat, foundWrite, foundClose)
	}
	rodata := f.Section(".rodata")
	if rodata == nil || rodata.Flags&elf.SHF_ALLOC == 0 || rodata.Flags&elf.SHF_EXECINSTR != 0 {
		t.Fatalf("rodata=%v", rodata)
	}
	foundROLoad := false
	for _, prog := range f.Progs {
		if prog.Type == elf.PT_LOAD && prog.Off == rodata.Offset {
			foundROLoad = prog.Flags == elf.PF_R
		}
	}
	if !foundROLoad {
		t.Fatalf("read-only PT_LOAD for .rodata missing: progs=%v", f.Progs)
	}
}

func TestCoreARM64ExeCommandRequiresExplicitFSWriteGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "write-grant.swyp")
	if err := os.WriteFile(source, []byte(`fn save()->i64{write_file("x.txt","hello");return 0;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreARM64ExeCommand([]string{"-entry", "save", "-o", filepath.Join(dir, "write"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "-allow-fs-write") {
		t.Fatalf("grant error=%v", err)
	}
}

func TestCoreARM64ExeBytesLenLiteral(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "bytes-len.swyp")
	exePath := filepath.Join(dir, "bytes-len")
	if err := os.WriteFile(source, []byte(`fn length()->u64{return bytes_len("hello");} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ExeCommand([]string{"-entry", "length", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_EXEC || f.Machine != elf.EM_AARCH64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
}
