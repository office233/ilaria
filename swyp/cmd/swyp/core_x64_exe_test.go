package main

import (
	"bytes"
	"debug/elf"
	"debug/pe"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreX64ExeCommandCreatesStandaloneImage(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "answer.swyp")
	exePath := filepath.Join(dir, "answer.exe")
	if err := os.WriteFile(source, []byte("fn answer()->i64{return 42;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := pe.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || f.Section(".text") == nil || f.Section(".idata") == nil || f.Section(".reloc") == nil {
		t.Fatalf("machine=0x%x sections=%v", f.FileHeader.Machine, f.Sections)
	}
	if f.FileHeader.Characteristics&0x2000 != 0 {
		t.Fatalf("standalone EXE unexpectedly marked as DLL: 0x%x", f.FileHeader.Characteristics)
	}
	if err := coreX64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err == nil {
		t.Fatal("core-x64-exe overwrote existing executable")
	}
}

func TestCoreX64ExeCommandAcceptsScalarParameters(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "id.swyp")
	if err := os.WriteFile(source, []byte("fn id(x:i64)->i64{return x;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "id", "-o", filepath.Join(dir, "id.exe"), source}, &out); err != nil {
		t.Fatal(err)
	}
}

func TestCoreX64ExeCommandAcceptsIEEE64Parameters(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "cmp.swyp")
	if err := os.WriteFile(source, []byte("fn cmp(x:ieee64,y:ieee64)->bool{return x>y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "cmp", "-o", filepath.Join(dir, "cmp.exe"), source}, &out); err != nil {
		t.Fatal(err)
	}
}

func TestCoreX64ExeCommandBuildsBytesGetWithArenaMapping(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "bytes-get.swyp")
	exePath := filepath.Join(dir, "first.exe")
	if err := os.WriteFile(source, []byte(`fn first()->u64{return bytes_get("abc",0);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "first", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	pf, err := pe.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer pf.Close()
	rdata := pf.Section(".rdata")
	if rdata == nil || rdata.Characteristics&0x40000000 == 0 || rdata.Characteristics&0x20000000 != 0 || rdata.Characteristics&0x80000000 != 0 {
		t.Fatalf("rdata=%v", rdata)
	}
}

func TestCoreX64ExeCommandBuildsLinuxFSWrite(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "write-linux.swyp")
	exePath := filepath.Join(dir, "write-linux")
	if err := os.WriteFile(source, []byte(`fn save()->i64{write_file("swyp-linux-test.txt","hello");return 7;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-fs-write", "-format", "elf", "-pie", "-entry", "save", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_DYN || f.Machine != elf.EM_X86_64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
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

func TestCoreX64ExeCommandRequiresExplicitFSWriteGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "write-grant.swyp")
	if err := os.WriteFile(source, []byte(`fn save()->i64{write_file("x.txt","hello");return 0;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64ExeCommand([]string{"-entry", "save", "-o", filepath.Join(dir, "write.exe"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "-allow-fs-write") {
		t.Fatalf("grant error=%v", err)
	}
}

func TestCoreX64ExeCommandRequiresExplicitFSReadGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "read.swyp")
	if err := os.WriteFile(source, []byte(`fn load()->u64{let b:bytes=read_file("input.txt");return bytes_len(b);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64ExeCommand([]string{"-entry", "load", "-o", filepath.Join(dir, "read.exe"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "workspace_read") || !strings.Contains(err.Error(), "-allow-fs-read") {
		t.Fatalf("fs.read grant error=%v", err)
	}
}

func TestCoreX64ExeCommandRequiresExplicitNetConnectGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "net.swyp")
	if err := os.WriteFile(source, []byte(`fn ping()->bool{return tcp_connect("127.0.0.1",1);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64ExeCommand([]string{"-entry", "ping", "-o", filepath.Join(dir, "net.exe"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "network_connect") || !strings.Contains(err.Error(), "-allow-net-connect") {
		t.Fatalf("net.connect grant error=%v", err)
	}
}

func TestCoreX64ExeCommandRequiresExplicitNetFetchGrant(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fetch.swyp")
	if err := os.WriteFile(source, []byte(`fn load()->u64{let b:bytes=http_fetch("127.0.0.1",8080,"/");return bytes_len(b);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64ExeCommand([]string{"-entry", "load", "-o", filepath.Join(dir, "fetch.exe"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "network_fetch") || !strings.Contains(err.Error(), "-allow-net-fetch") {
		t.Fatalf("net.fetch grant error=%v", err)
	}
}

func TestCoreX64ExeCommandProcessExecIsExplicitAndFailClosed(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "exec.swyp")
	if err := os.WriteFile(source, []byte(`fn run()->u64{return process_exec("tool.exe",1,"arg","","","");} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := coreX64ExeCommand([]string{"-entry", "run", "-o", filepath.Join(dir, "exec.exe"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "process_exec") || !strings.Contains(err.Error(), "-allow-process-exec") {
		t.Fatalf("process.exec grant error=%v", err)
	}
	err = coreX64ExeCommand([]string{"-allow-process-exec", "-entry", "run", "-o", filepath.Join(dir, "exec.exe"), source}, &out)
	if err == nil || !strings.Contains(err.Error(), "process.exec runtime is not implemented") {
		t.Fatalf("process.exec runtime error=%v", err)
	}
}

func TestCoreX64ExeCommandBuildsStaticELFNetConnect(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "net-linux.swyp")
	exePath := filepath.Join(dir, "net-linux")
	if err := os.WriteFile(source, []byte(`fn ping()->bool{return tcp_connect("127.0.0.1",9);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-net-connect", "-format", "elf", "-entry", "ping", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_EXEC || f.Machine != elf.EM_X86_64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	for _, imm := range []byte{41, 42, 3} {
		needle := []byte{0x48, 0xb8, imm, 0, 0, 0, 0, 0, 0, 0}
		if !bytes.Contains(text, needle) {
			t.Fatalf("syscall %d load missing from text", imm)
		}
	}
}

func TestCoreX64ExeCommandBuildsStaticELFNetFetch(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fetch-linux.swyp")
	exePath := filepath.Join(dir, "fetch-linux")
	program := "fn load()->u64{let b:bytes=http_fetch(\"127.0.0.1\",8080,\"/health\");return bytes_len(b);} fn main(){}"
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-net-fetch", "-format", "elf", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_EXEC || f.Machine != elf.EM_X86_64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
	if libs, err := f.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
	text, err := f.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	wantSyscalls := map[uint64]bool{3: false, 41: false, 42: false, 44: false, 54: false, 55: false, 72: false, 271: false}
	for i := 0; i+10 <= len(text); i++ {
		if text[i] == 0x48 && text[i+1] == 0xb8 {
			imm := binary.LittleEndian.Uint64(text[i+2 : i+10])
			if _, ok := wantSyscalls[imm]; ok {
				wantSyscalls[imm] = true
			}
		}
	}
	for syscall, found := range wantSyscalls {
		if !found {
			t.Fatalf("net.fetch helper missing syscall %d", syscall)
		}
	}
	foundRWNonX := false
	for _, p := range f.Progs {
		if p.Type == elf.PT_LOAD && p.Flags&elf.PF_W != 0 {
			foundRWNonX = true
			if p.Flags&elf.PF_X != 0 {
				t.Fatalf("runtime data segment is executable: flags=%v", p.Flags)
			}
		}
	}
	if !foundRWNonX {
		t.Fatal("runtime data segment missing")
	}
}

func TestCoreX64ExeCommandPIE(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "answer.swyp")
	exePath := filepath.Join(dir, "answer-pie")
	if err := os.WriteFile(source, []byte("fn answer()->i64{return 42;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-format", "elf", "-pie", "-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_DYN || f.Machine != elf.EM_X86_64 {
		t.Fatalf("type=%v machine=%v", f.Type, f.Machine)
	}
	if err := coreX64ExeCommand([]string{"-format", "pe", "-pie", "-entry", "answer", "-o", filepath.Join(dir, "bad.exe"), source}, &out); err == nil {
		t.Fatal("-pie unexpectedly accepted for PE")
	}
}
