package tritpack20

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestPackRoundTripBoundaryCounts(t *testing.T) {
	for _, count := range []int{1, 19, 20, 21} {
		t.Run(string(rune('A'+count)), func(t *testing.T) {
			trits := make([]int8, count)
			for i := range trits {
				trits[i] = int8(i%3) - 1
			}
			payload := make([]byte, 4*((count+TritsPerWord-1)/TritsPerWord))
			if err := Pack(payload, trits); err != nil {
				t.Fatal(err)
			}
			if got, want := len(payload), 4*((count+19)/20); got != want {
				t.Fatalf("payload bytes = %d, want %d", got, want)
			}
			decoded := make([]int8, count)
			if err := Unpack(decoded, payload, uint64(count)); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(decoded, trits) {
				t.Fatalf("round trip = %v, want %v", decoded, trits)
			}
		})
	}
}

func TestPackGoldenLittleEndianVectors(t *testing.T) {
	mixed20 := []int8{-1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0}
	allPlus20 := make([]int8, 20)
	for i := range allPlus20 {
		allPlus20[i] = 1
	}
	allPlus20ThenZero := append(append([]int8(nil), allPlus20...), 0)

	tests := []struct {
		name string
		in   []int8
		hex  string
	}{
		{name: "minus-one", in: []int8{-1}, hex: "00000000"},
		{name: "zero", in: []int8{0}, hex: "01000000"},
		{name: "plus-one", in: []int8{1}, hex: "02000000"},
		{name: "mixed-20", in: mixed20, hex: "1f6eed57"},
		{name: "twenty-plus-one", in: allPlus20ThenZero, hex: "901bd4cf01000000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			want, err := hex.DecodeString(tt.hex)
			if err != nil {
				t.Fatal(err)
			}
			got := make([]byte, len(want))
			if err := Pack(got, tt.in); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("packed = %x, want %x", got, want)
			}
			roundTrip := make([]int8, len(tt.in))
			if err := Unpack(roundTrip, got, uint64(len(tt.in))); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(roundTrip, tt.in) {
				t.Fatalf("unpacked = %v, want %v", roundTrip, tt.in)
			}
		})
	}
}

func TestPackRejectsInvalidTritAndLengths(t *testing.T) {
	if err := Pack(make([]byte, 4), []int8{-1, 0, 2}); !errors.Is(err, ErrInvalidTrit) {
		t.Fatalf("invalid trit error = %v", err)
	}
	if err := Pack(make([]byte, 8), []int8{0}); !errors.Is(err, ErrLength) {
		t.Fatalf("oversized destination error = %v", err)
	}
	if err := Pack(nil, []int8{0}); !errors.Is(err, ErrLength) {
		t.Fatalf("undersized destination error = %v", err)
	}
	if err := Unpack(make([]int8, 2), make([]byte, 4), 1); !errors.Is(err, ErrLength) {
		t.Fatalf("unpack destination error = %v", err)
	}
}

func TestValidatePackedRejectsInvalidWordAndPadding(t *testing.T) {
	fullInvalid := make([]byte, 4)
	binary.LittleEndian.PutUint32(fullInvalid, powersOfThree[TritsPerWord])
	if err := ValidatePacked(fullInvalid, 20); !errors.Is(err, ErrInvalidWord) {
		t.Fatalf("invalid full word error = %v", err)
	}

	paddingInvalid := make([]byte, 4)
	// For one trit only the least-significant base-3 digit may be non-zero.
	// Word 3 has digit 1 set in the first padding position.
	binary.LittleEndian.PutUint32(paddingInvalid, 3)
	if err := ValidatePacked(paddingInvalid, 1); !errors.Is(err, ErrInvalidPadding) {
		t.Fatalf("invalid padding error = %v", err)
	}

	if err := ValidatePacked(make([]byte, 8), 20); !errors.Is(err, ErrLength) {
		t.Fatalf("payload length error = %v", err)
	}
}

func TestPackedBytesLimitsAndOverflow(t *testing.T) {
	limits := testLimits()
	for _, tc := range []struct {
		trits uint64
		bytes int
	}{
		{trits: 0, bytes: 0},
		{trits: 1, bytes: 4},
		{trits: 19, bytes: 4},
		{trits: 20, bytes: 4},
		{trits: 21, bytes: 8},
	} {
		got, err := PackedBytes(tc.trits, limits)
		if err != nil {
			t.Fatalf("PackedBytes(%d): %v", tc.trits, err)
		}
		if got != tc.bytes {
			t.Fatalf("PackedBytes(%d) = %d, want %d", tc.trits, got, tc.bytes)
		}
	}

	tight := limits
	tight.MaxTrits = 20
	if _, err := PackedBytes(21, tight); !errors.Is(err, ErrLimit) {
		t.Fatalf("trit limit error = %v", err)
	}

	tinyPayload := limits
	tinyPayload.MaxPayloadBytes = 4
	if _, err := PackedBytes(21, tinyPayload); !errors.Is(err, ErrLimit) {
		t.Fatalf("payload limit error = %v", err)
	}

	overflowLimits := Limits{
		MaxInputDim:      math.MaxUint64,
		MaxOutputDim:     math.MaxUint64,
		MaxTrits:         math.MaxUint64,
		MaxPayloadBytes:  math.MaxUint64 - headerSize,
		MaxSnapshotBytes: math.MaxUint64,
	}
	const want = 3689348814741910324
	got, err := PackedBytes(math.MaxUint64, overflowLimits)
	if maxIntUint64() < want {
		if !errors.Is(err, ErrOverflow) {
			t.Fatalf("32-bit address-space overflow error = %v", err)
		}
	} else {
		if err != nil {
			t.Fatalf("PackedBytes(MaxUint64): %v", err)
		}
		if uint64(got) != want {
			t.Fatalf("PackedBytes(MaxUint64) = %d, want %d", got, uint64(want))
		}
	}
}
