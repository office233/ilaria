package coder

import (
	"testing"
	"unicode/utf8"
)

func TestDecodeConsoleAlwaysReturnsUTF8(t *testing.T) {
	if s := decodeConsole([]byte{0x41, 0xff, 0x42}); !utf8.ValidString(s) {
		t.Fatalf("invalid UTF-8: %q", s)
	}
}
