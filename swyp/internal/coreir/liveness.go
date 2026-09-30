package coreir

import "fmt"

// BlockLiveness contains classic backwards data-flow liveness for one CFG
// block. Indices correspond to Function.Slots.
type BlockLiveness struct {
	LiveIn  []bool
	LiveOut []bool
}

// Liveness is the per-block slot liveness for a function.
type Liveness struct {
	Blocks []BlockLiveness
}

// AnalyzeLiveness computes live-in/live-out sets for the mutable-slot Core IR.
//
// This analysis is intentionally separate from SSA conversion: it is valid for
// the current IR and can drive slot compaction and future linear-scan register
// allocation without changing program semantics.
func AnalyzeLiveness(f Function) (Liveness, error) {
	if len(f.Blocks) == 0 {
		return Liveness{}, fmt.Errorf("liveness: function has no blocks")
	}
	nSlots := len(f.Slots)
	use := make([][]bool, len(f.Blocks))
	def := make([][]bool, len(f.Blocks))
	succ := make([][]int, len(f.Blocks))

	for bi, block := range f.Blocks {
		use[bi] = make([]bool, nSlots)
		def[bi] = make([]bool, nSlots)
		if bi == 0 {
			for i := range f.Params {
				if i >= nSlots {
					return Liveness{}, fmt.Errorf("liveness: parameter slot %d out of range", i)
				}
				def[bi][i] = true
			}
		}
		for ii, ins := range block.Instructions {
			for _, slot := range ins.Args {
				if slot < 0 || slot >= nSlots {
					return Liveness{}, fmt.Errorf("liveness: block %d instruction %d operand slot %d out of range", bi, ii, slot)
				}
				if !def[bi][slot] {
					use[bi][slot] = true
				}
			}
			if ins.Dest >= 0 {
				if ins.Dest >= nSlots {
					return Liveness{}, fmt.Errorf("liveness: block %d instruction %d destination slot %d out of range", bi, ii, ins.Dest)
				}
				def[bi][ins.Dest] = true
			}
		}
		if slot := block.Terminator.Value; slot >= 0 {
			if slot >= nSlots {
				return Liveness{}, fmt.Errorf("liveness: block %d terminator slot %d out of range", bi, slot)
			}
			if !def[bi][slot] {
				use[bi][slot] = true
			}
		}
		for _, target := range block.Terminator.Targets {
			if target < 0 || target >= len(f.Blocks) {
				return Liveness{}, fmt.Errorf("liveness: block %d target %d out of range", bi, target)
			}
			succ[bi] = append(succ[bi], target)
		}
	}

	result := Liveness{Blocks: make([]BlockLiveness, len(f.Blocks))}
	for bi := range result.Blocks {
		result.Blocks[bi].LiveIn = make([]bool, nSlots)
		result.Blocks[bi].LiveOut = make([]bool, nSlots)
	}
	for changed := true; changed; {
		changed = false
		for bi := len(f.Blocks) - 1; bi >= 0; bi-- {
			newOut := make([]bool, nSlots)
			for _, target := range succ[bi] {
				for slot, live := range result.Blocks[target].LiveIn {
					newOut[slot] = newOut[slot] || live
				}
			}
			newIn := make([]bool, nSlots)
			for slot := 0; slot < nSlots; slot++ {
				newIn[slot] = use[bi][slot] || (newOut[slot] && !def[bi][slot])
			}
			if !sameBools(newOut, result.Blocks[bi].LiveOut) || !sameBools(newIn, result.Blocks[bi].LiveIn) {
				changed = true
				result.Blocks[bi].LiveOut = newOut
				result.Blocks[bi].LiveIn = newIn
			}
		}
	}
	return result, nil
}

func sameBools(a, b []bool) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// compactSlots removes unused non-parameter slot holes left after optimizer
// transforms and remaps all surviving references. It returns the number of
// removed slots.
func compactSlots(f *Function) (int, error) {
	if len(f.Slots) == 0 {
		return 0, nil
	}
	used := make([]bool, len(f.Slots))
	for i := range f.Params {
		if i >= len(used) {
			return 0, fmt.Errorf("slot compaction: parameter %d out of range", i)
		}
		used[i] = true
	}
	for bi, block := range f.Blocks {
		for ii, ins := range block.Instructions {
			for _, slot := range ins.Args {
				if slot < 0 || slot >= len(used) {
					return 0, fmt.Errorf("slot compaction: block %d instruction %d operand %d out of range", bi, ii, slot)
				}
				used[slot] = true
			}
			if ins.Dest >= 0 {
				if ins.Dest >= len(used) {
					return 0, fmt.Errorf("slot compaction: block %d instruction %d destination %d out of range", bi, ii, ins.Dest)
				}
				used[ins.Dest] = true
			}
		}
		if slot := block.Terminator.Value; slot >= 0 {
			if slot >= len(used) {
				return 0, fmt.Errorf("slot compaction: block %d terminator %d out of range", bi, slot)
			}
			used[slot] = true
		}
	}

	remap := make([]int, len(f.Slots))
	newSlots := make([]Type, 0, len(f.Slots))
	for old, keep := range used {
		if !keep {
			remap[old] = -1
			continue
		}
		remap[old] = len(newSlots)
		newSlots = append(newSlots, f.Slots[old])
	}
	removed := len(f.Slots) - len(newSlots)
	if removed == 0 {
		return 0, nil
	}
	for bi := range f.Blocks {
		for ii := range f.Blocks[bi].Instructions {
			ins := &f.Blocks[bi].Instructions[ii]
			for ai, old := range ins.Args {
				ins.Args[ai] = remap[old]
			}
			if ins.Dest >= 0 {
				ins.Dest = remap[ins.Dest]
			}
		}
		if f.Blocks[bi].Terminator.Value >= 0 {
			f.Blocks[bi].Terminator.Value = remap[f.Blocks[bi].Terminator.Value]
		}
	}
	f.Slots = newSlots
	return removed, nil
}
