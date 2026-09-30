package coreir

import (
	"bytes"
	"debug/pe"
	"testing"
)

func TestEncodeARM64COFFObject(t *testing.T) {
	code := []byte{0xc0, 0x03, 0x5f, 0xd6}
	object, err := EncodeARM64COFFObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeARM64COFFObject("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(object, again) {
		t.Fatal("ARM64 COFF object emission is not deterministic")
	}
	f, err := pe.NewFile(bytes.NewReader(object))
	if err != nil {
		t.Fatal(err)
	}
	if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_ARM64 || len(f.Sections) != 1 || f.Sections[0].Name != ".text" {
		t.Fatalf("machine=0x%x sections=%v", f.FileHeader.Machine, f.Sections)
	}
	gotCode, err := f.Sections[0].Data()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotCode, code) {
		t.Fatalf("text=%x want=%x", gotCode, code)
	}
	found := false
	for _, symbol := range f.Symbols {
		if symbol.Name == ARM64LeafSymbol("entry") {
			found = true
			if symbol.SectionNumber != 1 || symbol.Value != 0 || symbol.StorageClass != coffStorageClassExternal {
				t.Fatalf("symbol=%+v", symbol)
			}
		}
	}
	if !found {
		t.Fatalf("entry symbol %q missing", ARM64LeafSymbol("entry"))
	}
}
