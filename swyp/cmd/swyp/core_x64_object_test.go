package main

import (
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"os"
	"path/filepath"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestCoreX64ObjectCommandFormats(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "mix.swyp")
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
	artifact, err := compileX64PackModuleIR(source, "answer")
	if err != nil {
		t.Fatal(err)
	}
	rawCode, err := emitX64PackedCode(artifact)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		format string
		ext    string
		check  func(*testing.T, string)
	}{
		{"coff", ".obj", func(t *testing.T, path string) {
			f, err := pe.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
				t.Fatalf("machine=0x%x", f.FileHeader.Machine)
			}
			text, err := f.Sections[0].Data()
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(text, rawCode) {
				t.Fatal("COFF .text did not preserve Win64 packed blob")
			}
		}},
		{"elf", ".o", func(t *testing.T, path string) {
			f, err := elf.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if f.Machine != elf.EM_X86_64 || f.Type != elf.ET_REL {
				t.Fatalf("machine=%v type=%v", f.Machine, f.Type)
			}
			text, err := f.Section(".text").Data()
			if err != nil {
				t.Fatal(err)
			}
			if len(text) <= len(rawCode) || bytes.Equal(text, rawCode) {
				t.Fatal("ELF .text is missing SysV entry thunk")
			}
		}},
		{"macho", ".o", func(t *testing.T, path string) {
			f, err := macho.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if f.Cpu != macho.CpuAmd64 || f.Type != macho.TypeObj {
				t.Fatalf("cpu=%v type=%v", f.Cpu, f.Type)
			}
			text, err := f.Section("__text").Data()
			if err != nil {
				t.Fatal(err)
			}
			if len(text) <= len(rawCode) || bytes.Equal(text, rawCode) {
				t.Fatal("Mach-O __text is missing SysV entry thunk")
			}
		}},
	} {
		t.Run(tc.format, func(t *testing.T) {
			path := filepath.Join(dir, tc.format+tc.ext)
			var out bytes.Buffer
			if err := coreX64ObjectCommand([]string{"-format", tc.format, "-entry", "answer", "-o", path, source}, &out); err != nil {
				t.Fatal(err)
			}
			tc.check(t, path)
		})
	}

	var out bytes.Buffer
	if err := coreX64ObjectCommand([]string{"-format", "bad", "-entry", "answer", "-o", filepath.Join(dir, "bad.o"), source}, &out); err == nil {
		t.Fatal("unknown x86-64 object format unexpectedly accepted")
	}
	if err := coreX64ObjectCommand([]string{"-format", "coff", "-entry", "answer", "-o", filepath.Join(dir, "coff.obj"), source}, &out); err == nil {
		// A second invocation targets the same path created in the table above.
		t.Fatal("core-x64-object overwrote existing object")
	}

	_ = coreir.X64LeafSymbol("answer") // keep public object-symbol contract visible in this test surface
}
