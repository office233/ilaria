package coreir

import (
	"bytes"
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"testing"
)

func TestEncodeX64ObjectFormats(t *testing.T) {
	code := []byte{0xc3}
	for _, tc := range []struct {
		name  string
		make  func(string, []byte) ([]byte, error)
		check func(*testing.T, []byte)
	}{
		{"elf", EncodeX64ELFObject, func(t *testing.T, object []byte) {
			f, err := elf.NewFile(bytes.NewReader(object))
			if err != nil {
				t.Fatal(err)
			}
			if f.Machine != elf.EM_X86_64 || f.Type != elf.ET_REL || f.Section(".text") == nil {
				t.Fatalf("machine=%v type=%v", f.Machine, f.Type)
			}
		}},
		{"coff", EncodeX64COFFObject, func(t *testing.T, object []byte) {
			f, err := pe.NewFile(bytes.NewReader(object))
			if err != nil {
				t.Fatal(err)
			}
			if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || len(f.Sections) != 1 || f.Sections[0].Name != ".text" {
				t.Fatalf("machine=0x%x sections=%v", f.FileHeader.Machine, f.Sections)
			}
		}},
		{"macho", EncodeX64MachOObject, func(t *testing.T, object []byte) {
			f, err := macho.NewFile(bytes.NewReader(object))
			if err != nil {
				t.Fatal(err)
			}
			if f.Cpu != macho.CpuAmd64 || f.Type != macho.TypeObj || f.Section("__text") == nil {
				t.Fatalf("cpu=%v type=%v", f.Cpu, f.Type)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			object, err := tc.make("entry", code)
			if err != nil {
				t.Fatal(err)
			}
			again, err := tc.make("entry", code)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(object, again) {
				t.Fatal("object emission is not deterministic")
			}
			tc.check(t, object)
		})
	}
}

func TestX64ObjectSymbols(t *testing.T) {
	code := []byte{0xc3}
	elfObject, err := EncodeX64ELFObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(elfObject))
	if err != nil {
		t.Fatal(err)
	}
	syms, err := ef.Symbols()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range syms {
		if s.Name == X64LeafSymbol("entry") {
			found = true
		}
	}
	if !found {
		t.Fatalf("ELF symbol %q missing", X64LeafSymbol("entry"))
	}

	coffObject, err := EncodeX64COFFObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	cf, err := pe.NewFile(bytes.NewReader(coffObject))
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, s := range cf.Symbols {
		if s.Name == X64LeafSymbol("entry") {
			found = true
		}
	}
	if !found {
		t.Fatalf("COFF symbol %q missing", X64LeafSymbol("entry"))
	}

	machObject, err := EncodeX64MachOObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	mf, err := macho.NewFile(bytes.NewReader(machObject))
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, s := range mf.Symtab.Syms {
		if s.Name == "_"+X64LeafSymbol("entry") {
			found = true
		}
	}
	if !found {
		t.Fatalf("Mach-O symbol %q missing", "_"+X64LeafSymbol("entry"))
	}
}
