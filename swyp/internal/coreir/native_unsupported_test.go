package coreir

import (
	"strings"
	"testing"
)

func TestNativeCoreRejectsByteDescriptorsWithoutPanic(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result Type
		slots  []Type
		value  int
	}{
		{name: "result", result: Bytes, slots: []Type{Bytes}, value: 0},
		{name: "slot", result: U64, slots: []Type{Bytes, U64}, value: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			instructions := []Instruction{{Op: "const", Dest: 0, Constant: &Literal{Type: Bytes, Value: "00000000:00000001"}}}
			if tc.result == U64 {
				instructions = append(instructions, Instruction{Op: "bytes.len", Dest: 1, Args: []int{0}})
			}
			m := Module{Version: Version, Data: []byte("x"), Functions: []Function{{
				Name: "value", Result: tc.result, Slots: tc.slots,
				Blocks: []Block{{Instructions: instructions, Terminator: Terminator{Op: "return", Value: tc.value}}},
			}}}
			if err := m.Validate(); err != nil {
				t.Fatal(err)
			}
			for _, profile := range []NativeProfile{NativeSafe, NativeFast} {
				if _, err := EmitNativeC(m, "value", profile); err == nil || !strings.Contains(err.Error(), "bytes is unsupported") {
					t.Fatalf("profile=%s err=%v", profile, err)
				}
			}
		})
	}
}
