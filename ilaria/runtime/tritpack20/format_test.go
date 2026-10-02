package tritpack20

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestSnapshotRoundTripNonSquareAndImmutable(t *testing.T) {
	limits := testLimits()
	trits := []int8{
		-1, 0, 1, -1, 1,
		1, 1, 0, -1, 0,
		0, -1, 1, 1, -1,
	}
	snapshot, err := NewSnapshot(3, 5, 0.125, trits, limits)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.In() != 3 || snapshot.Out() != 5 {
		t.Fatalf("shape = [%d,%d], want [3,5]", snapshot.In(), snapshot.Out())
	}
	if snapshot.WeightScale() != float32(0.125) {
		t.Fatalf("weight scale = %g", snapshot.WeightScale())
	}
	if got, want := snapshot.PayloadBytes(), 4; got != want {
		t.Fatalf("payload bytes = %d, want %d", got, want)
	}

	first := snapshot.MarshalBinary()
	trits[0] = 1
	second := snapshot.MarshalBinary()
	if !reflect.DeepEqual(first, second) {
		t.Fatal("snapshot retained mutable trit input")
	}

	first[0] ^= 0xff
	third := snapshot.MarshalBinary()
	if reflect.DeepEqual(first, third) {
		t.Fatal("MarshalBinary exposed snapshot backing bytes")
	}
	if string(third[:8]) != snapshotMagic {
		t.Fatalf("snapshot magic mutated: %q", third[:8])
	}

	parsed, err := ParseSnapshot(third, limits)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.In() != 3 || parsed.Out() != 5 || parsed.WeightScale() != snapshot.WeightScale() {
		t.Fatalf("parsed metadata differs: [%d,%d] scale=%g", parsed.In(), parsed.Out(), parsed.WeightScale())
	}
	if parsed.Hash() != snapshot.Hash() {
		t.Fatalf("parsed hash = %x, want %x", parsed.Hash(), snapshot.Hash())
	}

	third[len(third)-1] ^= 0xff
	if reflect.DeepEqual(parsed.MarshalBinary(), third) {
		t.Fatal("ParseSnapshot retained caller backing bytes")
	}
}

func TestSnapshotGoldenEncodingV1(t *testing.T) {
	snapshot, err := NewSnapshot(1, 1, 0.5, []int8{1}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	const goldenHex = "54524954504b3230010058000100000001000000000000000100000000000000010000000000000004000000000000000000003f00000000bb396953238f98f82dc0688c6a64c92b89b65c8f538d315624d288155ed22b6302000000"
	want, err := hex.DecodeString(goldenHex)
	if err != nil {
		t.Fatal(err)
	}
	got := snapshot.MarshalBinary()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot bytes = %x\nwant           = %x", got, want)
	}
	parsed, err := ParseSnapshot(want, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if parsed.In() != 1 || parsed.Out() != 1 || parsed.WeightScale() != float32(0.5) {
		t.Fatalf("golden metadata = [%d,%d] scale=%g", parsed.In(), parsed.Out(), parsed.WeightScale())
	}
}

func TestParseSnapshotRejectsVersionTruncationHashAndCanonicalViolations(t *testing.T) {
	snapshot, err := NewSnapshot(2, 2, 0.25, []int8{-1, 0, 1, 0}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	base := snapshot.MarshalBinary()

	t.Run("version", func(t *testing.T) {
		bad := append([]byte(nil), base...)
		binary.LittleEndian.PutUint16(bad[8:10], Version+1)
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrVersion) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("truncated", func(t *testing.T) {
		if _, err := ParseSnapshot(base[:len(base)-1], testLimits()); !errors.Is(err, ErrLength) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("hash", func(t *testing.T) {
		bad := append([]byte(nil), base...)
		bad[hashOffset] ^= 1
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrHashMismatch) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("layout", func(t *testing.T) {
		bad := append([]byte(nil), base...)
		bad[12] = LayoutInOut + 1
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrLayout) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("reserved", func(t *testing.T) {
		bad := append([]byte(nil), base...)
		bad[13] = 1
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrFormat) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("trit-count", func(t *testing.T) {
		bad := append([]byte(nil), base...)
		binary.LittleEndian.PutUint64(bad[32:40], 5)
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrDimensions) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("payload-length", func(t *testing.T) {
		bad := append([]byte(nil), base...)
		binary.LittleEndian.PutUint64(bad[40:48], 8)
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrFormat) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("padding", func(t *testing.T) {
		one, err := NewSnapshot(1, 1, 1, []int8{-1}, testLimits())
		if err != nil {
			t.Fatal(err)
		}
		bad := one.MarshalBinary()
		binary.LittleEndian.PutUint32(bad[headerSize:], 3)
		rewriteSnapshotHash(bad)
		if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrInvalidPadding) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestSnapshotRejectsInvalidScales(t *testing.T) {
	for name, scale := range map[string]float32{
		"zero":              0,
		"negative":          -1,
		"nan":               float32(math.NaN()),
		"positive-infinity": float32(math.Inf(1)),
		"negative-infinity": float32(math.Inf(-1)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NewSnapshot(1, 1, scale, []int8{0}, testLimits()); !errors.Is(err, ErrScale) {
				t.Fatalf("NewSnapshot error = %v", err)
			}
		})
	}

	valid, err := NewSnapshot(1, 1, 1, []int8{0}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	for name, bits := range map[string]uint32{
		"nan":      math.Float32bits(float32(math.NaN())),
		"infinity": math.Float32bits(float32(math.Inf(1))),
		"zero":     0,
	} {
		t.Run("parse-"+name, func(t *testing.T) {
			bad := valid.MarshalBinary()
			binary.LittleEndian.PutUint32(bad[weightScaleOff:52], bits)
			rewriteSnapshotHash(bad)
			if _, err := ParseSnapshot(bad, testLimits()); !errors.Is(err, ErrScale) {
				t.Fatalf("ParseSnapshot error = %v", err)
			}
		})
	}
}

func TestSnapshotRejectsDimensionLimitAndOverflowBeforeAllocation(t *testing.T) {
	limits := testLimits()
	if _, err := NewSnapshot(0, 1, 1, nil, limits); !errors.Is(err, ErrDimensions) {
		t.Fatalf("zero input error = %v", err)
	}
	if _, err := NewSnapshot(1, 0, 1, nil, limits); !errors.Is(err, ErrDimensions) {
		t.Fatalf("zero output error = %v", err)
	}

	tight := limits
	tight.MaxInputDim = 2
	if _, err := NewSnapshot(3, 1, 1, []int8{-1, 0, 1}, tight); !errors.Is(err, ErrDimensions) {
		t.Fatalf("dimension limit error = %v", err)
	}

	huge := Limits{
		MaxInputDim:      maxInputForI64,
		MaxOutputDim:     300,
		MaxTrits:         math.MaxUint64,
		MaxPayloadBytes:  math.MaxUint64 - headerSize,
		MaxSnapshotBytes: math.MaxUint64,
	}
	if _, err := NewSnapshot(maxInputForI64, 300, 1, nil, huge); !errors.Is(err, ErrOverflow) {
		t.Fatalf("multiplication overflow error = %v", err)
	}

	unsafeAccum := huge
	unsafeAccum.MaxInputDim = maxInputForI64 + 1
	if _, err := NewSnapshot(maxInputForI64+1, 1, 1, nil, unsafeAccum); !errors.Is(err, ErrDimensions) {
		t.Fatalf("accumulation bound error = %v", err)
	}
}

func TestSnapshotLimitsMustBeExplicitAndConsistent(t *testing.T) {
	if _, err := NewSnapshot(1, 1, 1, []int8{0}, Limits{}); !errors.Is(err, ErrInvalidLimits) {
		t.Fatalf("zero limits error = %v", err)
	}
	limits := testLimits()
	limits.MaxPayloadBytes = limits.MaxSnapshotBytes
	if _, err := NewSnapshot(1, 1, 1, []int8{0}, limits); !errors.Is(err, ErrInvalidLimits) {
		t.Fatalf("inconsistent limits error = %v", err)
	}
}

func testLimits() Limits {
	return Limits{
		MaxInputDim:      1 << 20,
		MaxOutputDim:     1 << 20,
		MaxTrits:         1 << 28,
		MaxPayloadBytes:  64 << 20,
		MaxSnapshotBytes: (64 << 20) + headerSize,
	}
}

func rewriteSnapshotHash(encoded []byte) {
	for i := hashOffset; i < headerSize; i++ {
		encoded[i] = 0
	}
	sum := snapshotHash(encoded)
	copy(encoded[hashOffset:headerSize], sum[:])
}
