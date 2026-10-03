package coreir

import "fmt"

type SSAValue int

const NoSSAValue SSAValue = -1

type SSAPhiInput struct {
	Predecessor int
	Value       SSAValue
}

type SSAPhi struct {
	Dest   SSAValue
	Slot   int
	Inputs []SSAPhiInput
}

type SSAInstruction struct {
	Op       string
	Dest     SSAValue
	Args     []SSAValue
	Constant *Literal
	Callee   string
	MayTrap  bool
	Location Location
}

type SSATerminator struct {
	Op       string
	Value    SSAValue
	Targets  []int
	Location Location
}

type SSABlock struct {
	Reachable    bool
	Phis         []SSAPhi
	Instructions []SSAInstruction
	Terminator   SSATerminator
}

type SSAFunction struct {
	Name       string
	Params     []SSAValue
	ParamNames []string
	Result     Type
	ValueTypes []Type
	Blocks     []SSABlock
}

func ssaValueUsed(f SSAFunction, value SSAValue) bool {
	for _, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		for _, phi := range block.Phis {
			for _, input := range phi.Inputs {
				if input.Value == value {
					return true
				}
			}
		}
		for _, ins := range block.Instructions {
			for _, arg := range ins.Args {
				if arg == value {
					return true
				}
			}
		}
		if block.Terminator.Value == value {
			return true
		}
	}
	return false
}

// BuildSSA versions mutable Core slots into a conventional SSA view. It does
// not mutate the input Function. Incoming phis are pruned by slot liveness;
// every reachable read must still be definitely assigned. Core's executable/
// wire format remains unchanged.
func BuildSSA(f Function) (SSAFunction, error) {
	if len(f.Blocks) == 0 {
		return SSAFunction{}, fmt.Errorf("ssa: function has no blocks")
	}
	preds, reachable, err := ssaCFG(f)
	if err != nil {
		return SSAFunction{}, err
	}
	liveness, err := AnalyzeLiveness(f)
	if err != nil {
		return SSAFunction{}, err
	}
	if err := definiteAssignment(f, preds); err != nil {
		return SSAFunction{}, fmt.Errorf("ssa: %w", err)
	}
	result := SSAFunction{
		Name:       f.Name,
		Result:     f.Result,
		Params:     make([]SSAValue, len(f.Params)),
		ParamNames: make([]string, len(f.Params)),
		Blocks:     make([]SSABlock, len(f.Blocks)),
	}
	newValue := func(t Type) SSAValue {
		id := SSAValue(len(result.ValueTypes))
		result.ValueTypes = append(result.ValueTypes, t)
		return id
	}

	for i, p := range f.Params {
		result.Params[i] = newValue(p.Type)
		result.ParamNames[i] = p.Name
	}

	// Instruction definitions have stable IDs independent of fixed-point
	// iteration. A mutable slot may therefore have many SSA definitions.
	defs := make([][]SSAValue, len(f.Blocks))
	for bi, block := range f.Blocks {
		defs[bi] = make([]SSAValue, len(block.Instructions))
		for ii, ins := range block.Instructions {
			defs[bi][ii] = NoSSAValue
			if ins.Dest >= 0 {
				defs[bi][ii] = newValue(f.Slots[ins.Dest])
			}
		}
	}

	phiIDs := make([][]SSAValue, len(f.Blocks))
	for bi := range phiIDs {
		phiIDs[bi] = make([]SSAValue, len(f.Slots))
		for slot := range phiIDs[bi] {
			phiIDs[bi][slot] = NoSSAValue
		}
	}
	in := make([][]SSAValue, len(f.Blocks))
	out := make([][]SSAValue, len(f.Blocks))
	for bi := range f.Blocks {
		in[bi] = make([]SSAValue, len(f.Slots))
		out[bi] = make([]SSAValue, len(f.Slots))
		for slot := range f.Slots {
			in[bi][slot] = NoSSAValue
			out[bi][slot] = NoSSAValue
		}
	}
	for i, value := range result.Params {
		in[0][i] = value
	}

	// Iterate incoming versions until loop/backedge merges stabilize. A phi ID,
	// once allocated for block+slot, remains stable.
	maxIterations := len(f.Blocks)*len(f.Slots)*2 + 8
	for iteration := 0; iteration < maxIterations; iteration++ {
		changed := false
		for bi, block := range f.Blocks {
			if !reachable[bi] {
				continue
			}
			if bi != 0 {
				for slot := range f.Slots {
					if !liveness.Blocks[bi].LiveIn[slot] {
						continue
					}
					merged := mergeSSAPredecessors(preds[bi], out, reachable, slot)
					if len(merged) == 1 {
						if in[bi][slot] != merged[0] {
							in[bi][slot] = merged[0]
							changed = true
						}
					} else if len(merged) > 1 {
						if phiIDs[bi][slot] == NoSSAValue {
							phiIDs[bi][slot] = newValue(f.Slots[slot])
							changed = true
						}
						if in[bi][slot] != phiIDs[bi][slot] {
							in[bi][slot] = phiIDs[bi][slot]
							changed = true
						}
					}
				}
			}
			state := append([]SSAValue(nil), in[bi]...)
			for ii, ins := range block.Instructions {
				if ins.Dest >= 0 {
					state[ins.Dest] = defs[bi][ii]
				}
			}
			if !sameSSAValues(state, out[bi]) {
				copy(out[bi], state)
				changed = true
			}
		}
		if !changed {
			break
		}
		if iteration == maxIterations-1 {
			return SSAFunction{}, fmt.Errorf("ssa: data-flow did not converge")
		}
	}

	for bi, block := range f.Blocks {
		result.Blocks[bi].Reachable = reachable[bi]
		if !reachable[bi] {
			continue
		}
		for slot, phi := range phiIDs[bi] {
			if phi == NoSSAValue {
				continue
			}
			inputs := make([]SSAPhiInput, 0, len(preds[bi]))
			for _, pred := range preds[bi] {
				if !reachable[pred] {
					continue
				}
				value := out[pred][slot]
				if value == NoSSAValue {
					return SSAFunction{}, fmt.Errorf("ssa: phi block %d slot %d has undefined predecessor %d", bi, slot, pred)
				}
				inputs = append(inputs, SSAPhiInput{Predecessor: pred, Value: value})
			}
			result.Blocks[bi].Phis = append(result.Blocks[bi].Phis, SSAPhi{Dest: phi, Slot: slot, Inputs: inputs})
		}

		state := append([]SSAValue(nil), in[bi]...)
		for ii, ins := range block.Instructions {
			ssaIns := SSAInstruction{
				Op:       ins.Op,
				Dest:     defs[bi][ii],
				Args:     make([]SSAValue, len(ins.Args)),
				Callee:   ins.Callee,
				MayTrap:  ins.MayTrap,
				Location: ins.Location,
			}
			if ins.Constant != nil {
				literal := *ins.Constant
				ssaIns.Constant = &literal
			}
			for ai, slot := range ins.Args {
				if state[slot] == NoSSAValue {
					return SSAFunction{}, fmt.Errorf("ssa: block %d instruction %d reads undefined slot %d", bi, ii, slot)
				}
				ssaIns.Args[ai] = state[slot]
			}
			result.Blocks[bi].Instructions = append(result.Blocks[bi].Instructions, ssaIns)
			if ins.Dest >= 0 {
				state[ins.Dest] = defs[bi][ii]
			}
		}
		termValue := NoSSAValue
		if block.Terminator.Value >= 0 {
			termValue = state[block.Terminator.Value]
			if termValue == NoSSAValue {
				return SSAFunction{}, fmt.Errorf("ssa: block %d terminator reads undefined slot %d", bi, block.Terminator.Value)
			}
		}
		result.Blocks[bi].Terminator = SSATerminator{
			Op:       block.Terminator.Op,
			Value:    termValue,
			Targets:  append([]int(nil), block.Terminator.Targets...),
			Location: block.Terminator.Location,
		}
	}
	return result, nil
}

func ssaCFG(f Function) ([][]int, []bool, error) {
	preds := make([][]int, len(f.Blocks))
	reachable := make([]bool, len(f.Blocks))
	reachable[0] = true
	queue := []int{0}
	for len(queue) > 0 {
		bi := queue[0]
		queue = queue[1:]
		for _, target := range f.Blocks[bi].Terminator.Targets {
			if target < 0 || target >= len(f.Blocks) {
				return nil, nil, fmt.Errorf("ssa: block %d target %d out of range", bi, target)
			}
			preds[target] = append(preds[target], bi)
			if !reachable[target] {
				reachable[target] = true
				queue = append(queue, target)
			}
		}
	}
	return preds, reachable, nil
}

func mergeSSAPredecessors(preds []int, out [][]SSAValue, reachable []bool, slot int) []SSAValue {
	values := make([]SSAValue, 0, len(preds))
	for _, pred := range preds {
		if !reachable[pred] {
			continue
		}
		value := out[pred][slot]
		if value == NoSSAValue {
			// A loop backedge may not have been propagated yet. Ignore unknown
			// predecessors during fixed-point iteration; validated Core IR
			// guarantees that any value actually read is definitely assigned on
			// all reachable paths.
			continue
		}
		seen := false
		for _, existing := range values {
			if existing == value {
				seen = true
				break
			}
		}
		if !seen {
			values = append(values, value)
		}
	}
	return values
}

func sameSSAValues(a, b []SSAValue) bool {
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
