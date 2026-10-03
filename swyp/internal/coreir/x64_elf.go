package coreir

import (
	"encoding/binary"
	"fmt"
)

const elfEMX8664 = 62

// EncodeX64ELFObject wraps System V-compatible x86-64 machine code in a
// deterministic ELF64 ET_REL object. Callers should use WrapX64SysVEntry first
// when the code was produced by Swyp's internal Win64 packed backend.
func EncodeX64ELFObject(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("x64 elf: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 elf: invalid code size %d", len(code))
	}

	symbol := X64LeafSymbol(entry)
	strtab := append([]byte{0}, []byte(symbol)...)
	strtab = append(strtab, 0)
	shstrtab := []byte("\x00.text\x00.symtab\x00.strtab\x00.shstrtab\x00")
	textOff := alignELF(elf64HeaderSize, 16)
	symtabOff := alignELF(textOff+len(code), 8)
	const symbolCount = 3
	symtabSize := symbolCount * elf64SymbolSize
	strtabOff := symtabOff + symtabSize
	shstrtabOff := strtabOff + len(strtab)
	sectionHeaderOff := alignELF(shstrtabOff+len(shstrtab), 8)
	const sectionCount = 5
	out := make([]byte, sectionHeaderOff+sectionCount*elf64SectionSize)

	copy(out[0:4], []byte{0x7f, 'E', 'L', 'F'})
	out[4], out[5], out[6] = 2, 1, 1
	put16 := func(off int, v uint16) { binary.LittleEndian.PutUint16(out[off:off+2], v) }
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	put16(16, elfETRel)
	put16(18, elfEMX8664)
	put32(20, 1)
	put64(40, uint64(sectionHeaderOff))
	put16(52, elf64HeaderSize)
	put16(58, elf64SectionSize)
	put16(60, sectionCount)
	put16(62, 4)

	copy(out[textOff:], code)
	writeARM64ELFSymbol(out[symtabOff:symtabOff+elf64SymbolSize], 0, 0, 0, 0, 0, 0)
	writeARM64ELFSymbol(out[symtabOff+elf64SymbolSize:symtabOff+2*elf64SymbolSize], 0, elfSTTSection, 0, 1, 0, 0)
	writeARM64ELFSymbol(out[symtabOff+2*elf64SymbolSize:symtabOff+3*elf64SymbolSize], 1, elfSTBGlobal<<4|elfSTTFunc, 0, 1, 0, uint64(len(code)))
	copy(out[strtabOff:], strtab)
	copy(out[shstrtabOff:], shstrtab)
	writeARM64ELFSection(out[sectionHeaderOff+elf64SectionSize:], 1, elfSHTProgbit, elfSHFAlloc|elfSHFExec, uint64(textOff), uint64(len(code)), 0, 0, 16, 0)
	writeARM64ELFSection(out[sectionHeaderOff+2*elf64SectionSize:], 7, elfSHTSymtab, 0, uint64(symtabOff), uint64(symtabSize), 3, 2, 8, elf64SymbolSize)
	writeARM64ELFSection(out[sectionHeaderOff+3*elf64SectionSize:], 15, elfSHTStrtab, 0, uint64(strtabOff), uint64(len(strtab)), 0, 0, 1, 0)
	writeARM64ELFSection(out[sectionHeaderOff+4*elf64SectionSize:], 23, elfSHTStrtab, 0, uint64(shstrtabOff), uint64(len(shstrtab)), 0, 0, 1, 0)
	return out, nil
}
