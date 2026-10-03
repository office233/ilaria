package main

import (
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestCoreARM64ObjectCommand(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-call.swyp")
	objectPath := filepath.Join(dir, "fp-call.o")
	program := `
fn choose(c:bool,x:ieee64,y:ieee64)->ieee64 {
  let i:i64=0;
  while i<1 {
    if c { return x; }
    i=i+1;
  }
  return y;
}
fn answer(c:bool,x:ieee64,y:ieee64)->ieee64 { return choose(c,x,y); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreARM64ObjectCommand([]string{"-entry", "answer", "-o", objectPath, source}, &out); err != nil {
		t.Fatal(err)
	}
	f, err := elf.Open(objectPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if f.Type != elf.ET_REL || f.Machine != elf.EM_AARCH64 || f.Section(".text") == nil {
		t.Fatalf("type=%v machine=%v text=%v", f.Type, f.Machine, f.Section(".text"))
	}
	symbols, err := f.Symbols()
	if err != nil {
		t.Fatal(err)
	}
	want := coreir.ARM64LeafSymbol("answer")
	found := false
	for _, symbol := range symbols {
		if symbol.Name == want {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("symbol %q missing", want)
	}
	if !strings.Contains(out.String(), want) {
		t.Fatalf("output=%q", out.String())
	}
	if err := coreARM64ObjectCommand([]string{"-entry", "answer", "-o", objectPath, source}, &out); err == nil {
		t.Fatal("core-arm64-object overwrote existing object")
	}
}

func TestCoreARM64ObjectCommandFormats(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		format string
		ext    string
		check  func(*testing.T, string)
	}{
		{"elf", ".o", func(t *testing.T, path string) {
			f, err := elf.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if f.Machine != elf.EM_AARCH64 || f.Type != elf.ET_REL {
				t.Fatalf("machine=%v type=%v", f.Machine, f.Type)
			}
		}},
		{"coff", ".obj", func(t *testing.T, path string) {
			f, err := pe.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_ARM64 {
				t.Fatalf("machine=0x%x", f.FileHeader.Machine)
			}
		}},
		{"macho", ".o", func(t *testing.T, path string) {
			f, err := macho.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if f.Cpu != macho.CpuArm64 || f.Type != macho.TypeObj {
				t.Fatalf("cpu=%v type=%v", f.Cpu, f.Type)
			}
		}},
	} {
		t.Run(tc.format, func(t *testing.T) {
			path := filepath.Join(dir, tc.format+tc.ext)
			var out bytes.Buffer
			if err := coreARM64ObjectCommand([]string{"-format", tc.format, "-entry", "add", "-o", path, source}, &out); err != nil {
				t.Fatal(err)
			}
			tc.check(t, path)
		})
	}

	var out bytes.Buffer
	if err := coreARM64ObjectCommand([]string{"-format", "unknown", "-entry", "add", "-o", filepath.Join(dir, "bad.o"), source}, &out); err == nil {
		t.Fatal("unknown object format unexpectedly accepted")
	}
}
