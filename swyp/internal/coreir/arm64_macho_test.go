package coreir

import (
	"bytes"
	"debug/macho"
	"testing"
)

func TestEncodeARM64MachOObject(t *testing.T) {
	code := []byte{0xc0, 0x03, 0x5f, 0xd6}
	object, err := EncodeARM64MachOObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeARM64MachOObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(object, again) {
		t.Fatal("ARM64 Mach-O object emission is not deterministic")
	}
	f, err := macho.NewFile(bytes.NewReader(object))
	if err != nil {
		t.Fatal(err)
	}
	if f.Cpu != macho.CpuArm64 || f.Type != macho.TypeObj {
		t.Fatalf("cpu=%v type=%v", f.Cpu, f.Type)
	}
	section := f.Section("__text")
	if section == nil || section.Seg != "__TEXT" {
		t.Fatalf("section=%v", section)
	}
	gotCode, err := section.Data()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotCode, code) {
		t.Fatalf("text=%x want=%x", gotCode, code)
	}
	if f.Symtab == nil {
		t.Fatal("symbol table missing")
	}
	want := "_" + ARM64LeafSymbol("entry")
	found := false
	for _, symbol := range f.Symtab.Syms {
		if symbol.Name == want {
			found = true
			if symbol.Sect != 1 || symbol.Value != 0 {
				t.Fatalf("symbol=%+v", symbol)
			}
		}
	}
	if !found {
		t.Fatalf("entry symbol %q missing", want)
	}
}
