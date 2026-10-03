package main

import (
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestNativeBackendsRejectBytesUntilArenaExists(t *testing.T) {
	m := coreir.Module{Version: coreir.Version, Functions: []coreir.Function{{
		Name:   "id",
		Params: []coreir.Parameter{{Name: "x", Type: coreir.Bytes}},
		Result: coreir.Bytes,
		Slots:  []coreir.Type{coreir.Bytes},
		Blocks: []coreir.Block{{Terminator: coreir.Terminator{Op: "return", Value: 0}}},
	}}}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, validate := range map[string]func(coreir.Module, string) error{
		"x64":   validateX64NativeModule,
		"arm64": validateARM64NativeModule,
	} {
		err := validate(m, "id")
		if err == nil || !strings.Contains(err.Error(), "byte arena support") {
			t.Fatalf("%s bytes native validation err=%v", name, err)
		}
	}
}
