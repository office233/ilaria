package coreir

import (
	"encoding/binary"
	"fmt"
	"math"
)

// MaxRunByteArenaBytes bounds additional immutable bytes in pure interpreter
// runs. RunWithEffects instead shares its explicit MaxBytes with broker results.
const MaxRunByteArenaBytes = 1 << 20

// bytesFromStorageU64 snapshots capacity-addressable live u64 storage, not its
// logical length. Validation completes before publishing a descriptor or arena
// cursor; source storage and all previously committed spans remain unchanged.
func (m *machine) bytesFromStorageU64(id, length Value) (Value, error) {
	if id.typ != U64 || length.typ != U64 {
		return Value{}, diagnostic("type_mismatch", "bytes.from_storage_u64 requires u64 operands")
	}
	storage := m.ensureStorage()
	block, err := storage.Snapshot(id.u)
	if err != nil || !block.Live || block.Align != 8 || block.ByteLen%8 != 0 {
		if err == nil {
			err = fmt.Errorf("storage %d is not live u64 storage", id.u)
		}
		return Value{}, diagnostic("storage", err.Error())
	}
	if length.u > math.MaxUint64/8 {
		return Value{}, diagnostic("storage_limit", "snapshot u64 storage byte size overflow")
	}
	if length.u > block.ByteLen/8 {
		return Value{}, diagnostic("bounds", "snapshot length exceeds storage capacity")
	}
	arena := m.byteData()
	used := len(arena) - len(m.executable.data)
	limit := MaxRunByteArenaBytes
	if m.effects != nil {
		limit = m.effects.maxBytes
	}
	if used < 0 || used > limit || length.u > uint64(limit-used) ||
		uint64(len(arena))+length.u > math.MaxUint32 {
		return Value{}, diagnostic("byte_arena_exhausted", "snapshot exceeds remaining run byte arena")
	}
	words, err := storage.Read(id.u, 0, length.u*8)
	if err != nil {
		return Value{}, diagnostic("storage", err.Error())
	}
	for i := uint64(0); i < length.u; i++ {
		if i%1024 == 0 {
			if err := m.checkContext(Location{}); err != nil {
				return Value{}, err
			}
		}
		if binary.LittleEndian.Uint64(words[i*8:]) > 255 {
			return Value{}, diagnostic("invalid_octet", fmt.Sprintf("storage word %d exceeds 255", i))
		}
	}
	value, err := ByteSpan(uint32(len(arena)), uint32(length.u))
	if err != nil {
		return Value{}, err
	}
	snapshot := make([]byte, int(length.u))
	for i := range snapshot {
		snapshot[i] = byte(binary.LittleEndian.Uint64(words[i*8:]))
	}
	if err := m.checkContext(Location{}); err != nil {
		return Value{}, err
	}
	if m.effects != nil {
		if m.effects.data == nil {
			m.effects.data = append([]byte{}, arena...)
		}
		m.effects.data = append(m.effects.data, snapshot...)
		m.effects.bytesUsed += len(snapshot)
	} else {
		if m.data == nil {
			m.data = append([]byte{}, arena...)
		}
		m.data = append(m.data, snapshot...)
	}
	return value, nil
}
