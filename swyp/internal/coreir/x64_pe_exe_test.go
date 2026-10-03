package coreir

import (
	"bytes"
	"debug/pe"
	"testing"
)

func TestEncodeX64PEExecutable(t *testing.T) {
	f := SSAFunction{Name: "answer", Result: I64}
	image, err := EncodeX64PEExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeX64PEExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(image, again) {
		t.Fatal("PE executable emission is not deterministic")
	}
	pf, err := pe.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if pf.FileHeader.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || len(pf.Sections) != 3 {
		t.Fatalf("machine=0x%x sections=%d", pf.FileHeader.Machine, len(pf.Sections))
	}
	textSection := pf.Section(".text")
	idataSection := pf.Section(".idata")
	relocSection := pf.Section(".reloc")
	if textSection == nil || idataSection == nil || relocSection == nil {
		t.Fatalf("sections=%v", pf.Sections)
	}
	opt, ok := pf.OptionalHeader.(*pe.OptionalHeader64)
	if !ok {
		t.Fatalf("optional=%T", pf.OptionalHeader)
	}
	if opt.AddressOfEntryPoint != pe64TextRVA || opt.DataDirectory[1].VirtualAddress != idataSection.VirtualAddress || opt.DataDirectory[5].VirtualAddress != relocSection.VirtualAddress {
		t.Fatalf("entry=0x%x import=%+v reloc=%+v", opt.AddressOfEntryPoint, opt.DataDirectory[1], opt.DataDirectory[5])
	}
	if idataSection.VirtualAddress <= textSection.VirtualAddress || relocSection.VirtualAddress <= idataSection.VirtualAddress {
		t.Fatalf("section RVA order text=0x%x idata=0x%x reloc=0x%x", textSection.VirtualAddress, idataSection.VirtualAddress, relocSection.VirtualAddress)
	}
	imports, err := pf.ImportedSymbols()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, name := range imports {
		if name == "ExitProcess:KERNEL32.dll" {
			found = true
		}
	}
	if !found {
		t.Fatalf("imports=%v", imports)
	}
}

func TestEncodeX64PEExecutableAcceptsScalarParameters(t *testing.T) {
	f := SSAFunction{Name: "sum", Params: []SSAValue{0, 1, 2}, ValueTypes: []Type{I64, U64, Bool}, Result: I64}
	image, err := EncodeX64PEExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	pf, err := pe.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	imports, err := pf.ImportedSymbols()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, name := range imports {
		seen[name] = true
	}
	if !seen["ExitProcess:KERNEL32.dll"] || !seen["GetCommandLineA:KERNEL32.dll"] {
		t.Fatalf("imports=%v", imports)
	}
}

func TestEncodeX64PEExecutableAcceptsIEEE64Parameter(t *testing.T) {
	f := SSAFunction{Name: "cmp", Params: []SSAValue{0}, ValueTypes: []Type{IEEE64}, Result: Bool}
	image, err := EncodeX64PEExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	pf, err := pe.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	imports, err := pf.ImportedSymbols()
	if err != nil {
		t.Fatal(err)
	}
	seen := false
	for _, name := range imports {
		if name == "GetCommandLineA:KERNEL32.dll" {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("imports=%v", imports)
	}
}

func TestEncodeX64PEProcessRuntimeArenaIsRWNotExecutable(t *testing.T) {
	f := SSAFunction{Name: "entry", Result: I64}
	image, err := EncodeX64PEProcessExecutable(f, X64ProcessMachineCode{
		Code:             []byte{0xc3},
		RuntimeDataBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	pf, err := pe.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	data := pf.Section(".data")
	if data == nil {
		t.Fatal(".data runtime arena missing")
	}
	if data.VirtualSize != 64<<10 || data.Characteristics&0x40000000 == 0 || data.Characteristics&0x80000000 == 0 || data.Characteristics&0x20000000 != 0 {
		t.Fatalf("runtime .data=%+v", data.SectionHeader)
	}
	raw, err := data.Data()
	if err != nil {
		t.Fatal(err)
	}
	for i, b := range raw {
		if b != 0 {
			t.Fatalf("runtime arena byte %d=%d, want zero", i, b)
		}
	}
}

func TestEncodeX64PEProcessRuntimeArenaRejectsOversize(t *testing.T) {
	f := SSAFunction{Name: "entry", Result: I64}
	_, err := EncodeX64PEProcessExecutable(f, X64ProcessMachineCode{Code: []byte{0xc3}, RuntimeDataBytes: MaxProcessRuntimeArenaBytes + 1})
	if err == nil {
		t.Fatal("oversized runtime arena unexpectedly accepted")
	}
}
