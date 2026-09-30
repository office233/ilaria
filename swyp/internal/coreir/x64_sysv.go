package coreir

import "fmt"

var x64SysVGPRArgs = []int{x64RDI, x64RSI, x64RDX, x64RCX, x64R8, x64R9}

// WrapX64SysVEntry prepends a System V AMD64 entry thunk to the existing Win64
// packed machine-code blob. Swyp's internal packed ABI stays unchanged; only the
// externally visible entry is adapted for ELF/Mach-O linkers and callers.
//
// Program arguments and the trailing status pointer are first staged in the
// 40-byte Win64 call area, then remapped to positional Win64 GPR/XMM lanes. The
// thunk calls the original entry at the start of the appended blob and returns
// its RAX/XMM0 result unchanged.
func WrapX64SysVEntry(f SSAFunction, code []byte) ([]byte, error) {
	if len(code) == 0 || len(code) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 sysv thunk: invalid code size %d", len(code))
	}
	if len(f.Params) > 4 {
		return nil, fmt.Errorf("x64 sysv thunk: supports at most four program parameters")
	}

	b := &x64MachineBuilder{}
	// SysV entry has RSP %% 16 == 8. Reserving 40 bytes gives RSP %% 16 == 0
	// before CALL while also providing the 32-byte Win64 shadow area and the
	// fifth stack-argument slot when four program parameters are present.
	b.subRegImm32(x64RSP, 40)
	gprIndex, fpIndex := 0, 0
	for i, value := range f.Params {
		t := f.ValueTypes[value]
		switch t {
		case IEEE64:
			if fpIndex >= 8 {
				return nil, fmt.Errorf("x64 sysv thunk: FP argument registers exceeded")
			}
			b.movsdMemDisp32XMM(x64RSP, int32(i*8), fpIndex)
			fpIndex++
		case I64, U64, Bool:
			if gprIndex >= len(x64SysVGPRArgs) {
				return nil, fmt.Errorf("x64 sysv thunk: GPR argument registers exceeded")
			}
			b.movMemDisp32Reg(x64RSP, int32(i*8), x64SysVGPRArgs[gprIndex])
			gprIndex++
		default:
			return nil, fmt.Errorf("x64 sysv thunk: unsupported parameter type %s", t)
		}
	}
	if gprIndex >= len(x64SysVGPRArgs) {
		return nil, fmt.Errorf("x64 sysv thunk: status pointer register unavailable")
	}
	b.movMemDisp32Reg(x64RSP, int32(len(f.Params)*8), x64SysVGPRArgs[gprIndex])

	for i, value := range f.Params {
		if f.ValueTypes[value] == IEEE64 {
			b.movsdXMMMemDisp32(i, x64RSP, int32(i*8))
		} else {
			b.movRegMemDisp32(x64WinArgRegs[i], x64RSP, int32(i*8))
		}
	}
	if len(f.Params) < 4 {
		b.movRegMemDisp32(x64WinArgRegs[len(f.Params)], x64RSP, int32(len(f.Params)*8))
	}
	callDisp := b.callRel32()
	b.addRegImm32(x64RSP, 40)
	b.ret()

	innerOffset := len(b.code)
	out := append(append([]byte(nil), b.code...), code...)
	patchX64Rel32(out, callDisp, innerOffset)
	if len(out) > MaxX64LeafCodeBytes {
		return nil, fmt.Errorf("x64 sysv thunk: wrapped code exceeds limit")
	}
	return out, nil
}
