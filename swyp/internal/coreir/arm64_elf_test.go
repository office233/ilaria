package coreir

import (
	"bytes"
	"debug/elf"
	"testing"
)

func TestEncodeARM64ELFObject(t *testing.T) {
	code := []byte{0xc0, 0x03, 0x5f, 0xd6} // ret
	object, err := EncodeARM64ELFObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeARM64ELFObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(object, again) {
		t.Fatal("ARM64 ELF object emission is not deterministic")
	}
	f, err := elf.NewFile(bytes.NewReader(object))
	if err != nil {
		t.Fatal(err)
	}
	if f.Class != elf.ELFCLASS64 || f.Data != elf.ELFDATA2LSB || f.Type != elf.ET_REL || f.Machine != elf.EM_AARCH64 {
		t.Fatalf("header class=%v data=%v type=%v machine=%v", f.Class, f.Data, f.Type, f.Machine)
	}
	text := f.Section(".text")
	if text == nil {
		t.Fatal(".text missing")
	}
	gotCode, err := text.Data()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotCode, code) {
		t.Fatalf("text=%x want=%x", gotCode, code)
	}
	symbols, err := f.Symbols()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, symbol := range symbols {
		if symbol.Name == ARM64LeafSymbol("entry") {
			found = true
			if symbol.Section != elf.SectionIndex(1) || symbol.Value != 0 || symbol.Size != uint64(len(code)) {
				t.Fatalf("symbol=%+v", symbol)
			}
		}
	}
	if !found {
		t.Fatalf("entry symbol %q missing", ARM64LeafSymbol("entry"))
	}
}

func TestEncodeARM64ELFObjectRejectsInvalidInput(t *testing.T) {
	if _, err := EncodeARM64ELFObject("../bad", []byte{0, 0, 0, 0}); err == nil {
		t.Fatal("invalid entry unexpectedly accepted")
	}
	if _, err := EncodeARM64ELFObject("entry", []byte{0}); err == nil {
		t.Fatal("unaligned machine code unexpectedly accepted")
	}
}
