package nativegraph

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

const nodeIDDomain = "swypik.nativegraph.node/v1"

type nodeIDFunc func(bindingHash, stableID string) uint64

func deriveNativeNodeID(bindingHash, stableID string) uint64 {
	h := sha256.New()
	h.Write([]byte(nodeIDDomain))
	h.Write([]byte{0})
	h.Write([]byte(bindingHash))
	h.Write([]byte{0})
	h.Write([]byte(stableID))
	sum := h.Sum(nil)
	return binary.LittleEndian.Uint64(sum[:8])
}

func parseOptionalHex(raw, field string, bits int) (uint64, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, nil
	}
	if value != raw {
		return 0, fmt.Errorf("%s %q is not canonical hexadecimal", field, raw)
	}
	if strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") {
		return 0, fmt.Errorf("%s %q must be unsigned hexadecimal", field, raw)
	}
	value = strings.TrimPrefix(strings.TrimPrefix(value, "0x"), "0X")
	if value == "" {
		return 0, fmt.Errorf("%s %q has no hexadecimal digits", field, raw)
	}
	parsed, err := strconv.ParseUint(value, 16, bits)
	if err != nil {
		return 0, fmt.Errorf("%s %q is not representable as uint%d hexadecimal: %w", field, raw, bits, err)
	}
	return parsed, nil
}
