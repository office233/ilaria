package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	elf64HeaderSize  = 64
	elf64SectionSize = 64
	elf64SymbolSize  = 24

	elfETRel      = 1
	elfEMAArch64  = 183
	elfSHTNull    = 0
	elfSHTProgbit = 1
	elfSHTSymtab  = 2
	elfSHTStrtab  = 3
	elfSHFAlloc   = 0x2
	elfSHFExec    = 0x4
	elfSTBGlobal  = 1
	elfSTTSection = 3
	elfSTTFunc    = 2
)

// EncodeARM64ELFObject wraps already-relocated AArch64 machine code in a
// deterministic ELF64 ET_REL object. Internal branches/calls are already
// section-relative in the packed backend, so no relocation section is needed.
// The whole .text blob is owned by one exported entry symbol; internal Swyp
// functions stay private implementation details of that entry artifact.
func EncodeARM64ELFObject(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("arm64 elf: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return nil, fmt.Errorf("arm64 elf: invalid code size %d", len(code))
	}

	symbol := ARM64LeafSymbol(entry)
	strtab := append([]byte{0}, []byte(symbol)...)
	strtab = append(strtab, 0)
	shstrtab := []byte("\x00.text\x00.symtab\x00.strtab\x00.shstrtab\x00")

	textOff := alignELF(elf64HeaderSize, 4)
	symtabOff := alignELF(textOff+len(code), 8)
	const symbolCount = 3 // null, local .text section, global entry function
	symtabSize := symbolCount * elf64SymbolSize
	strtabOff := symtabOff + symtabSize
	shstrtabOff := strtabOff + len(strtab)
	sectionHeaderOff := alignELF(shstrtabOff+len(shstrtab), 8)
	const sectionCount = 5
	totalSize := sectionHeaderOff + sectionCount*elf64SectionSize

	out := make([]byte, totalSize)
	copy(out[0:4], []byte{0x7f, 'E', 'L', 'F'})
	out[4] = 2 // ELFCLASS64
	out[5] = 1 // ELFDATA2LSB
	out[6] = 1 // EV_CURRENT
	put16 := func(off int, v uint16) { binary.LittleEndian.PutUint16(out[off:off+2], v) }
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	put16(16, elfETRel)
	put16(18, elfEMAArch64)
	put32(20, 1)
	put64(40, uint64(sectionHeaderOff))
	put16(52, elf64HeaderSize)
	put16(58, elf64SectionSize)
	put16(60, sectionCount)
	put16(62, 4) // .shstrtab section index

	copy(out[textOff:], code)
	writeARM64ELFSymbol(out[symtabOff:symtabOff+elf64SymbolSize], 0, 0, 0, 0, 0, 0)
	writeARM64ELFSymbol(out[symtabOff+elf64SymbolSize:symtabOff+2*elf64SymbolSize], 0, elfSTTSection, 0, 1, 0, 0)
	writeARM64ELFSymbol(out[symtabOff+2*elf64SymbolSize:symtabOff+3*elf64SymbolSize], 1, elfSTBGlobal<<4|elfSTTFunc, 0, 1, 0, uint64(len(code)))
	copy(out[strtabOff:], strtab)
	copy(out[shstrtabOff:], shstrtab)

	// Section 0 is all zero by definition.
	writeARM64ELFSection(out[sectionHeaderOff+elf64SectionSize:], 1, elfSHTProgbit, elfSHFAlloc|elfSHFExec, uint64(textOff), uint64(len(code)), 0, 0, 4, 0)
	writeARM64ELFSection(out[sectionHeaderOff+2*elf64SectionSize:], 7, elfSHTSymtab, 0, uint64(symtabOff), uint64(symtabSize), 3, 2, 8, elf64SymbolSize)
	writeARM64ELFSection(out[sectionHeaderOff+3*elf64SectionSize:], 15, elfSHTStrtab, 0, uint64(strtabOff), uint64(len(strtab)), 0, 0, 1, 0)
	writeARM64ELFSection(out[sectionHeaderOff+4*elf64SectionSize:], 23, elfSHTStrtab, 0, uint64(shstrtabOff), uint64(len(shstrtab)), 0, 0, 1, 0)

	return out, nil
}

func alignELF(value, alignment int) int {
	return (value + alignment - 1) &^ (alignment - 1)
}

func writeARM64ELFSymbol(dst []byte, name uint32, info, other uint8, section uint16, value, size uint64) {
	binary.LittleEndian.PutUint32(dst[0:4], name)
	dst[4] = info
	dst[5] = other
	binary.LittleEndian.PutUint16(dst[6:8], section)
	binary.LittleEndian.PutUint64(dst[8:16], value)
	binary.LittleEndian.PutUint64(dst[16:24], size)
}

func writeARM64ELFSection(dst []byte, name, typ uint32, flags, offset, size uint64, link, info uint32, align, entsize uint64) {
	binary.LittleEndian.PutUint32(dst[0:4], name)
	binary.LittleEndian.PutUint32(dst[4:8], typ)
	binary.LittleEndian.PutUint64(dst[8:16], flags)
	// sh_addr remains zero for relocatable objects.
	binary.LittleEndian.PutUint64(dst[24:32], offset)
	binary.LittleEndian.PutUint64(dst[32:40], size)
	binary.LittleEndian.PutUint32(dst[40:44], link)
	binary.LittleEndian.PutUint32(dst[44:48], info)
	binary.LittleEndian.PutUint64(dst[48:56], align)
	binary.LittleEndian.PutUint64(dst[56:64], entsize)
}
