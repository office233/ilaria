package coreir

import "fmt"

const turboNoExtra = ^uint16(0)

// turboInstruction is the hot embedded representation used by RunTurbo.
//
// Core bounds slots to 512 and instructions to 8192, so 16-bit indexes are
// sufficient. Strings, variable argument slices and source Locations live in
// cold side tables and are touched only for calls, fallback operations or
// diagnostics.
type turboInstruction struct {
	constant uint64
	kind     fastInstructionKind
	op       fastValueOp
	dest     int16
	a        int16
	b        int16
	extra    uint16
	location uint16
}

// turboTerminator is the compact block-control representation used only by
// RunTurbo. Core bounds blocks to 256 and slots to 512, so int16 is sufficient.
// Source locations remain in the shared cold location table.
type turboTerminator struct {
	kind     fastTerminatorKind
	value    int16
	target0  int16
	target1  int16
	location uint16
}

type turboExtra struct {
	rawOp  string
	callee string
	args   []int16
}

func prepareTurboBlocks(f Function, constants [][]Value) ([][]turboInstruction, []turboExtra, []Location, error) {
	blocks := make([][]turboInstruction, len(f.Blocks))
	extras := make([]turboExtra, 0)
	locations := make([]Location, 0)
	for bi, block := range f.Blocks {
		blocks[bi] = make([]turboInstruction, len(block.Instructions))
		for ii, ins := range block.Instructions {
			if len(locations) >= int(turboNoExtra) {
				return nil, nil, nil, fmt.Errorf("turbo bytecode: location table overflow")
			}
			ti := turboInstruction{
				kind:     fastValue,
				op:       fastValueOpFor(f, ins),
				dest:     int16(ins.Dest),
				a:        -1,
				b:        -1,
				extra:    turboNoExtra,
				location: uint16(len(locations)),
			}
			locations = append(locations, ins.Location)
			switch ins.Op {
			case "const":
				ti.kind = fastConst
				ti.constant = valueToRaw(constants[bi][ii])
			case "move":
				ti.kind = fastMove
				ti.a = int16(ins.Args[0])
			case "call":
				ti.kind = fastCall
				extra, err := appendTurboExtra(&extras, turboExtra{
					callee: ins.Callee,
					args:   turboArgs(ins.Args),
				})
				if err != nil {
					return nil, nil, nil, err
				}
				ti.extra = extra
			case "bytes.len":
				ti.kind = fastBytesLen
				ti.a = int16(ins.Args[0])
			case "bytes.get":
				ti.kind = fastBytesGet
				ti.a = int16(ins.Args[0])
				ti.b = int16(ins.Args[1])
			case "storage.alloc_u64":
				ti.kind = fastStorageAllocU64
				ti.a = int16(ins.Args[0])
			case "storage.load_u64":
				ti.kind = fastStorageLoadU64
				ti.a = int16(ins.Args[0])
				ti.b = int16(ins.Args[1])
			case "storage.store_u64":
				ti.kind = fastStorageStoreU64
				extra, err := appendTurboExtra(&extras, turboExtra{args: turboArgs(ins.Args)})
				if err != nil {
					return nil, nil, nil, err
				}
				ti.extra = extra
			case "storage.free":
				ti.kind = fastStorageFree
				ti.a = int16(ins.Args[0])
			case "storage.len_u64":
				ti.kind = fastStorageLenU64
				ti.a = int16(ins.Args[0])
			case "storage.capacity_u64":
				ti.kind = fastStorageCapacityU64
				ti.a = int16(ins.Args[0])
			case "storage.set_len_u64":
				ti.kind = fastStorageSetLenU64
				ti.a = int16(ins.Args[0])
				ti.b = int16(ins.Args[1])
			default:
				if len(ins.Args) > 0 {
					ti.a = int16(ins.Args[0])
				}
				if len(ins.Args) > 1 {
					ti.b = int16(ins.Args[1])
				}
				if ti.op == fastFallback {
					extra, err := appendTurboExtra(&extras, turboExtra{rawOp: ins.Op})
					if err != nil {
						return nil, nil, nil, err
					}
					ti.extra = extra
				}
			}
			blocks[bi][ii] = ti
		}
	}
	return blocks, extras, locations, nil
}

func prepareTurboTerminators(f Function, locations *[]Location) ([]turboTerminator, error) {
	if locations == nil {
		return nil, fmt.Errorf("turbo bytecode: nil location table")
	}
	out := make([]turboTerminator, len(f.Blocks))
	for bi, block := range f.Blocks {
		if len(*locations) >= int(turboNoExtra) {
			return nil, fmt.Errorf("turbo bytecode: location table overflow")
		}
		t := block.Terminator
		tt := turboTerminator{
			value:    int16(t.Value),
			target0:  -1,
			target1:  -1,
			location: uint16(len(*locations)),
		}
		*locations = append(*locations, t.Location)
		switch t.Op {
		case "return":
			tt.kind = fastReturn
		case "jump":
			tt.kind = fastJump
			tt.target0 = int16(t.Targets[0])
		case "branch":
			tt.kind = fastBranch
			tt.target0 = int16(t.Targets[0])
			tt.target1 = int16(t.Targets[1])
		case "unreachable":
			tt.kind = fastUnreachable
		default:
			return nil, fmt.Errorf("turbo bytecode: unsupported terminator %q", t.Op)
		}
		out[bi] = tt
	}
	return out, nil
}

func appendTurboExtra(extras *[]turboExtra, extra turboExtra) (uint16, error) {
	if len(*extras) >= int(turboNoExtra) {
		return 0, fmt.Errorf("turbo bytecode: extra table overflow")
	}
	index := uint16(len(*extras))
	*extras = append(*extras, extra)
	return index, nil
}

func turboArgs(args []int) []int16 {
	if len(args) == 0 {
		return nil
	}
	out := make([]int16, len(args))
	for i, arg := range args {
		out[i] = int16(arg)
	}
	return out
}
