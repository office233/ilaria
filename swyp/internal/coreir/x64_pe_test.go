package coreir

import (
	"bytes"
	"debug/pe"
	"testing"
)

func TestEncodeX64PEDLL(t *testing.T) {
	code := []byte{0xc3}
	image, err := EncodeX64PEDLL("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeX64PEDLL("entry", code)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(image, again) {
		t.Fatal("PE DLL emission is not deterministic")
	}
	f, err := pe.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if f.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || len(f.Sections) != 3 {
		t.Fatalf("machine=0x%x sections=%d", f.FileHeader.Machine, len(f.Sections))
	}
	textSection := f.Section(".text")
	edataSection := f.Section(".edata")
	relocSection := f.Section(".reloc")
	if textSection == nil || edataSection == nil || relocSection == nil {
		t.Fatalf("sections=%v", f.Sections)
	}
	text, err := textSection.Data()
	if err != nil {
		t.Fatal(err)
	}
	if len(text) < len(code) || !bytes.Equal(text[:len(code)], code) {
		t.Fatalf("text prefix=%x want=%x", text, code)
	}
	opt, ok := f.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		t.Fatalf("optional header type=%T", f.OptionalHeader)
	}
	if opt.DataDirectory[0].VirtualAddress != edataSection.VirtualAddress || opt.AddressOfEntryPoint != 0 {
		t.Fatalf("export=%+v entry=%x", opt.DataDirectory[0], opt.AddressOfEntryPoint)
	}
	if opt.DataDirectory[5].VirtualAddress != relocSection.VirtualAddress || opt.DataDirectory[5].Size != pe64RelocDirectorySize {
		t.Fatalf("reloc=%+v", opt.DataDirectory[5])
	}
	if edataSection.VirtualAddress <= textSection.VirtualAddress || relocSection.VirtualAddress <= edataSection.VirtualAddress {
		t.Fatalf("section RVA order text=0x%x edata=0x%x reloc=0x%x", textSection.VirtualAddress, edataSection.VirtualAddress, relocSection.VirtualAddress)
	}
	if opt.DllCharacteristics&0x60 != 0x60 || opt.DllCharacteristics&0x100 == 0 {
		t.Fatalf("dll characteristics=0x%x", opt.DllCharacteristics)
	}
}
