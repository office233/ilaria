package coreir

import (
	"encoding/binary"
	"testing"
)

func arm64Words(code []byte) []uint32 {
	words := make([]uint32, len(code)/4)
	for i := range words {
		words[i] = binary.LittleEndian.Uint32(code[i*4:])
	}
	return words
}

// Every BL overwrites x30, so a function that calls a runtime helper must
// reload its caller's return address before each RET. Without this the RET
// jumps back after the last BL and walks the stack until the process faults.
func TestARM64NonLeafFunctionReloadsLinkRegisterBeforeEveryReturn(t *testing.T) {
	f := SSAFunction{
		Name:       "now",
		Result:     U64,
		ValueTypes: []Type{U64, U64},
		Blocks: []SSABlock{{
			Reachable: true,
			Instructions: []SSAInstruction{
				{Op: "clock.read", Dest: 0},
				{Op: "io.stdout", Dest: NoSSAValue, Args: []SSAValue{0}},
				{Op: "const", Dest: 1, Constant: &Literal{Type: U64, Value: "0"}},
			},
			Terminator: SSATerminator{Op: "return", Value: 1},
		}},
	}
	plan := SSARegisterPlan{Locations: []RegisterLocation{
		{Class: RegisterGPR, Register: 0, Spill: -1},
		{Class: RegisterGPR, Register: 1, Spill: -1},
	}}
	process, err := EmitARM64CFGMachineProcessModule([]SSAFunction{f}, map[string]SSARegisterPlan{"now": plan}, "now")
	if err != nil {
		t.Fatal(err)
	}
	isSPSlot := func(word, base uint32) bool { return word&0xffc0001f == base|30 && (word>>5)&31 == 31 }
	words := arm64Words(process.Code)
	saved, lastBL, rets := false, -1, 0
	for i, word := range words {
		switch {
		case isSPSlot(word, 0xf9000000): // STR x30, [sp, #imm]
			saved = true
		case word&0xfc000000 == 0x94000000: // BL
			if !saved {
				t.Fatalf("word %d: BL before x30 was saved", i)
			}
			lastBL = i
		case word == 0xd65f03c0: // RET
			rets++
			reloaded := false
			for j := lastBL + 1; j < i; j++ {
				if isSPSlot(words[j], 0xf9400000) { // LDR x30, [sp, #imm]
					reloaded = true
				}
			}
			if !reloaded {
				t.Fatalf("word %d: RET without reloading x30 after the BL at word %d", i, lastBL)
			}
		}
	}
	if rets == 0 || lastBL < 0 {
		t.Fatalf("fixture emitted rets=%d lastBL=%d", rets, lastBL)
	}
}

// When the allocator reuses an operand register for the product, SMULH must
// still see both original operands, so it has to run before MUL.
func TestARM64CheckedMulReadsOperandsBeforeAliasedWrite(t *testing.T) {
	for _, alias := range []int{0, 1} {
		f := SSAFunction{
			Name:       "mul",
			Params:     []SSAValue{0, 1},
			ParamNames: []string{"a", "b"},
			Result:     I64,
			ValueTypes: []Type{I64, I64, I64},
			Blocks: []SSABlock{{
				Reachable:    true,
				Instructions: []SSAInstruction{{Op: "mul", Dest: 2, Args: []SSAValue{0, 1}, MayTrap: true}},
				Terminator:   SSATerminator{Op: "return", Value: 2},
			}},
		}
		plan := SSARegisterPlan{Locations: []RegisterLocation{
			{Class: RegisterGPR, Register: 0, Spill: -1},
			{Class: RegisterGPR, Register: 1, Spill: -1},
			{Class: RegisterGPR, Register: alias, Spill: -1},
		}}
		code, err := EmitARM64CFGMachineCode(f, plan)
		if err != nil {
			t.Fatal(err)
		}
		smulh, mul := -1, -1
		for i, word := range arm64Words(code) {
			switch word & 0xffe0fc00 {
			case 0x9b407c00:
				smulh = i
				if rn, rm := (word>>5)&31, (word>>16)&31; rn != 9 || rm != 10 {
					t.Fatalf("alias=%d SMULH operands x%d,x%d want x9,x10", alias, rn, rm)
				}
			case 0x9b007c00:
				if mul < 0 {
					mul = i
				}
			}
		}
		if smulh < 0 || mul < 0 || smulh > mul {
			t.Fatalf("alias=%d smulh=%d mul=%d: SMULH must precede MUL", alias, smulh, mul)
		}
	}
}

func TestARM64CheckedDivRemLowering(t *testing.T) {
	for _, tc := range []struct {
		typ      Type
		op       string
		divide   uint32
		needMSUB bool
	}{
		{I64, "div", 0x9ac00c00, false},
		{I64, "rem", 0x9ac00c00, true},
		{U64, "div", 0x9ac00800, false},
		{U64, "rem", 0x9ac00800, true},
	} {
		f := SSAFunction{
			Name:       "divrem",
			Params:     []SSAValue{0, 1},
			ParamNames: []string{"a", "b"},
			Result:     tc.typ,
			ValueTypes: []Type{tc.typ, tc.typ, tc.typ},
			Blocks: []SSABlock{{
				Reachable:    true,
				Instructions: []SSAInstruction{{Op: tc.op, Dest: 2, Args: []SSAValue{0, 1}, MayTrap: true}},
				Terminator:   SSATerminator{Op: "return", Value: 2},
			}},
		}
		plan := SSARegisterPlan{Locations: []RegisterLocation{
			{Class: RegisterGPR, Register: 0, Spill: -1},
			{Class: RegisterGPR, Register: 1, Spill: -1},
			{Class: RegisterGPR, Register: 1, Spill: -1},
		}}
		code, err := EmitARM64CFGMachineCode(f, plan)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.typ, tc.op, err)
		}
		zeroCheck, divide, msub := -1, -1, -1
		for i, word := range arm64Words(code) {
			switch {
			case word == 0xeb1f015f && zeroCheck < 0: // CMP x10, XZR (divisor)
				zeroCheck = i
			case word&0xffe0fc00 == tc.divide:
				divide = i
			case word&0xffe08000 == 0x9b008000:
				msub = i
			}
		}
		if zeroCheck < 0 || divide < 0 || zeroCheck > divide {
			t.Fatalf("%s %s: zero-divisor check=%d must precede divide=%d", tc.typ, tc.op, zeroCheck, divide)
		}
		if tc.needMSUB != (msub > divide) {
			t.Fatalf("%s %s: msub=%d divide=%d needMSUB=%v", tc.typ, tc.op, msub, divide, tc.needMSUB)
		}
	}
}

// The dotted-quad parser must branch to failure when a byte follows the fourth
// octet (CBNZ on the delimiter). A CBZ there rejected every valid IPv4 literal
// and accepted trailing garbage; runtime proof lives in the qemu parity corpus.
func TestARM64IPv4ParsersRequireTerminatorAfterFourthOctet(t *testing.T) {
	connect, _, err := buildARM64LinuxNetConnectHelper(64)
	if err != nil {
		t.Fatal(err)
	}
	fetch, _, err := buildARM64LinuxNetFetchHelper(64, DefaultProcessRuntimeArenaBytes)
	if err != nil {
		t.Fatal(err)
	}
	for name, code := range map[string][]byte{"net.connect": connect, "net.fetch": fetch} {
		found := false
		for _, word := range arm64Words(code) {
			if word&0xff00001f == 0xb500000c { // CBNZ x12, <failure>
				found = true
			}
		}
		if !found {
			t.Fatalf("%s helper has no CBNZ x12 terminator check", name)
		}
	}
}
