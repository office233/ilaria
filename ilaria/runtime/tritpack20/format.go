package tritpack20

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/bits"
)

const (
	Version uint16 = 1

	LayoutInOut uint8 = 1

	headerSize     = 88
	hashOffset     = 56
	hashSize       = sha256.Size
	weightScaleOff = 48
	snapshotDomain = "ilaria.tritpack20.snapshot.v1\x00"
	snapshotMagic  = "TRITPK20"
	maxInputForI64 = uint64(^uint64(0)>>1) / 128
)

var (
	ErrInvalidLimits = errors.New("tritpack20: invalid limits")
	ErrFormat        = errors.New("tritpack20: invalid snapshot format")
	ErrVersion       = errors.New("tritpack20: unsupported snapshot version")
	ErrLayout        = errors.New("tritpack20: unsupported matrix layout")
	ErrDimensions    = errors.New("tritpack20: invalid matrix dimensions")
	ErrScale         = errors.New("tritpack20: scale must be finite and positive")
	ErrHashMismatch  = errors.New("tritpack20: snapshot hash mismatch")
)

// Limits are mandatory host-selected bounds. They are checked before any
// snapshot-sized allocation.
type Limits struct {
	MaxInputDim      uint64
	MaxOutputDim     uint64
	MaxTrits         uint64
	MaxPayloadBytes  uint64
	MaxSnapshotBytes uint64
}

// Snapshot owns one immutable canonical encoded snapshot. No method exposes its
// backing byte slice.
type Snapshot struct {
	encoded     []byte
	in          int
	out         int
	weightScale float32
	hash        [sha256.Size]byte
}

// NewSnapshot creates an immutable canonical [in,out] projection snapshot.
// trits is flattened row-major: W[i,o] is trits[i*out+o].
func NewSnapshot(in, out uint64, weightScale float32, trits []int8, limits Limits) (*Snapshot, error) {
	tritCount, payloadBytes, totalBytes, err := validateShape(in, out, limits)
	if err != nil {
		return nil, err
	}
	if !validScale(weightScale) {
		return nil, ErrScale
	}
	if uint64(len(trits)) != tritCount {
		return nil, fmt.Errorf("%w: trits=%d want=%d", ErrLength, len(trits), tritCount)
	}

	encoded := make([]byte, totalBytes)
	writeHeaderPrefix(encoded, in, out, tritCount, uint64(payloadBytes), weightScale)
	if err := Pack(encoded[headerSize:], trits); err != nil {
		return nil, err
	}
	sum := snapshotHash(encoded)
	copy(encoded[hashOffset:headerSize], sum[:])
	return snapshotFromOwned(encoded, int(in), int(out), weightScale, sum), nil
}

// ParseSnapshot fully validates a canonical encoded snapshot before allocating
// the owned immutable copy.
func ParseSnapshot(encoded []byte, limits Limits) (*Snapshot, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	if uint64(len(encoded)) > limits.MaxSnapshotBytes {
		return nil, fmt.Errorf("%w: snapshot=%d max=%d", ErrLimit, len(encoded), limits.MaxSnapshotBytes)
	}
	if len(encoded) < headerSize {
		return nil, fmt.Errorf("%w: header truncated", ErrFormat)
	}
	if string(encoded[:8]) != snapshotMagic {
		return nil, fmt.Errorf("%w: magic", ErrFormat)
	}
	if version := binary.LittleEndian.Uint16(encoded[8:10]); version != Version {
		return nil, fmt.Errorf("%w: %d", ErrVersion, version)
	}
	if size := binary.LittleEndian.Uint16(encoded[10:12]); size != headerSize {
		return nil, fmt.Errorf("%w: header size %d", ErrFormat, size)
	}
	if encoded[12] != LayoutInOut {
		return nil, fmt.Errorf("%w: %d", ErrLayout, encoded[12])
	}
	if encoded[13] != 0 || encoded[14] != 0 || encoded[15] != 0 ||
		encoded[52] != 0 || encoded[53] != 0 || encoded[54] != 0 || encoded[55] != 0 {
		return nil, fmt.Errorf("%w: reserved bytes", ErrFormat)
	}

	in := binary.LittleEndian.Uint64(encoded[16:24])
	out := binary.LittleEndian.Uint64(encoded[24:32])
	tritCount, payloadBytes, totalBytes, err := validateShape(in, out, limits)
	if err != nil {
		return nil, err
	}
	if declared := binary.LittleEndian.Uint64(encoded[32:40]); declared != tritCount {
		return nil, fmt.Errorf("%w: trit count=%d want=%d", ErrDimensions, declared, tritCount)
	}
	if declared := binary.LittleEndian.Uint64(encoded[40:48]); declared != uint64(payloadBytes) {
		return nil, fmt.Errorf("%w: payload bytes=%d want=%d", ErrFormat, declared, payloadBytes)
	}
	if len(encoded) != totalBytes {
		return nil, fmt.Errorf("%w: snapshot bytes=%d want=%d", ErrLength, len(encoded), totalBytes)
	}

	weightScale := math.Float32frombits(binary.LittleEndian.Uint32(encoded[weightScaleOff:52]))
	if !validScale(weightScale) {
		return nil, ErrScale
	}
	if err := ValidatePacked(encoded[headerSize:], tritCount); err != nil {
		return nil, err
	}
	computed := snapshotHash(encoded)
	if !bytes.Equal(encoded[hashOffset:headerSize], computed[:]) {
		return nil, ErrHashMismatch
	}

	owned := make([]byte, len(encoded))
	copy(owned, encoded)
	return snapshotFromOwned(owned, int(in), int(out), weightScale, computed), nil
}

func (s *Snapshot) MarshalBinary() []byte {
	if s == nil {
		return nil
	}
	out := make([]byte, len(s.encoded))
	copy(out, s.encoded)
	return out
}

func (s *Snapshot) In() int {
	if s == nil {
		return 0
	}
	return s.in
}

func (s *Snapshot) Out() int {
	if s == nil {
		return 0
	}
	return s.out
}

func (s *Snapshot) WeightScale() float32 {
	if s == nil {
		return 0
	}
	return s.weightScale
}

func (s *Snapshot) PayloadBytes() int {
	if s == nil {
		return 0
	}
	return len(s.encoded) - headerSize
}

func (s *Snapshot) Hash() [sha256.Size]byte {
	if s == nil {
		return [sha256.Size]byte{}
	}
	return s.hash
}

func (l Limits) validate() error {
	if l.MaxInputDim == 0 || l.MaxOutputDim == 0 || l.MaxTrits == 0 ||
		l.MaxPayloadBytes == 0 || l.MaxSnapshotBytes < headerSize {
		return ErrInvalidLimits
	}
	if l.MaxPayloadBytes > l.MaxSnapshotBytes-headerSize {
		return fmt.Errorf("%w: payload bound exceeds snapshot capacity", ErrInvalidLimits)
	}
	return nil
}

func validateShape(in, out uint64, limits Limits) (tritCount uint64, payloadBytes, totalBytes int, err error) {
	if err = limits.validate(); err != nil {
		return 0, 0, 0, err
	}
	if in == 0 || out == 0 || in > limits.MaxInputDim || out > limits.MaxOutputDim {
		return 0, 0, 0, ErrDimensions
	}
	if in > maxInputForI64 {
		return 0, 0, 0, fmt.Errorf("%w: input dimension exceeds safe int64 accumulation", ErrDimensions)
	}
	if in > maxIntUint64() || out > maxIntUint64() {
		return 0, 0, 0, ErrOverflow
	}
	hi, lo := bits.Mul64(in, out)
	if hi != 0 || lo > limits.MaxTrits || lo > maxIntUint64() {
		if hi != 0 || lo > maxIntUint64() {
			return 0, 0, 0, ErrOverflow
		}
		return 0, 0, 0, fmt.Errorf("%w: trits=%d max=%d", ErrLimit, lo, limits.MaxTrits)
	}
	tritCount = lo
	payload64, packErr := packedBytes64(tritCount)
	if packErr != nil {
		return 0, 0, 0, packErr
	}
	if payload64 > limits.MaxPayloadBytes {
		return 0, 0, 0, fmt.Errorf("%w: payload=%d max=%d", ErrLimit, payload64, limits.MaxPayloadBytes)
	}
	if payload64 > maxIntUint64()-headerSize {
		return 0, 0, 0, ErrOverflow
	}
	total64 := payload64 + headerSize
	if total64 > limits.MaxSnapshotBytes {
		return 0, 0, 0, fmt.Errorf("%w: snapshot=%d max=%d", ErrLimit, total64, limits.MaxSnapshotBytes)
	}
	if total64 > maxIntUint64() {
		return 0, 0, 0, ErrOverflow
	}
	return tritCount, int(payload64), int(total64), nil
}

func writeHeaderPrefix(encoded []byte, in, out, tritCount, payloadBytes uint64, weightScale float32) {
	copy(encoded[:8], snapshotMagic)
	binary.LittleEndian.PutUint16(encoded[8:10], Version)
	binary.LittleEndian.PutUint16(encoded[10:12], headerSize)
	encoded[12] = LayoutInOut
	binary.LittleEndian.PutUint64(encoded[16:24], in)
	binary.LittleEndian.PutUint64(encoded[24:32], out)
	binary.LittleEndian.PutUint64(encoded[32:40], tritCount)
	binary.LittleEndian.PutUint64(encoded[40:48], payloadBytes)
	binary.LittleEndian.PutUint32(encoded[weightScaleOff:52], math.Float32bits(weightScale))
}

func snapshotHash(encoded []byte) [sha256.Size]byte {
	h := sha256.New()
	_, _ = h.Write([]byte(snapshotDomain))
	_, _ = h.Write(encoded[:hashOffset])
	_, _ = h.Write(encoded[headerSize:])
	var sum [sha256.Size]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

func snapshotFromOwned(encoded []byte, in, out int, weightScale float32, hash [sha256.Size]byte) *Snapshot {
	return &Snapshot{
		encoded:     encoded,
		in:          in,
		out:         out,
		weightScale: weightScale,
		hash:        hash,
	}
}

func validScale(scale float32) bool {
	return scale > 0 && !math.IsNaN(float64(scale)) && !math.IsInf(float64(scale), 0)
}

func maxIntUint64() uint64 {
	return uint64(^uint(0) >> 1)
}
