package coreir

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"testing"
)

func TestEncodeARM64ELFExecutable(t *testing.T) {
	f := SSAFunction{Name: "answer", Result: I64}
	inner := []byte{0xc0, 0x03, 0x5f, 0xd6}
	image, err := EncodeARM64ELFExecutable(f, inner)
	if err != nil {
		t.Fatal(err)
	}
	again, err := EncodeARM64ELFExecutable(f, inner)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(image, again) {
		t.Fatal("ARM64 ELF executable emission is not deterministic")
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if ef.Type != elf.ET_EXEC || ef.Machine != elf.EM_AARCH64 || ef.Entry == 0 {
		t.Fatalf("type=%v machine=%v entry=0x%x", ef.Type, ef.Machine, ef.Entry)
	}
	if len(ef.Progs) != 1 || ef.Progs[0].Type != elf.PT_LOAD || ef.Progs[0].Flags != elf.PF_R|elf.PF_X {
		t.Fatalf("program headers=%v", ef.Progs)
	}
	if libs, err := ef.ImportedLibraries(); err != nil || len(libs) != 0 {
		t.Fatalf("imports=%v err=%v", libs, err)
	}
}

func TestEncodeARM64ELFExecutableAcceptsScalarParameters(t *testing.T) {
	f := SSAFunction{Name: "sum", Params: []SSAValue{0, 1, 2}, ValueTypes: []Type{I64, U64, Bool}, Result: I64}
	image, err := EncodeARM64ELFExecutable(f, []byte{0xc0, 0x03, 0x5f, 0xd6})
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if ef.Type != elf.ET_EXEC || ef.Machine != elf.EM_AARCH64 {
		t.Fatalf("type=%v machine=%v", ef.Type, ef.Machine)
	}
}

func TestEncodeARM64ELFExecutableAcceptsIEEE64Parameters(t *testing.T) {
	f := SSAFunction{Name: "cmp", Params: []SSAValue{0, 1, 2}, ValueTypes: []Type{Bool, IEEE64, IEEE64}, Result: Bool}
	image, err := EncodeARM64ELFExecutable(f, []byte{0xc0, 0x03, 0x5f, 0xd6})
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	text, err := ef.Section(".text").Data()
	if err != nil {
		t.Fatal(err)
	}
	foundSCVTF := false
	for i := 0; i+4 <= len(text); i += 4 {
		word := binary.LittleEndian.Uint32(text[i : i+4])
		if word&0xfffffc00 == 0x9e620000 {
			foundSCVTF = true
			break
		}
	}
	if !foundSCVTF {
		t.Fatalf("ARM64 executable FP argv parser missing SCVTF: %x", text)
	}
}

func TestEncodeARM64ELFExecutableArgumentBankLimits(t *testing.T) {
	gprTypes := make([]Type, 8)
	gprParams := make([]SSAValue, 8)
	for i := range gprTypes {
		gprTypes[i] = I64
		gprParams[i] = SSAValue(i)
	}
	tooManyGPR := SSAFunction{Name: "gpr", Params: gprParams, ValueTypes: gprTypes, Result: I64}
	if _, err := EncodeARM64ELFExecutable(tooManyGPR, []byte{0xc0, 0x03, 0x5f, 0xd6}); err == nil {
		t.Fatal("eight GPR program parameters unexpectedly accepted; x7 is reserved for status")
	}

	fpTypes := make([]Type, 9)
	fpParams := make([]SSAValue, 9)
	for i := range fpTypes {
		fpTypes[i] = IEEE64
		fpParams[i] = SSAValue(i)
	}
	tooManyFP := SSAFunction{Name: "fp", Params: fpParams, ValueTypes: fpTypes, Result: Bool}
	if _, err := EncodeARM64ELFExecutable(tooManyFP, []byte{0xc0, 0x03, 0x5f, 0xd6}); err == nil {
		t.Fatal("nine FP parameters unexpectedly accepted")
	}

	mixedTypes := make([]Type, 15)
	mixedParams := make([]SSAValue, 15)
	for i := 0; i < 7; i++ {
		mixedTypes[i] = I64
		mixedParams[i] = SSAValue(i)
	}
	for i := 7; i < 15; i++ {
		mixedTypes[i] = IEEE64
		mixedParams[i] = SSAValue(i)
	}
	mixed := SSAFunction{Name: "mixed", Params: mixedParams, ValueTypes: mixedTypes, Result: Bool}
	if _, err := EncodeARM64ELFExecutable(mixed, []byte{0xc0, 0x03, 0x5f, 0xd6}); err != nil {
		t.Fatalf("maximal 7-GPR/8-FP signature rejected: %v", err)
	}
}

func TestEncodeARM64ELFProcessRuntimeArenaIsRWNotExecutable(t *testing.T) {
	f := SSAFunction{Name: "entry", Result: I64}
	inner := []byte{0xc0, 0x03, 0x5f, 0xd6}
	image, err := EncodeARM64ELFProcessExecutable(f, ARM64ProcessMachineCode{Code: inner, RuntimeDataBytes: 64 << 10}, true)
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

func TestEncodeARM64ELFPIEExecutable(t *testing.T) {
	f := SSAFunction{Name: "answer", Result: I64}
	inner := []byte{0xc0, 0x03, 0x5f, 0xd6}
	image, err := EncodeARM64ELFPIEExecutable(f, inner)
	if err != nil {
		t.Fatal(err)
	}
	ef, err := elf.NewFile(bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if ef.Type != elf.ET_DYN || ef.Machine != elf.EM_AARCH64 {
		t.Fatalf("type=%v machine=%v", ef.Type, ef.Machine)
	}
	if len(ef.Progs) != 1 || ef.Progs[0].Vaddr != 0 || ef.Progs[0].Paddr != 0 {
		t.Fatalf("program headers=%v", ef.Progs)
	}
	text := ef.Section(".text")
	if text == nil || ef.Entry != text.Addr || text.Addr == 0 {
		t.Fatalf("entry=0x%x text=%v", ef.Entry, text)
	}
}
