// Package tritpack20 implements the versioned TritPack20 storage contract used
// by native IMC ternary projection snapshots.
package tritpack20

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const TritsPerWord = 20

var (
	ErrInvalidTrit    = errors.New("tritpack20: trit must be -1, 0, or +1")
	ErrInvalidWord    = errors.New("tritpack20: packed word is outside the canonical base-3 range")
	ErrInvalidPadding = errors.New("tritpack20: non-zero canonical padding")
	ErrLength         = errors.New("tritpack20: slice length mismatch")
	ErrLimit          = errors.New("tritpack20: configured limit exceeded")
	ErrOverflow       = errors.New("tritpack20: integer overflow")
)

var powersOfThree = [...]uint32{
	1,
	3,
	9,
	27,
	81,
	243,
	729,
	2187,
	6561,
	19683,
	59049,
	177147,
	531441,
	1594323,
	4782969,
	14348907,
	43046721,
	129140163,
	387420489,
	1162261467,
	3486784401,
}

// PackedBytes returns the exact TritPack20 payload size for tritCount after
// applying the caller's explicit limits.
func PackedBytes(tritCount uint64, limits Limits) (int, error) {
	if err := limits.validate(); err != nil {
		return 0, err
	}
	if tritCount > limits.MaxTrits {
		return 0, fmt.Errorf("%w: trits=%d max=%d", ErrLimit, tritCount, limits.MaxTrits)
	}
	size, err := packedBytes64(tritCount)
	if err != nil {
		return 0, err
	}
	if size > limits.MaxPayloadBytes {
		return 0, fmt.Errorf("%w: payload=%d max=%d", ErrLimit, size, limits.MaxPayloadBytes)
	}
	if size > maxIntUint64() {
		return 0, ErrOverflow
	}
	return int(size), nil
}

// Pack writes trits into dst using little-endian uint32 words. Trit i in a word
// is the i-th least-significant base-3 digit with mapping -1->0, 0->1, +1->2.
// Unused digits in the final partial word are canonical zero digits.
func Pack(dst []byte, trits []int8) error {
	required, err := packedBytes64(uint64(len(trits)))
	if err != nil {
		return err
	}
	if required != uint64(len(dst)) {
		return fmt.Errorf("%w: payload=%d want=%d", ErrLength, len(dst), required)
	}
	for wordIndex, offset := 0, 0; offset < len(trits); wordIndex++ {
		count := len(trits) - offset
		if count > TritsPerWord {
			count = TritsPerWord
		}
		var word uint32
		for digitIndex := 0; digitIndex < count; digitIndex++ {
			trit := trits[offset+digitIndex]
			if trit < -1 || trit > 1 {
				return fmt.Errorf("%w at index %d: %d", ErrInvalidTrit, offset+digitIndex, trit)
			}
			word += uint32(trit+1) * powersOfThree[digitIndex]
		}
		binary.LittleEndian.PutUint32(dst[wordIndex*4:], word)
		offset += count
	}
	return nil
}

// ValidatePacked validates exact payload length, the uint32 base-3 word range,
// and canonical zero padding in a final partial word without allocating.
func ValidatePacked(payload []byte, tritCount uint64) error {
	required, err := packedBytes64(tritCount)
	if err != nil {
		return err
	}
	if required != uint64(len(payload)) {
		return fmt.Errorf("%w: payload=%d want=%d", ErrLength, len(payload), required)
	}
	remaining := tritCount
	for offset := 0; offset < len(payload); offset += 4 {
		count := uint64(TritsPerWord)
		if remaining < count {
			count = remaining
		}
		word := binary.LittleEndian.Uint32(payload[offset:])
		if count == TritsPerWord {
			if word >= powersOfThree[TritsPerWord] {
				return fmt.Errorf("%w at word %d", ErrInvalidWord, offset/4)
			}
		} else if word >= powersOfThree[count] {
			return fmt.Errorf("%w at word %d", ErrInvalidPadding, offset/4)
		}
		remaining -= count
	}
	return nil
}

// Unpack validates payload and writes exactly tritCount trits into dst.
func Unpack(dst []int8, payload []byte, tritCount uint64) error {
	if uint64(len(dst)) != tritCount {
		return fmt.Errorf("%w: trits=%d want=%d", ErrLength, len(dst), tritCount)
	}
	if err := ValidatePacked(payload, tritCount); err != nil {
		return err
	}
	out := 0
	remaining := tritCount
	for offset := 0; offset < len(payload); offset += 4 {
		count := uint64(TritsPerWord)
		if remaining < count {
			count = remaining
		}
		word := binary.LittleEndian.Uint32(payload[offset:])
		for digit := uint64(0); digit < count; digit++ {
			value := word % 3
			word /= 3
			dst[out] = int8(value) - 1
			out++
		}
		remaining -= count
	}
	return nil
}

func packedBytes64(tritCount uint64) (uint64, error) {
	words := tritCount / TritsPerWord
	if tritCount%TritsPerWord != 0 {
		if words == ^uint64(0) {
			return 0, ErrOverflow
		}
		words++
	}
	if words > ^uint64(0)/4 {
		return 0, ErrOverflow
	}
	return words * 4, nil
}
