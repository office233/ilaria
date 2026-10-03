package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	coffARM64Machine         = 0xaa64
	coffFileHeaderSize       = 20
	coffSectionHeaderSize    = 40
	coffSymbolSize           = 18
	coffStorageClassExternal = 2
	coffTypeFunction         = 0x20
	coffTextCharacteristics  = 0x60300020 // code | align4 | execute | read
)

// EncodeARM64COFFObject wraps an internally relocated AArch64 code blob in a
// deterministic Microsoft COFF relocatable object suitable for ARM64 linkers.
func EncodeARM64COFFObject(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("arm64 coff: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxARM64LeafCodeBytes || len(code)%4 != 0 {
		return nil, fmt.Errorf("arm64 coff: invalid code size %d", len(code))
	}

	symbol := ARM64LeafSymbol(entry)
	rawDataOff := coffFileHeaderSize + coffSectionHeaderSize
	symbolOff := alignObject(rawDataOff+len(code), 4)
	stringTable := make([]byte, 4+len(symbol)+1)
	binary.LittleEndian.PutUint32(stringTable[0:4], uint32(len(stringTable)))
	copy(stringTable[4:], symbol)
	totalSize := symbolOff + coffSymbolSize + len(stringTable)
	out := make([]byte, totalSize)

	// IMAGE_FILE_HEADER.
	binary.LittleEndian.PutUint16(out[0:2], coffARM64Machine)
	binary.LittleEndian.PutUint16(out[2:4], 1) // one .text section
	// Timestamp deliberately zero for deterministic output.
	binary.LittleEndian.PutUint32(out[8:12], uint32(symbolOff))
	binary.LittleEndian.PutUint32(out[12:16], 1) // one symbol
	// Optional-header size and characteristics remain zero for .obj files.

	// IMAGE_SECTION_HEADER for .text.
	section := out[coffFileHeaderSize : coffFileHeaderSize+coffSectionHeaderSize]
	copy(section[0:8], []byte(".text"))
	binary.LittleEndian.PutUint32(section[16:20], uint32(len(code)))
	binary.LittleEndian.PutUint32(section[20:24], uint32(rawDataOff))
	binary.LittleEndian.PutUint32(section[36:40], coffTextCharacteristics)
	copy(out[rawDataOff:], code)

	// IMAGE_SYMBOL. A long symbol name is referenced through the COFF string
	// table: first uint32 zero, second uint32 byte offset (4 = first string).
	sym := out[symbolOff : symbolOff+coffSymbolSize]
	binary.LittleEndian.PutUint32(sym[0:4], 0)
	binary.LittleEndian.PutUint32(sym[4:8], 4)
	binary.LittleEndian.PutUint32(sym[8:12], 0) // value within .text
	binary.LittleEndian.PutUint16(sym[12:14], 1)
	binary.LittleEndian.PutUint16(sym[14:16], coffTypeFunction)
	sym[16] = coffStorageClassExternal
	copy(out[symbolOff+coffSymbolSize:], stringTable)
	return out, nil
}

func alignObject(value, alignment int) int {
	return (value + alignment - 1) &^ (alignment - 1)
}
