package coreir

import (
	"bytes"
	"debug/elf"
	"testing"
)

func TestEncodeX64ELFExecutable(t *testing.T) {
	f := SSAFunction{Name: "answer", Result: I64}
	image, err := EncodeX64ELFExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeX64ELFExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(image, again) {
		t.Fatal("ELF executable emission is not deterministic")
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if ef.Type != elf.ET_EXEC || ef.Machine != elf.EM_X86_64 || ef.Entry == 0 {
		t.Fatalf("type=%v machine=%v entry=0x%x", ef.Type, ef.Machine, ef.Entry)
	}
	if len(ef.Progs) != 1 || ef.Progs[0].Type != elf.PT_LOAD || ef.Progs[0].Flags != elf.PF_R|elf.PF_X {
		t.Fatalf("program headers=%v", ef.Progs)
	}
	text := ef.Section(".text")
	if text == nil || text.Addr != ef.Entry {
		t.Fatalf("text=%v entry=0x%x", text, ef.Entry)
	}
	if libs, err := ef.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
}

func TestEncodeX64ELFExecutableAcceptsScalarParameters(t *testing.T) {
	f := SSAFunction{Name: "sum", Params: []SSAValue{0, 1, 2}, ValueTypes: []Type{I64, U64, Bool}, Result: I64}
	image, err := EncodeX64ELFExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if ef.Type != elf.ET_EXEC || ef.Entry == 0 {
		t.Fatalf("type=%v entry=%x", ef.Type, ef.Entry)
	}
}

func TestEncodeX64ELFExecutableAcceptsIEEE64Parameter(t *testing.T) {
	f := SSAFunction{Name: "cmp", Params: []SSAValue{0}, ValueTypes: []Type{IEEE64}, Result: Bool}
	if _, err := EncodeX64ELFExecutable(f, []byte{0xc3}); err != nil {
		t.Fatal(err)
	}
}

func TestEncodeX64ELFProcessRuntimeArenaIsRWNotExecutable(t *testing.T) {
	f := SSAFunction{Name: "entry", Result: I64}
	image, err := EncodeX64ELFProcessExecutable(f, X64ProcessMachineCode{Code: []byte{0xc3}, RuntimeDataBytes: 64 << 10}, true)
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	data := ef.Section(".data")
	if data == nil {
		t.Fatal(".data runtime arena missing")
	}
	if data.Size != 64<<10 || data.Flags&elf.SHF_ALLOC == 0 || data.Flags&elf.SHF_WRITE == 0 || data.Flags&elf.SHF_EXECINSTR != 0 {
		t.Fatalf("runtime .data=%+v", data.SectionHeader)
	}
	foundRW := false
	for _, prog := range ef.Progs {
		if prog.Flags == elf.PF_R|elf.PF_W && prog.Memsz == 64<<10 {
			foundRW = true
		}
		if prog.Flags&elf.PF_W != 0 && prog.Flags&elf.PF_X != 0 {
			t.Fatalf("W+X segment emitted: %+v", prog.ProgHeader)
		}
	}
	if !foundRW {
		t.Fatalf("RW runtime PT_LOAD missing: %v", ef.Progs)
	}
}

func TestEncodeX64ELFPIEExecutable(t *testing.T) {
	f := SSAFunction{Name: "answer", Result: I64}
	image, err := EncodeX64ELFPIEExecutable(f, []byte{0xc3})
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if ef.Type != elf.ET_DYN || ef.Machine != elf.EM_X86_64 {
		t.Fatalf("type=%v machine=%v", ef.Type, ef.Machine)
	}
	if len(ef.Progs) != 1 || ef.Progs[0].Vaddr != 0 || ef.Progs[0].Paddr != 0 {
		t.Fatalf("program headers=%v", ef.Progs)
	}
	text := ef.Section(".text")
	if text == nil || ef.Entry != text.Addr || text.Addr == 0 {
		t.Fatalf("entry=0x%x text=%v", ef.Entry, text)
	}
	if libs, err := ef.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
}
