package tritpack20

import (
	"encoding/binary"
	"errors"
)

var ErrBounds = errors.New("tritpack20: matrix/vector bounds mismatch")

// MatVec computes dst = activations * W for this [in,out] projection.
//
// activations contains signed int8 quantized activation integers. activationScale
// is the positive finite dequantization step such that real activation i is
// float32(activations[i]) * activationScale. Each ternary weight is multiplied
// by the snapshot's positive finite WeightScale.
//
// The implementation performs exact int64 integer accumulation, decodes weights
// directly from the packed snapshot, writes caller-owned dst, and allocates no
// memory on a valid call.
func (s *Snapshot) MatVec(dst []float32, activations []int8, activationScale float32) error {
	if s == nil {
		return ErrBounds
	}
	if len(activations) != s.in || len(dst) != s.out {
		return ErrBounds
	}
	if !validScale(activationScale) {
		return ErrScale
	}

	scale := activationScale * s.weightScale
	if !validScale(scale) {
		return ErrScale
	}
	payload := s.encoded[headerSize:]
	for output := 0; output < s.out; output++ {
		var acc int64
		for input := 0; input < s.in; input++ {
			flat := input*s.out + output
			wordIndex := flat / TritsPerWord
			digitIndex := flat - wordIndex*TritsPerWord
			word := binary.LittleEndian.Uint32(payload[wordIndex*4:])
			digit := (word / powersOfThree[digitIndex]) % 3
			trit := int64(digit) - 1
			acc += int64(activations[input]) * trit
		}
		dst[output] = float32(acc) * scale
	}
	return nil
}
