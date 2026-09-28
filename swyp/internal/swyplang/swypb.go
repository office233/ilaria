package swyplang

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"

	vm "swyp-lang/internal/stv2"
)

const (
	SWYPBVersion = 1
	// MaxSWYPBBytes bounds the complete module, not just its STV2 payload.
	MaxSWYPBBytes   = 64 << 10
	swypbHeaderSize = 16
	swypbOverhead   = swypbHeaderSize + sha256.Size
)

func checkSTV2Metadata(arguments int, resultType string) error {
	if arguments < 0 || arguments > 4 {
		return fmt.Errorf("SWYPB: argument count must be 0..4")
	}
	if resultType != "number" && resultType != "bool" {
		return fmt.Errorf("SWYPB: result type must be number or bool")
	}
	return nil
}

// MarshalBinary serializes a complete version-1 SWYPB module. It preserves the
// arity, result type and exact-integer profile, unlike Bytecode's raw STV2 output.
// The trailing SHA-256 detects accidental corruption; it is NOT a signature or
// evidence that code came from a trusted author or the Swyp source compiler.
func (m *STV2Module) MarshalBinary() ([]byte, error) {
	if m == nil {
		return nil, fmt.Errorf("SWYPB: nil module")
	}
	if err := checkSTV2Metadata(m.arguments, m.resultType); err != nil {
		return nil, err
	}
	payload, err := vm.EncodeV2(m.code)
	if err != nil {
		return nil, fmt.Errorf("SWYPB: %w", err)
	}
	if len(payload) > MaxSWYPBBytes-swypbOverhead {
		return nil, fmt.Errorf("SWYPB: module too large")
	}
	out := make([]byte, swypbHeaderSize+len(payload), swypbOverhead+len(payload))
	copy(out, "SWYB")
	binary.LittleEndian.PutUint16(out[4:6], SWYPBVersion)
	out[6] = 1 // Target 1: STV2.
	out[7] = 1 // Profile 1: RunV2Exact; all inputs/intermediates are safe integers.
	out[8] = 1 // Result 1: number; result 2: bool (0 or 1).
	if m.resultType == "bool" {
		out[8] = 2
	}
	out[9] = byte(m.arguments)
	// Bytes 10..11 are reserved and must stay zero.
	binary.LittleEndian.PutUint32(out[12:16], uint32(len(payload)))
	copy(out[swypbHeaderSize:], payload)
	digest := sha256.Sum256(out)
	return append(out, digest[:]...), nil
}

// LoadSWYPB validates and decodes a module without executing it or reading any
// source files. It owns all returned storage. Versions/targets/profiles are
// strict: an unsupported module must never silently fall back to another VM.
// Validation is structural, not a proof of source-level types or termination.
func LoadSWYPB(data []byte) (*STV2Module, error) {
	if len(data) < swypbOverhead || len(data) > MaxSWYPBBytes {
		return nil, fmt.Errorf("SWYPB: invalid module length")
	}
	if string(data[:4]) != "SWYB" {
		return nil, fmt.Errorf("SWYPB: invalid magic (raw STV2 is not a module)")
	}
	if v := binary.LittleEndian.Uint16(data[4:6]); v != SWYPBVersion {
		return nil, fmt.Errorf("SWYPB: unsupported version %d", v)
	}
	if data[6] != 1 || data[7] != 1 {
		return nil, fmt.Errorf("SWYPB: unsupported target or execution profile")
	}
	var resultType string
	switch data[8] {
	case 1:
		resultType = "number"
	case 2:
		resultType = "bool"
	default:
		return nil, fmt.Errorf("SWYPB: invalid result type")
	}
	arguments := int(data[9])
	if err := checkSTV2Metadata(arguments, resultType); err != nil {
		return nil, err
	}
	if data[10] != 0 || data[11] != 0 {
		return nil, fmt.Errorf("SWYPB: reserved fields must be zero")
	}
	// Bound the slice by the actual input length, never by an untrusted uint32.
	payloadEnd := len(data) - sha256.Size
	if binary.LittleEndian.Uint32(data[12:16]) != uint32(payloadEnd-swypbHeaderSize) {
		return nil, fmt.Errorf("SWYPB: payload length mismatch")
	}
	digest := sha256.Sum256(data[:payloadEnd])
	if !bytes.Equal(digest[:], data[payloadEnd:]) {
		return nil, fmt.Errorf("SWYPB: checksum mismatch")
	}
	payload := data[swypbHeaderSize:payloadEnd]
	code, err := vm.DecodeV2(payload)
	if err != nil {
		return nil, fmt.Errorf("SWYPB: %w", err)
	}
	return &STV2Module{
		code: code, packed: append([]byte(nil), payload...),
		arguments: arguments, resultType: resultType,
	}, nil
}
