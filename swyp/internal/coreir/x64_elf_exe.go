package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	elfETExec            = 2
	elfETDyn             = 3
	elfPTLoad            = 1
	elfPFR               = 4
	elfPFW               = 2
	elfPFX               = 1
	elf64ProgramSize     = 56
	x64ELFExecutableBase = uint64(0x400000)
)

// EncodeX64ELFExecutable emits a static ELF64/x86-64 executable with no libc,
// PT_INTERP or dynamic loader. Linux argc/argv are parsed directly by _start for
// i64/u64/bool parameters, then staged into the existing Win64 packed ABI. The
// process terminates via syscall exit(60).
func EncodeX64ELFExecutable(f SSAFunction, code []byte) ([]byte, error) {
	return encodeX64ELFExecutable(f, code, false, nil, nil, 0)
}

// EncodeX64ELFPIEExecutable emits the same static no-libc program as
// EncodeX64ELFExecutable, but as ET_DYN with a zero-based load segment. All
// generated control flow is PC-relative, so no runtime relocation table is
// required for the process image itself.
func EncodeX64ELFPIEExecutable(f SSAFunction, code []byte) ([]byte, error) {
	return encodeX64ELFExecutable(f, code, true, nil, nil, 0)
}

func EncodeX64ELFProcessExecutable(f SSAFunction, process X64ProcessMachineCode, pie bool) ([]byte, error) {
	code, dataFixups, err := resolveX64LinuxProcessRuntime(process)
	if err != nil {
		return nil, err
	}
	return encodeX64ELFExecutable(f, code, pie, process.Data, dataFixups, process.RuntimeDataBytes)
}

func encodeX64ELFExecutable(f SSAFunction, code []byte, pie bool, rodata []byte, dataFixups []x64ProcessDataFixup, runtimeDataBytes int) ([]byte, error) {
	if !validX64EntryName(f.Name) {
		return nil, fmt.Errorf("x64 elf exe: invalid entry name")
	}
	if err := validateX64ExecutableSignature(f); err != nil {
		return nil, fmt.Errorf("x64 elf exe: %w", err)
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 elf exe: invalid code size %d", len(code))
	}
	if runtimeDataBytes < 0 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, fmt.Errorf("x64 elf exe: invalid runtime data size %d", runtimeDataBytes)
	}
	text, err := makeX64LinuxExecutableText(f, code)
	if err != nil {
		return nil, err
	}

	programCount := 1
	if len(rodata) != 0 {
		programCount++
	}
	if runtimeDataBytes != 0 {
		programCount++
	}
	textOff := alignELF(elf64HeaderSize+programCount*elf64ProgramSize, 16)
	imageBase := x64ELFExecutableBase
	elfType := uint16(elfETExec)
	if pie {
		imageBase = 0
		elfType = elfETDyn
	}
	textVA := imageBase + uint64(textOff)
	rodataOff := 0
	rodataVA := uint64(0)
	metadataStart := textOff + len(text)
	if len(rodata) != 0 {
		rodataOff = alignELF(metadataStart, 0x1000)
		rodataVA = imageBase + uint64(rodataOff)
		metadataStart = rodataOff + len(rodata)
	}
	runtimeDataOff := 0
	runtimeDataVA := uint64(0)
	if runtimeDataBytes != 0 {
		runtimeDataOff = alignELF(metadataStart, 0x1000)
		runtimeDataVA = imageBase + uint64(runtimeDataOff)
		metadataStart = runtimeDataOff + runtimeDataBytes
	}
	innerOffset := len(text) - len(code)
	for _, fixup := range dataFixups {
		dispPos := innerOffset + fixup.DispPos
		if dispPos < 0 || dispPos+4 > len(text) {
			return nil, fmt.Errorf("x64 elf exe: data fixup outside text")
		}
		targetVA := rodataVA
		label := "rodata"
		if fixup.Target == processDataRuntime {
			targetVA = runtimeDataVA
			label = "runtime data"
		}
		if targetVA == 0 && !(pie && fixup.Target == processDataModule && rodataOff == 0) {
			return nil, fmt.Errorf("x64 elf exe: %s fixup without segment", label)
		}
		nextVA := textVA + uint64(dispPos+4)
		rel := int64(targetVA) - int64(nextVA)
		if rel < -(1<<31) || rel >= 1<<31 {
			return nil, fmt.Errorf("x64 elf exe: %s displacement out of range", label)
		}
		binary.LittleEndian.PutUint32(text[dispPos:dispPos+4], uint32(int32(rel)))
	}
	symtabOff := alignELF(metadataStart, 8)
	const symbolCount = 3
	symtabSize := symbolCount * elf64SymbolSize
	strtab := append([]byte{0}, []byte(X64LeafSymbol(f.Name))...)
	strtab = append(strtab, 0)
	strtabOff := symtabOff + symtabSize
	shstrtab := []byte("\x00.text\x00.rodata\x00.data\x00.symtab\x00.strtab\x00.shstrtab\x00")
	shstrtabOff := strtabOff + len(strtab)
	sectionHeaderOff := alignELF(shstrtabOff+len(shstrtab), 8)
	sectionCount := 5
	if len(rodata) != 0 {
		sectionCount++
	}
	if runtimeDataBytes != 0 {
		sectionCount++
	}
	totalSize := sectionHeaderOff + sectionCount*elf64SectionSize
	out := make([]byte, totalSize)

	copy(out[0:4], []byte{0x7f, 'E', 'L', 'F'})
	out[4], out[5], out[6] = 2, 1, 1
	put16 := func(off int, v uint16) { binary.LittleEndian.PutUint16(out[off:off+2], v) }
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	put16(16, elfType)
	put16(18, elfEMX8664)
	put32(20, 1)
	put64(24, textVA)
	put64(32, elf64HeaderSize)
	put64(40, uint64(sectionHeaderOff))
	put16(52, elf64HeaderSize)
	put16(54, elf64ProgramSize)
	put16(56, uint16(programCount))
	put16(58, elf64SectionSize)
	put16(60, uint16(sectionCount))
	shstrIndex := uint16(sectionCount - 1)
	put16(62, shstrIndex)

	// One RX PT_LOAD maps headers and .text. Symbol/string/section tables remain
	// file-only metadata after the loaded range.
	ph := elf64HeaderSize
	put32(ph, elfPTLoad)
	put32(ph+4, elfPFR|elfPFX)
	put64(ph+8, 0)
	put64(ph+16, imageBase)
	put64(ph+24, imageBase)
	put64(ph+32, uint64(textOff+len(text)))
	put64(ph+40, uint64(textOff+len(text)))
	put64(ph+48, 0x1000)
	if len(rodata) != 0 {
		ph2 := ph + elf64ProgramSize
		put32(ph2, elfPTLoad)
		put32(ph2+4, elfPFR)
		put64(ph2+8, uint64(rodataOff))
		put64(ph2+16, rodataVA)
		put64(ph2+24, rodataVA)
		put64(ph2+32, uint64(len(rodata)))
		put64(ph2+40, uint64(len(rodata)))
		put64(ph2+48, 0x1000)
	}
	if runtimeDataBytes != 0 {
		phData := ph + elf64ProgramSize
		if len(rodata) != 0 {
			phData += elf64ProgramSize
		}
		put32(phData, elfPTLoad)
		put32(phData+4, elfPFR|elfPFW)
		put64(phData+8, uint64(runtimeDataOff))
		put64(phData+16, runtimeDataVA)
		put64(phData+24, runtimeDataVA)
		put64(phData+32, uint64(runtimeDataBytes))
		put64(phData+40, uint64(runtimeDataBytes))
		put64(phData+48, 0x1000)
	}

	copy(out[textOff:], text)
	if len(rodata) != 0 {
		copy(out[rodataOff:], rodata)
	}
	writeARM64ELFSymbol(out[symtabOff:symtabOff+elf64SymbolSize], 0, 0, 0, 0, 0, 0)
	writeARM64ELFSymbol(out[symtabOff+elf64SymbolSize:symtabOff+2*elf64SymbolSize], 0, elfSTTSection, 0, 1, textVA, 0)
	writeARM64ELFSymbol(out[symtabOff+2*elf64SymbolSize:symtabOff+3*elf64SymbolSize], 1, elfSTBGlobal<<4|elfSTTFunc, 0, 1, textVA, uint64(len(text)))
	copy(out[strtabOff:], strtab)
	copy(out[shstrtabOff:], shstrtab)
	writeARM64ELFSection(out[sectionHeaderOff+elf64SectionSize:], 1, elfSHTProgbit, elfSHFAlloc|elfSHFExec, uint64(textOff), uint64(len(text)), 0, 0, 16, 0)
	binary.LittleEndian.PutUint64(out[sectionHeaderOff+elf64SectionSize+16:sectionHeaderOff+elf64SectionSize+24], textVA)
	sectionIndex := 2
	if len(rodata) != 0 {
		off := sectionHeaderOff + sectionIndex*elf64SectionSize
		writeARM64ELFSection(out[off:], 7, elfSHTProgbit, elfSHFAlloc, uint64(rodataOff), uint64(len(rodata)), 0, 0, 16, 0)
		binary.LittleEndian.PutUint64(out[off+16:off+24], rodataVA)
		sectionIndex++
	}
	if runtimeDataBytes != 0 {
		off := sectionHeaderOff + sectionIndex*elf64SectionSize
		writeARM64ELFSection(out[off:], 15, elfSHTProgbit, elfSHFAlloc|1, uint64(runtimeDataOff), uint64(runtimeDataBytes), 0, 0, 16, 0)
		binary.LittleEndian.PutUint64(out[off+16:off+24], runtimeDataVA)
		sectionIndex++
	}
	symtabIndex := sectionIndex
	strtabIndex := sectionIndex + 1
	shstrtabIndex := sectionIndex + 2
	writeARM64ELFSection(out[sectionHeaderOff+symtabIndex*elf64SectionSize:], 21, elfSHTSymtab, 0, uint64(symtabOff), uint64(symtabSize), uint32(strtabIndex), 2, 8, elf64SymbolSize)
	writeARM64ELFSection(out[sectionHeaderOff+strtabIndex*elf64SectionSize:], 29, elfSHTStrtab, 0, uint64(strtabOff), uint64(len(strtab)), 0, 0, 1, 0)
	writeARM64ELFSection(out[sectionHeaderOff+shstrtabIndex*elf64SectionSize:], 37, elfSHTStrtab, 0, uint64(shstrtabOff), uint64(len(shstrtab)), 0, 0, 1, 0)
	return out, nil
}

func makeX64LinuxExecutableText(f SSAFunction, inner []byte) ([]byte, error) {
	b := &x64MachineBuilder{}
	// Preserve the process-entry stack pointer so argc/argv remain addressable
	// after reserving Win64 shadow space, four staged args and a status cell.
	b.movRegReg(x64RBP, x64RSP)
	b.movRegMemDisp32(x64RAX, x64RBP, 0)
	b.cmpRegImm8(x64RAX, byte(len(f.Params)+1))
	argcFailure := b.jccRel32(0x5) // JNE
	b.subRegImm32(x64RSP, 96)
	argumentFailures := []int{argcFailure}
	for i, value := range f.Params {
		b.movRegMemDisp32(x64RSI, x64RBP, int32(16+i*8)) // argv[i+1]
		fixups, err := emitX64ParseScalarArg(b, f.ValueTypes[value], false)
		if err != nil {
			return nil, err
		}
		argumentFailures = append(argumentFailures, fixups...)
		b.movMemDisp32Reg(x64RSP, int32(x64ExeArgBaseOffset+i*8), x64RAX)
	}
	emitX64StageWin64ExecutableArgs(b, f)
	innerCall := b.callRel32()
	b.movRegMemDisp32(x64R10, x64RSP, x64ExeStatusOffset)
	b.testRegReg(x64R10, x64R10)
	failureJump := b.jccRel32(0x5)
	b.movRegReg(x64RDI, x64RAX)
	b.movRegImm64(x64RAX, 60)
	b.code = append(b.code, 0x0f, 0x05, 0x0f, 0x0b) // syscall; ud2
	backendFailureOffset := len(b.code)
	b.movRegImm64(x64RDI, 1)
	b.movRegImm64(x64RAX, 60)
	b.code = append(b.code, 0x0f, 0x05, 0x0f, 0x0b)
	argumentFailureOffset := len(b.code)
	b.movRegImm64(x64RDI, 2)
	b.movRegImm64(x64RAX, 60)
	b.code = append(b.code, 0x0f, 0x05, 0x0f, 0x0b)
	innerOffset := len(b.code)
	text := append(append([]byte(nil), b.code...), inner...)
	patchX64Rel32(text, innerCall, innerOffset)
	patchX64Rel32(text, failureJump, backendFailureOffset)
	for _, pos := range argumentFailures {
		patchX64Rel32(text, pos, argumentFailureOffset)
	}
	return text, nil
}
