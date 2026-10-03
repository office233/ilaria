package coreir

import (
	"encoding/binary"
	"fmt"
)

const arm64ELFExecutableBase = uint64(0x400000)

// EncodeARM64ELFExecutable emits a static ELF64/AArch64 executable with no
// libc, PT_INTERP or dynamic loader. _start parses Linux argc/argv directly for
// i64/u64/bool parameters, stages AAPCS64 argument registers and calls the
// packed Swyp entry before terminating through syscall exit(93).
func EncodeARM64ELFExecutable(f SSAFunction, code []byte) ([]byte, error) {
	return encodeARM64ELFExecutable(f, code, false)
}

// EncodeARM64ELFPIEExecutable emits a zero-based ET_DYN static image. The
// wrapper and packed backend use PC-relative branches only, so the image can be
// load-biased by the kernel without a dynamic relocation table.
func EncodeARM64ELFPIEExecutable(f SSAFunction, code []byte) ([]byte, error) {
	return encodeARM64ELFExecutable(f, code, true)
}

func EncodeARM64ELFProcessExecutable(f SSAFunction, process ARM64ProcessMachineCode, pie bool) ([]byte, error) {
	code, dataFixups, err := resolveARM64LinuxProcessRuntime(process)
	if err != nil {
		return nil, err
	}
	return encodeARM64ELFExecutableWithData(f, code, pie, process.Data, dataFixups, process.RuntimeDataBytes)
}

func encodeARM64ELFExecutable(f SSAFunction, code []byte, pie bool) ([]byte, error) {
	return encodeARM64ELFExecutableWithData(f, code, pie, nil, nil, 0)
}

func encodeARM64ELFExecutableWithData(f SSAFunction, code []byte, pie bool, rodata []byte, dataFixups []ARM64ProcessDataFixup, runtimeDataBytes int) ([]byte, error) {
	if !validX64EntryName(f.Name) {
		return nil, fmt.Errorf("arm64 elf exe: invalid entry name")
	}
	if err := validateARM64ExecutableSignature(f); err != nil {
		return nil, fmt.Errorf("arm64 elf exe: %w", err)
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return nil, fmt.Errorf("arm64 elf exe: invalid code size %d", len(code))
	}
	if runtimeDataBytes < 0 || runtimeDataBytes > MaxProcessRuntimeArenaBytes {
		return nil, fmt.Errorf("arm64 elf exe: invalid runtime data size %d", runtimeDataBytes)
	}
	text, err := makeARM64LinuxExecutableText(f, code)
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
	imageBase := arm64ELFExecutableBase
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
	innerWordOffset := (len(text) - len(code)) / 4
	for _, fixup := range dataFixups {
		wordIndex := innerWordOffset + fixup.WordIndex
		targetVA := rodataVA
		label := "rodata"
		if fixup.Target == processDataRuntime {
			targetVA = runtimeDataVA
			label = "runtime data"
		}
		if targetVA == 0 && !(pie && fixup.Target == processDataModule && rodataOff == 0) {
			return nil, fmt.Errorf("arm64 elf exe: %s fixup without segment", label)
		}
		targetWord := int((targetVA - textVA) / 4)
		if err := patchARM64ADR(text, wordIndex, targetWord); err != nil {
			return nil, fmt.Errorf("arm64 elf exe: %s ADR: %w", label, err)
		}
	}
	symtabOff := alignELF(metadataStart, 8)
	const symbolCount = 3
	symtabSize := symbolCount * elf64SymbolSize
	strtab := append([]byte{0}, []byte(ARM64LeafSymbol(f.Name))...)
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
	out := make([]byte, sectionHeaderOff+sectionCount*elf64SectionSize)

	copy(out[0:4], []byte{0x7f, 'E', 'L', 'F'})
	out[4], out[5], out[6] = 2, 1, 1
	put16 := func(off int, v uint16) { binary.LittleEndian.PutUint16(out[off:off+2], v) }
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	put16(16, elfType)
	put16(18, elfEMAArch64)
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

func makeARM64LinuxExecutableText(f SSAFunction, inner []byte) ([]byte, error) {
	b := &arm64MachineBuilder{}
	// Preserve the process-entry SP (argc/argv) in x19 and reserve one fixed
	// frame for staged args + status. Packed code uses x9-x15, so x19-x27 remain
	// private to this process wrapper.
	if err := b.addRegSPAddress(19, 0); err != nil {
		return nil, err
	}
	if err := b.adjustSP(-arm64ExeFrameBytes); err != nil {
		return nil, err
	}
	if err := b.ldrRegBase(21, 19, 0); err != nil {
		return nil, err
	}
	if err := b.cmpRegImm(21, len(f.Params)+1); err != nil {
		return nil, err
	}
	argumentFailures := []arm64ExeFixup{{index: b.condBranchPlaceholder(0x1), kind: arm64ExeFixupCond}} // NE
	for i, value := range f.Params {
		if err := b.ldrRegBase(20, 19, 16+i*8); err != nil { // argv[i+1]
			return nil, err
		}
		fixups, err := emitARM64ParseScalarArg(b, f.ValueTypes[value])
		if err != nil {
			return nil, err
		}
		argumentFailures = append(argumentFailures, fixups...)
		if err := b.strRegSP(21, arm64ExeArgBaseOffset+i*8); err != nil {
			return nil, err
		}
	}
	gprIndex, fpIndex := 0, 0
	for i, value := range f.Params {
		if f.ValueTypes[value] == IEEE64 {
			if err := b.ldrDSp(fpIndex, arm64ExeArgBaseOffset+i*8); err != nil {
				return nil, err
			}
			fpIndex++
		} else {
			if err := b.ldrRegSP(gprIndex, arm64ExeArgBaseOffset+i*8); err != nil {
				return nil, err
			}
			gprIndex++
		}
	}
	b.movImm64(17, 0)
	if err := b.strRegSP(17, arm64ExeStatusOffset); err != nil {
		return nil, err
	}
	if err := b.addRegSPAddress(gprIndex, arm64ExeStatusOffset); err != nil {
		return nil, err
	}
	innerCall := b.blPlaceholder()
	if err := b.ldrRegSP(17, arm64ExeStatusOffset); err != nil {
		return nil, err
	}
	successBranch := b.cbzPlaceholder(17)
	b.movImm64(0, 1)
	successOffset := len(b.words)
	if err := b.patchCBZ(successBranch, successOffset); err != nil {
		return nil, err
	}
	if err := b.adjustSP(arm64ExeFrameBytes); err != nil {
		return nil, err
	}
	b.movImm64(8, 93)
	b.append(0xd4000001) // svc #0
	b.append(0xd4200000) // brk #0 if exit unexpectedly returns
	argumentFailureOffset := len(b.words)
	b.movImm64(0, 2)
	if err := b.adjustSP(arm64ExeFrameBytes); err != nil {
		return nil, err
	}
	b.movImm64(8, 93)
	b.append(0xd4000001)
	b.append(0xd4200000)
	innerOffset := len(b.words)
	for i := 0; i < len(inner); i += 4 {
		b.append(binary.LittleEndian.Uint32(inner[i : i+4]))
	}
	if err := b.patchBL(innerCall, innerOffset); err != nil {
		return nil, err
	}
	if err := patchARM64ExeFixups(b, argumentFailures, argumentFailureOffset); err != nil {
		return nil, err
	}
	out := make([]byte, len(b.words)*4)
	for i, word := range b.words {
		binary.LittleEndian.PutUint32(out[i*4:], word)
	}
	return out, nil
}
