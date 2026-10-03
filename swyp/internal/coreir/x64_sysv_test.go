package coreir

import (
	"encoding/binary"
	"testing"
)

func TestWrapX64SysVEntryMixedArguments(t *testing.T) {
	f := SSAFunction{
		Name:       "entry",
		Params:     []SSAValue{0, 1, 2},
		ValueTypes: []Type{Bool, IEEE64, IEEE64},
		Result:     IEEE64,
	}
	inner := []byte{0xc3}
	wrapped, err := WrapX64SysVEntry(f, inner)
	if err != nil {
		t.Fatal(err)
	}
	if len(wrapped) <= len(inner) || wrapped[len(wrapped)-1] != 0xc3 {
		t.Fatalf("wrapped=%x", wrapped)
	}
	call := -1
	for i, v := range wrapped[:len(wrapped)-len(inner)] {
		if v == 0xe8 && i+5 <= len(wrapped) {
			call = i
			break
		}
	}
	if call < 0 {
		t.Fatalf("CALL rel32 missing: %x", wrapped)
	}
	rel := int32(binary.LittleEndian.Uint32(wrapped[call+1 : call+5]))
	target := call + 5 + int(rel)
	if target != len(wrapped)-len(inner) {
		t.Fatalf("call target=%d want=%d", target, len(wrapped)-len(inner))
	}
	if wrapped[0] != 0x48 || wrapped[1] != 0x81 || wrapped[2] != 0xec {
		t.Fatalf("missing sub rsp,40 prefix: %x", wrapped[:7])
	}
}

func TestWrapX64SysVEntryRejectsUnsupportedSignature(t *testing.T) {
	f := SSAFunction{Name: "bad", Params: []SSAValue{0}, ValueTypes: []Type{F64}, Result: F64}
	if _, err := WrapX64SysVEntry(f, []byte{0xc3}); err == nil {
		t.Fatal("strict f64 SysV wrapper unexpectedly accepted")
	}
}
