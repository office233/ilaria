package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	pe64SignatureOffset    = 0x80
	pe64OptionalSize       = 240
	pe64FileAlignment      = 0x200
	pe64SectionAlignment   = 0x1000
	pe64TextRVA            = 0x1000
	pe64RelocDirectorySize = 12
)

// EncodeX64PEDLL emits a deterministic PE32+ AMD64 DLL containing one exported
// Swyp function. The packed backend is position-independent (register/stack
// operations plus relative internal control flow), so the image has no code/data
// addresses that need rebasing. A small inert DIR64 relocation is nevertheless
// emitted in .reloc so the Windows loader can legally move the image when its
// preferred base is occupied. The DLL has no imports and no DllMain entry point.
func EncodeX64PEDLL(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("x64 pe: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 pe: invalid code size %d", len(code))
	}

	symbol := X64LeafSymbol(entry)
	dllName := []byte("swyp.dll\x00")
	symbolName := append([]byte(symbol), 0)
	const exportDirSize = 40
	const eatOff = exportDirSize
	const namesOff = eatOff + 4
	const ordinalsOff = namesOff + 4
	const dllNameOff = ordinalsOff + 2
	symbolNameOff := dllNameOff + len(dllName)
	exportSize := symbolNameOff + len(symbolName)
	edata := make([]byte, exportSize)
	exportRVA := alignObject(pe64TextRVA+len(code), pe64SectionAlignment)
	relocRVA := alignObject(exportRVA+len(edata), pe64SectionAlignment)
	putE32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(edata[off:off+4], v) }
	putE32(12, uint32(exportRVA+dllNameOff))
	putE32(16, 1) // ordinal base
	putE32(20, 1)
	putE32(24, 1)
	putE32(28, uint32(exportRVA+eatOff))
	putE32(32, uint32(exportRVA+namesOff))
	putE32(36, uint32(exportRVA+ordinalsOff))
	putE32(eatOff, pe64TextRVA)
	putE32(namesOff, uint32(exportRVA+symbolNameOff))
	binary.LittleEndian.PutUint16(edata[ordinalsOff:ordinalsOff+2], 0)
	copy(edata[dllNameOff:], dllName)
	copy(edata[symbolNameOff:], symbolName)

	reloc := makeX64PEReloc(0x180000000, relocRVA)

	textRawSize := alignObject(len(code), pe64FileAlignment)
	edataRawSize := alignObject(len(edata), pe64FileAlignment)
	relocRawSize := alignObject(len(reloc), pe64FileAlignment)
	const sectionCount = 3
	peHeaderOff := pe64SignatureOffset
	fileHeaderOff := peHeaderOff + 4
	optionalOff := fileHeaderOff + 20
	sectionOff := optionalOff + pe64OptionalSize
	headerSize := alignObject(sectionOff+sectionCount*40, pe64FileAlignment)
	textRawOff := headerSize
	edataRawOff := textRawOff + textRawSize
	relocRawOff := edataRawOff + edataRawSize
	imageSize := alignObject(relocRVA+len(reloc), pe64SectionAlignment)
	out := make([]byte, relocRawOff+relocRawSize)

	// DOS header + minimal deterministic DOS stub area.
	out[0], out[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(out[0x3c:0x40], uint32(peHeaderOff))
	copy(out[peHeaderOff:peHeaderOff+4], []byte{'P', 'E', 0, 0})

	put16 := func(off int, v uint16) { binary.LittleEndian.PutUint16(out[off:off+2], v) }
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	// IMAGE_FILE_HEADER.
	put16(fileHeaderOff, coffAMD64Machine)
	put16(fileHeaderOff+2, sectionCount)
	put16(fileHeaderOff+16, pe64OptionalSize)
	put16(fileHeaderOff+18, 0x2022) // executable | large-address-aware | DLL

	// IMAGE_OPTIONAL_HEADER64.
	put16(optionalOff, 0x20b)
	out[optionalOff+2] = 1
	put32(optionalOff+4, uint32(textRawSize))
	put32(optionalOff+8, uint32(edataRawSize))
	put32(optionalOff+16, 0) // no DllMain
	put32(optionalOff+20, pe64TextRVA)
	put64(optionalOff+24, 0x180000000)
	put32(optionalOff+32, pe64SectionAlignment)
	put32(optionalOff+36, pe64FileAlignment)
	put16(optionalOff+40, 6)
	put16(optionalOff+48, 6)
	put32(optionalOff+56, uint32(imageSize))
	put32(optionalOff+60, uint32(headerSize))
	put16(optionalOff+68, 3)      // IMAGE_SUBSYSTEM_WINDOWS_CUI
	put16(optionalOff+70, 0x0160) // HIGH_ENTROPY_VA | DYNAMIC_BASE | NX_COMPAT
	put64(optionalOff+72, 1<<20)
	put64(optionalOff+80, 1<<12)
	put64(optionalOff+88, 1<<20)
	put64(optionalOff+96, 1<<12)
	put32(optionalOff+108, 16)
	// Data directory 0: export table.
	put32(optionalOff+112, uint32(exportRVA))
	put32(optionalOff+116, uint32(len(edata)))
	// Data directory 5: base relocation table.
	put32(optionalOff+152, uint32(relocRVA))
	put32(optionalOff+156, pe64RelocDirectorySize)

	writePESection := func(off int, name string, virtualSize, virtualAddress, rawSize, rawOff, characteristics uint32) {
		copy(out[off:off+8], []byte(name))
		put32(off+8, virtualSize)
		put32(off+12, virtualAddress)
		put32(off+16, rawSize)
		put32(off+20, rawOff)
		put32(off+36, characteristics)
	}
	writePESection(sectionOff, ".text", uint32(len(code)), pe64TextRVA, uint32(textRawSize), uint32(textRawOff), 0x60000020)
	writePESection(sectionOff+40, ".edata", uint32(len(edata)), uint32(exportRVA), uint32(edataRawSize), uint32(edataRawOff), 0x40000040)
	writePESection(sectionOff+80, ".reloc", uint32(len(reloc)), uint32(relocRVA), uint32(relocRawSize), uint32(relocRawOff), 0x42000040)
	copy(out[textRawOff:], code)
	copy(out[edataRawOff:], edata)
	copy(out[relocRawOff:], reloc)
	return out, nil
}

func makeX64PEReloc(imageBase uint64, relocRVA int) []byte {
	// The only DIR64 relocation targets an inert qword in this section;
	// executable code is already position-independent. Keeping one real
	// relocation allows the loader to rebase the image and therefore makes
	// DYNAMIC_BASE/HIGH_ENTROPY_VA truthful rather than decorative flags.
	const relocTargetOff = 16
	reloc := make([]byte, relocTargetOff+8)
	binary.LittleEndian.PutUint32(reloc[0:4], uint32(relocRVA))
	binary.LittleEndian.PutUint32(reloc[4:8], pe64RelocDirectorySize)
	binary.LittleEndian.PutUint16(reloc[8:10], uint16(10<<12|relocTargetOff))
	binary.LittleEndian.PutUint16(reloc[10:12], 0)
	binary.LittleEndian.PutUint64(reloc[relocTargetOff:relocTargetOff+8], imageBase+pe64TextRVA)
	return reloc
}
