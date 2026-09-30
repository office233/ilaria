package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	machOMagic64           = 0xfeedfacf
	machOCPUArm64          = 0x0100000c
	machOFileObject        = 1
	machOLCSegment64       = 0x19
	machOLCSymtab          = 0x2
	machOHeader64Size      = 32
	machOSegment64Size     = 72
	machOSection64Size     = 80
	machOSymtabCommandSize = 24
	machONlist64Size       = 16
	machOSAttrInstructions = 0x80000400
)

// EncodeARM64MachOObject wraps an internally relocated AArch64 blob in a
// deterministic Mach-O 64-bit MH_OBJECT for Darwin/arm64. Darwin's external
// symbol convention adds the leading underscore in the object symbol table.
func EncodeARM64MachOObject(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("arm64 macho: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return nil, fmt.Errorf("arm64 macho: invalid code size %d", len(code))
	}

	const segmentCommandSize = machOSegment64Size + machOSection64Size
	const commandBytes = segmentCommandSize + machOSymtabCommandSize
	codeOff := machOHeader64Size + commandBytes
	symOff := alignObject(codeOff+len(code), 8)
	strtab := append([]byte{0}, []byte("_"+ARM64LeafSymbol(entry))...)
	strtab = append(strtab, 0)
	strOff := symOff + machONlist64Size
	totalSize := strOff + len(strtab)
	out := make([]byte, totalSize)

	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	put32(0, machOMagic64)
	put32(4, machOCPUArm64)
	put32(8, 0) // CPU_SUBTYPE_ARM64_ALL
	put32(12, machOFileObject)
	put32(16, 2) // LC_SEGMENT_64 + LC_SYMTAB
	put32(20, commandBytes)
	put32(24, 0)
	put32(28, 0)

	// LC_SEGMENT_64 containing one __TEXT,__text section.
	seg := machOHeader64Size
	put32(seg, machOLCSegment64)
	put32(seg+4, segmentCommandSize)
	// Empty segment name is normal for MH_OBJECT files.
	put64(seg+24, 0)
	put64(seg+32, uint64(len(code)))
	put64(seg+40, uint64(codeOff))
	put64(seg+48, uint64(len(code)))
	put32(seg+56, 7) // maxprot rwx
	put32(seg+60, 5) // initprot r-x
	put32(seg+64, 1)
	put32(seg+68, 0)

	sec := seg + machOSegment64Size
	copy(out[sec:sec+16], []byte("__text"))
	copy(out[sec+16:sec+32], []byte("__TEXT"))
	put64(sec+32, 0)
	put64(sec+40, uint64(len(code)))
	put32(sec+48, uint32(codeOff))
	put32(sec+52, 2) // 2^2 = 4-byte AArch64 instruction alignment
	put32(sec+56, 0)
	put32(sec+60, 0)
	put32(sec+64, machOSAttrInstructions)
	put32(sec+68, 0)
	put32(sec+72, 0)
	put32(sec+76, 0)

	// LC_SYMTAB.
	symcmd := seg + segmentCommandSize
	put32(symcmd, machOLCSymtab)
	put32(symcmd+4, machOSymtabCommandSize)
	put32(symcmd+8, uint32(symOff))
	put32(symcmd+12, 1)
	put32(symcmd+16, uint32(strOff))
	put32(symcmd+20, uint32(len(strtab)))

	copy(out[codeOff:], code)
	// nlist_64: N_SECT | N_EXT, section 1, string index 1.
	put32(symOff, 1)
	out[symOff+4] = 0x0f
	out[symOff+5] = 1
	binary.LittleEndian.PutUint16(out[symOff+6:symOff+8], 0)
	put64(symOff+8, 0)
	copy(out[strOff:], strtab)
	return out, nil
}
