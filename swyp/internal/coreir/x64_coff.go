package coreir

import (
	"encoding/binary"
	"fmt"
)

const (
	coffAMD64Machine           = 0x8664
	coffX64TextCharacteristics = 0x60500020 // code | align16 | execute | read
)

// EncodeX64COFFObject wraps Win64-compatible packed code in a deterministic
// AMD64 COFF relocatable object.
func EncodeX64COFFObject(entry string, code []byte) ([]byte, error) {
	if !validX64EntryName(entry) {
		return nil, fmt.Errorf("x64 coff: invalid entry name")
	}
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 coff: invalid code size %d", len(code))
	}
	symbol := X64LeafSymbol(entry)
	rawDataOff := coffFileHeaderSize + coffSectionHeaderSize
	symbolOff := alignObject(rawDataOff+len(code), 4)
	stringTable := make([]byte, 4+len(symbol)+1)
	binary.LittleEndian.PutUint32(stringTable[0:4], uint32(len(stringTable)))
	copy(stringTable[4:], symbol)
	out := make([]byte, symbolOff+coffSymbolSize+len(stringTable))

	binary.LittleEndian.PutUint16(out[0:2], coffAMD64Machine)
	binary.LittleEndian.PutUint16(out[2:4], 1)
	binary.LittleEndian.PutUint32(out[8:12], uint32(symbolOff))
	binary.LittleEndian.PutUint32(out[12:16], 1)
	section := out[coffFileHeaderSize : coffFileHeaderSize+coffSectionHeaderSize]
	copy(section[0:8], []byte(".text"))
	binary.LittleEndian.PutUint32(section[16:20], uint32(len(code)))
	binary.LittleEndian.PutUint32(section[20:24], uint32(rawDataOff))
	binary.LittleEndian.PutUint32(section[36:40], coffX64TextCharacteristics)
	copy(out[rawDataOff:], code)

	sym := out[symbolOff : symbolOff+coffSymbolSize]
	binary.LittleEndian.PutUint32(sym[0:4], 0)
	binary.LittleEndian.PutUint32(sym[4:8], 4)
	binary.LittleEndian.PutUint16(sym[12:14], 1)
	binary.LittleEndian.PutUint16(sym[14:16], coffTypeFunction)
	sym[16] = coffStorageClassExternal
	copy(out[symbolOff+coffSymbolSize:], stringTable)
	return out, nil
}
