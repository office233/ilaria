package coreir

import (
	"encoding/binary"
	"fmt"
)

const machOCPUX8664 = 0x01000007

// EncodeX64MachOObject wraps System V-compatible x86-64 code in a deterministic
// Mach-O 64-bit MH_OBJECT for Darwin/amd64.
func EncodeX64MachOObject(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("x64 macho: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 macho: invalid code size %d", len(code))
	}
	const segmentCommandSize = machOSegment64Size + machOSection64Size
	const commandBytes = segmentCommandSize + machOSymtabCommandSize
	codeOff := machOHeader64Size + commandBytes
	symOff := alignObject(codeOff+len(code), 8)
	strtab := append([]byte{0}, []byte("_"+X64LeafSymbol(entry))...)
	strtab = append(strtab, 0)
	strOff := symOff + machONlist64Size
	out := make([]byte, strOff+len(strtab))

	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(out[off:off+4], v) }
	put64 := func(off int, v uint64) { binary.LittleEndian.PutUint64(out[off:off+8], v) }
	put32(0, machOMagic64)
	put32(4, machOCPUX8664)
	put32(8, 3) // CPU_SUBTYPE_X86_64_ALL
	put32(12, machOFileObject)
	put32(16, 2)
	put32(20, commandBytes)

	seg := machOHeader64Size
	put32(seg, machOLCSegment64)
	put32(seg+4, segmentCommandSize)
	put64(seg+32, uint64(len(code)))
	put64(seg+40, uint64(codeOff))
	put64(seg+48, uint64(len(code)))
	put32(seg+56, 7)
	put32(seg+60, 5)
	put32(seg+64, 1)
	sec := seg + machOSegment64Size
	copy(out[sec:sec+16], []byte("__text"))
	copy(out[sec+16:sec+32], []byte("__TEXT"))
	put64(sec+40, uint64(len(code)))
	put32(sec+48, uint32(codeOff))
	put32(sec+52, 4) // 16-byte alignment
	put32(sec+64, machOSAttrInstructions)

	symcmd := seg + segmentCommandSize
	put32(symcmd, machOLCSymtab)
	put32(symcmd+4, machOSymtabCommandSize)
	put32(symcmd+8, uint32(symOff))
	put32(symcmd+12, 1)
	put32(symcmd+16, uint32(strOff))
	put32(symcmd+20, uint32(len(strtab)))
	copy(out[codeOff:], code)
	put32(symOff, 1)
	out[symOff+4] = 0x0f
	out[symOff+5] = 1
	put64(symOff+8, 0)
	copy(out[strOff:], strtab)
	return out, nil
}
