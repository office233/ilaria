package coreir

import (
	"fmt"
)

// OptimizationReport records deterministic transformations performed by
// Optimize. It deliberately excludes timing claims.
type OptimizationReport struct {
	FoldedConstants    int
	SimplifiedOps      int
	SimplifiedBranches int
	ThreadedJumps      int
	DeadInstructions   int
	RemovedBlocks      int
	CompactedSlots     int
	PropagatedCopies   int
	InlinedCalls       int
}

// Optimize performs conservative value/trap-preserving simplifications.
//
// It intentionally does not preserve exact instruction-count/fuel accounting,
// so it must not be used by the exact-fuel interpreter or NativeSafe. It is
// suitable for NativeFast and future optimized backends.
func Optimize(m Module) (Module, OptimizationReport, error) {
	if err := m.Validate(); err != nil {
		return Module{}, OptimizationReport{}, err
	}

	// Work on an owned structural snapshot so optimization cannot mutate caller
	// state. External JSON still goes through DecodeStrict; an internal clone
	// does not need to serialize and parse the already-validated module.
	out := cloneModule(m)

	var report OptimizationReport
	// Canonicalize trivial CFG forwarding before deciding inlining eligibility.
	// Source lowering intentionally uses explicit join blocks; threading empty
	// jumps makes the optimizer reason about semantic CFG size rather than
	// lowering scaffolding.
	for fi := range out.Functions {
		threadTrivialJumpBlocks(&out.Functions[fi], &report)
		removeUnreachableBlocks(&out.Functions[fi], &report)
	}
	inlineSmallPureCalls(&out, &report)
	for fi := range out.Functions {
		f := &out.Functions[fi]
		for bi := range f.Blocks {
			optimizeBlock(f, &f.Blocks[bi], &report)
		}
		propagateCopies(f, &report)
		threadTrivialJumpBlocks(f, &report)
		removeUnreachableBlocks(f, &report)
		removeDeadNoTrapInstructions(f, &report)
		removed, err := compactSlots(f)
		if err != nil {
			return Module{}, OptimizationReport{}, err
		}
		report.CompactedSlots += removed
	}

	if err := out.Validate(); err != nil {
		return Module{}, OptimizationReport{}, fmt.Errorf("optimizer produced invalid IR: %w", err)
	}
	return out, report, nil
}

func threadTrivialJumpBlocks(f *Function, report *OptimizationReport) {
	if f == nil || len(f.Blocks) < 2 {
		return
	}
	resolve := func(target int) int {
		for steps := 0; steps < len(f.Blocks) && target > 0 && target < len(f.Blocks); steps++ {
			block := f.Blocks[target]
			if len(block.Instructions) != 0 || block.Terminator.Op != "jump" || len(block.Terminator.Targets) != 1 {
				break
			}
			next := block.Terminator.Targets[0]
			if next == target {
				break
			}
			target = next
		}
		return target
	}
	for bi := range f.Blocks {
		for ti, target := range f.Blocks[bi].Terminator.Targets {
			resolved := resolve(target)
			if resolved != target {
				f.Blocks[bi].Terminator.Targets[ti] = resolved
				report.ThreadedJumps++
			}
		}
	}
}

const (
	maxInlineInstructions    = 24
	maxInlineCFGBlocks       = 4
	maxInlineCFGInstructions = 32
	maxInlineRounds          = 8
)

// inlineSmallPureCalls removes the common helper-call case from optimized
// programs before SSA/native lowering. It intentionally accepts only small,
// pure, single-block, call-free functions. General calls retain their explicit
// Core semantics and are left for future native call lowering.
func inlineSmallPureCalls(m *Module, report *OptimizationReport) {
	if m == nil {
		return
	}
	for round := 0; round < maxInlineRounds; round++ {
		changed := inlineSmallPureCallsRound(m, report)
		if inlineOneSmallPureCFGCall(m, report) {
			changed = true
		}
		if !changed {
			return
		}
	}
}

func inlineOneSmallPureCFGCall(m *Module, report *OptimizationReport) bool {
	byName := make(map[string]Function, len(m.Functions))
	for _, f := range m.Functions {
		byName[f.Name] = f
	}
	for fi := range m.Functions {
		caller := &m.Functions[fi]
		for bi := 0; bi < len(caller.Blocks); bi++ {
			block := caller.Blocks[bi]
			for ii, call := range block.Instructions {
				if call.Op != "call" {
					continue
				}
				callee, ok := byName[call.Callee]
				if !ok || !inlineCFGEligible(*caller, callee, call) {
					continue
				}
				if moduleInstructionUnits(*m)+inlineCFGInstructionGrowth(callee) > MaxInstructions {
					continue
				}
				if inlineCFGCall(caller, bi, ii, callee, call) {
					report.InlinedCalls++
					return true
				}
			}
		}
	}
	return false
}

func inlineCFGEligible(caller, callee Function, call Instruction) bool {
	if caller.Name == callee.Name || callee.EffectVersion != 0 || len(callee.Effects) != 0 || len(callee.RequiredCapabilities) != 0 {
		return false
	}
	if len(callee.Blocks) < 2 || len(callee.Blocks) > maxInlineCFGBlocks || len(call.Args) != len(callee.Params) {
		return false
	}
	if cfgHasCycle(callee) {
		return false
	}
	instructions := 0
	for _, block := range callee.Blocks {
		instructions += len(block.Instructions)
		if instructions > maxInlineCFGInstructions {
			return false
		}
		for _, ins := range block.Instructions {
			if ins.Op == "call" {
				return false
			}
		}
		switch block.Terminator.Op {
		case "return", "jump", "branch":
		default:
			return false
		}
	}
	if callee.Result == Void {
		return call.Dest == -1
	}
	return call.Dest >= 0
}

func cfgHasCycle(f Function) bool {
	state := make([]uint8, len(f.Blocks))
	var visit func(int) bool
	visit = func(block int) bool {
		if state[block] == 1 {
			return true
		}
		if state[block] == 2 {
			return false
		}
		state[block] = 1
		for _, target := range f.Blocks[block].Terminator.Targets {
			if target >= 0 && target < len(f.Blocks) && visit(target) {
				return true
			}
		}
		state[block] = 2
		return false
	}
	for block := range f.Blocks {
		if state[block] == 0 && visit(block) {
			return true
		}
	}
	return false
}

func inlineCFGCall(caller *Function, callerBlock, callIndex int, callee Function, call Instruction) bool {
	if caller == nil || callerBlock < 0 || callerBlock >= len(caller.Blocks) || len(callee.Blocks) == 0 {
		return false
	}
	if len(caller.Blocks)+len(callee.Blocks)+1 > MaxBlocks {
		return false
	}
	neededSlots := len(callee.Slots)
	if len(caller.Slots)+neededSlots > MaxSlots {
		return false
	}
	original := caller.Blocks[callerBlock]
	if callIndex < 0 || callIndex >= len(original.Instructions) {
		return false
	}

	slotMap := make([]int, len(callee.Slots))
	for i := range slotMap {
		slotMap[i] = -1
	}
	newSlots := append([]Type(nil), caller.Slots...)
	prefix := append([]Instruction(nil), original.Instructions[:callIndex]...)
	for i := range callee.Params {
		if i >= len(call.Args) || i >= len(callee.Slots) {
			return false
		}
		local := len(newSlots)
		newSlots = append(newSlots, callee.Slots[i])
		slotMap[i] = local
		prefix = append(prefix, Instruction{
			Op:       "move",
			Dest:     local,
			Args:     []int{call.Args[i]},
			MayTrap:  false,
			Location: call.Location,
		})
	}
	for slot := len(callee.Params); slot < len(callee.Slots); slot++ {
		slotMap[slot] = len(newSlots)
		newSlots = append(newSlots, callee.Slots[slot])
	}
	mapSlot := func(slot int) (int, bool) {
		if slot < 0 || slot >= len(slotMap) || slotMap[slot] < 0 {
			return -1, false
		}
		return slotMap[slot], true
	}

	base := len(caller.Blocks)
	continuationIndex := base + len(callee.Blocks)
	cloned := make([]Block, len(callee.Blocks))
	for bi, sourceBlock := range callee.Blocks {
		cb := Block{Instructions: make([]Instruction, 0, len(sourceBlock.Instructions)+1)}
		for _, source := range sourceBlock.Instructions {
			clone, ok := cloneInlineInstruction(source, mapSlot)
			if !ok {
				return false
			}
			cb.Instructions = append(cb.Instructions, clone)
		}
		t := sourceBlock.Terminator
		switch t.Op {
		case "return":
			if callee.Result != Void {
				mapped, ok := mapSlot(t.Value)
				if !ok {
					return false
				}
				cb.Instructions = append(cb.Instructions, Instruction{
					Op:       "move",
					Dest:     call.Dest,
					Args:     []int{mapped},
					MayTrap:  false,
					Location: call.Location,
				})
			}
			cb.Terminator = Terminator{Op: "jump", Value: -1, Targets: []int{continuationIndex}, Location: call.Location}
		case "jump", "branch":
			value := t.Value
			if value >= 0 {
				mapped, ok := mapSlot(value)
				if !ok {
					return false
				}
				value = mapped
			}
			targets := make([]int, len(t.Targets))
			for i, target := range t.Targets {
				if target < 0 || target >= len(callee.Blocks) {
					return false
				}
				targets[i] = base + target
			}
			cb.Terminator = Terminator{Op: t.Op, Value: value, Targets: targets, Location: t.Location}
		default:
			return false
		}
		cloned[bi] = cb
	}

	continuation := Block{
		Instructions: append([]Instruction(nil), original.Instructions[callIndex+1:]...),
		Terminator: Terminator{
			Op:       original.Terminator.Op,
			Value:    original.Terminator.Value,
			Targets:  append([]int(nil), original.Terminator.Targets...),
			Location: original.Terminator.Location,
		},
	}
	caller.Blocks[callerBlock] = Block{
		Instructions: prefix,
		Terminator:   Terminator{Op: "jump", Value: -1, Targets: []int{base}, Location: call.Location},
	}
	caller.Slots = newSlots
	caller.Blocks = append(caller.Blocks, cloned...)
	caller.Blocks = append(caller.Blocks, continuation)
	return true
}

func cloneInlineInstruction(source Instruction, mapSlot func(int) (int, bool)) (Instruction, bool) {
	clone := Instruction{
		Op:       source.Op,
		Dest:     -1,
		Callee:   source.Callee,
		MayTrap:  source.MayTrap,
		Location: source.Location,
	}
	if source.Dest >= 0 {
		mapped, ok := mapSlot(source.Dest)
		if !ok {
			return Instruction{}, false
		}
		clone.Dest = mapped
	}
	if source.Constant != nil {
		literal := *source.Constant
		clone.Constant = &literal
	}
	clone.Args = make([]int, len(source.Args))
	for i, arg := range source.Args {
		mapped, ok := mapSlot(arg)
		if !ok {
			return Instruction{}, false
		}
		clone.Args[i] = mapped
	}
	return clone, true
}

func inlineSmallPureCallsRound(m *Module, report *OptimizationReport) bool {
	byName := make(map[string]Function, len(m.Functions))
	for _, f := range m.Functions {
		byName[f.Name] = f
	}
	changed := false
	budget := MaxInstructions - moduleInstructionUnits(*m)
	for fi := range m.Functions {
		caller := &m.Functions[fi]
		for bi := range caller.Blocks {
			block := &caller.Blocks[bi]
			if len(block.Instructions) == 0 {
				continue
			}
			out := make([]Instruction, 0, len(block.Instructions))
			for _, ins := range block.Instructions {
				if ins.Op != "call" {
					out = append(out, ins)
					continue
				}
				callee, ok := byName[ins.Callee]
				if !ok || !inlineEligible(*caller, callee, ins) {
					out = append(out, ins)
					continue
				}
				growth := inlineSingleBlockInstructionGrowth(callee)
				if growth > budget {
					out = append(out, ins)
					continue
				}
				inlined, ok := inlineCall(caller, callee, ins)
				if !ok {
					out = append(out, ins)
					continue
				}
				out = append(out, inlined...)
				budget -= growth
				report.InlinedCalls++
				changed = true
			}
			block.Instructions = out
		}
	}
	return changed
}

func moduleInstructionUnits(m Module) int {
	total := 0
	for _, f := range m.Functions {
		for _, block := range f.Blocks {
			total += len(block.Instructions) + 1
		}
	}
	return total
}

func inlineSingleBlockInstructionGrowth(callee Function) int {
	if len(callee.Blocks) != 1 {
		return MaxInstructions
	}
	growth := len(callee.Params) + len(callee.Blocks[0].Instructions) - 1
	if callee.Result != Void {
		growth++
	}
	return growth
}

func inlineCFGInstructionGrowth(callee Function) int {
	instructions := 0
	returns := 0
	for _, block := range callee.Blocks {
		instructions += len(block.Instructions)
		if block.Terminator.Op == "return" && callee.Result != Void {
			returns++
		}
	}
	// Replacing one call creates parameter moves, cloned instructions and
	// callee terminators plus one new jump from the split caller prefix. The
	// old caller terminator simply moves to the continuation block.
	return len(callee.Params) + instructions + len(callee.Blocks) + returns
}

func inlineEligible(caller, callee Function, call Instruction) bool {
	if caller.Name == callee.Name || callee.EffectVersion != 0 || len(callee.Effects) != 0 || len(callee.RequiredCapabilities) != 0 {
		return false
	}
	if len(callee.Blocks) != 1 || len(callee.Blocks[0].Instructions) > maxInlineInstructions {
		return false
	}
	if len(call.Args) != len(callee.Params) {
		return false
	}
	block := callee.Blocks[0]
	if block.Terminator.Op != "return" || len(block.Terminator.Targets) != 0 {
		return false
	}
	for _, ins := range block.Instructions {
		if ins.Op == "call" {
			return false
		}
	}
	if callee.Result == Void {
		return call.Dest == -1 && block.Terminator.Value == -1
	}
	return call.Dest >= 0 && block.Terminator.Value >= 0
}

func inlineCall(caller *Function, callee Function, call Instruction) ([]Instruction, bool) {
	if caller == nil || len(callee.Blocks) != 1 {
		return nil, false
	}
	slotMap := make([]int, len(callee.Slots))
	for i := range slotMap {
		slotMap[i] = -1
	}
	block := callee.Blocks[0]
	newSlots := append([]Type(nil), caller.Slots...)
	result := make([]Instruction, 0, len(block.Instructions)+len(callee.Params)+1)
	for i := range callee.Params {
		if i >= len(call.Args) || i >= len(callee.Slots) {
			return nil, false
		}
		local := len(newSlots)
		newSlots = append(newSlots, callee.Slots[i])
		slotMap[i] = local
		result = append(result, Instruction{
			Op:       "move",
			Dest:     local,
			Args:     []int{call.Args[i]},
			MayTrap:  false,
			Location: call.Location,
		})
	}
	for slot := len(callee.Params); slot < len(callee.Slots); slot++ {
		slotMap[slot] = len(newSlots)
		newSlots = append(newSlots, callee.Slots[slot])
	}
	mapSlot := func(slot int) (int, bool) {
		if slot < 0 || slot >= len(slotMap) || slotMap[slot] < 0 {
			return -1, false
		}
		return slotMap[slot], true
	}

	for _, source := range block.Instructions {
		clone := Instruction{
			Op:       source.Op,
			Dest:     -1,
			Callee:   source.Callee,
			MayTrap:  source.MayTrap,
			Location: source.Location,
		}
		if source.Dest >= 0 {
			mapped, ok := mapSlot(source.Dest)
			if !ok {
				return nil, false
			}
			clone.Dest = mapped
		}
		if source.Constant != nil {
			literal := *source.Constant
			clone.Constant = &literal
		}
		clone.Args = make([]int, len(source.Args))
		for i, arg := range source.Args {
			mapped, ok := mapSlot(arg)
			if !ok {
				return nil, false
			}
			clone.Args[i] = mapped
		}
		result = append(result, clone)
	}
	if callee.Result != Void {
		mappedReturn, ok := mapSlot(block.Terminator.Value)
		if !ok {
			return nil, false
		}
		result = append(result, Instruction{
			Op:       "move",
			Dest:     call.Dest,
			Args:     []int{mappedReturn},
			MayTrap:  false,
			Location: call.Location,
		})
	}
	caller.Slots = newSlots
	return result, true
}

func propagateCopies(f *Function, report *OptimizationReport) {
	for bi := range f.Blocks {
		aliases := make(map[int]int)
		resolve := func(slot int) int {
			seen := 0
			for {
				next, ok := aliases[slot]
				if !ok || next == slot || seen > len(f.Slots) {
					return slot
				}
				slot = next
				seen++
			}
		}
		invalidate := func(slot int) {
			delete(aliases, slot)
			for dest, source := range aliases {
				if source == slot {
					delete(aliases, dest)
				}
			}
		}
		block := &f.Blocks[bi]
		for ii := range block.Instructions {
			ins := &block.Instructions[ii]
			for ai, slot := range ins.Args {
				resolved := resolve(slot)
				if resolved != slot {
					ins.Args[ai] = resolved
					report.PropagatedCopies++
				}
			}
			if ins.Dest < 0 {
				continue
			}
			invalidate(ins.Dest)
			if ins.Op == "move" && len(ins.Args) == 1 {
				source := resolve(ins.Args[0])
				if source != ins.Dest {
					aliases[ins.Dest] = source
				}
			}
		}
		if block.Terminator.Value >= 0 {
			resolved := resolve(block.Terminator.Value)
			if resolved != block.Terminator.Value {
				block.Terminator.Value = resolved
				report.PropagatedCopies++
			}
		}
	}
}

func optimizeBlock(f *Function, b *Block, report *OptimizationReport) {
	known := make(map[int]Value)

	for i := range b.Instructions {
		ins := &b.Instructions[i]
		if ins.Dest >= 0 {
			delete(known, ins.Dest)
		}

		switch ins.Op {
		case "const":
			if ins.Constant != nil && ins.Dest >= 0 {
				if v, err := ParseValue(ins.Constant.Type, ins.Constant.Value); err == nil {
					known[ins.Dest] = v
				}
			}
			continue
		case "move":
			if len(ins.Args) == 1 {
				if v, ok := known[ins.Args[0]]; ok {
					rewriteConst(ins, v)
					known[ins.Dest] = v
					report.FoldedConstants++
				}
			}
			continue
		case "call":
			// Calls can trap and are intentionally not folded.
			continue
		}

		if len(ins.Args) > 0 {
			values := make([]Value, len(ins.Args))
			allKnown := true
			for ai, slot := range ins.Args {
				v, ok := known[slot]
				if !ok {
					allKnown = false
					break
				}
				values[ai] = v
			}
			if allKnown {
				if v, err := Apply(ins.Op, values...); err == nil {
					rewriteConst(ins, v)
					known[ins.Dest] = v
					report.FoldedConstants++
					continue
				}
				// A trapping constant operation must remain present so runtime
				// failure semantics are preserved.
			}
		}

		if simplifyI64Identity(f, ins, known) {
			report.SimplifiedOps++
			switch ins.Op {
			case "const":
				if v, err := ParseValue(ins.Constant.Type, ins.Constant.Value); err == nil {
					known[ins.Dest] = v
				}
			case "move":
				if v, ok := known[ins.Args[0]]; ok {
					known[ins.Dest] = v
				}
			}
		}
	}

	if b.Terminator.Op == "branch" {
		if v, ok := known[b.Terminator.Value]; ok {
			if cond, ok := v.Boolean(); ok {
				target := b.Terminator.Targets[1]
				if cond {
					target = b.Terminator.Targets[0]
				}
				b.Terminator = Terminator{
					Op:       "jump",
					Value:    -1,
					Targets:  []int{target},
					Location: b.Terminator.Location,
				}
				report.SimplifiedBranches++
			}
		}
	}
}

func rewriteConst(ins *Instruction, v Value) {
	lit := v.Literal()
	ins.Op = "const"
	ins.Args = nil
	ins.Constant = &lit
	ins.Callee = ""
	ins.MayTrap = false
}

func rewriteMove(ins *Instruction, slot int) {
	ins.Op = "move"
	ins.Args = []int{slot}
	ins.Constant = nil
	ins.Callee = ""
	ins.MayTrap = false
}

func simplifyI64Identity(f *Function, ins *Instruction, known map[int]Value) bool {
	if ins.Dest < 0 || f.Slots[ins.Dest] != I64 || len(ins.Args) != 2 {
		return false
	}

	left, leftKnown := known[ins.Args[0]]
	right, rightKnown := known[ins.Args[1]]
	li, _ := left.Int64()
	ri, _ := right.Int64()

	switch ins.Op {
	case "add":
		if leftKnown && li == 0 {
			rewriteMove(ins, ins.Args[1])
			return true
		}
		if rightKnown && ri == 0 {
			rewriteMove(ins, ins.Args[0])
			return true
		}
	case "sub":
		if rightKnown && ri == 0 {
			rewriteMove(ins, ins.Args[0])
			return true
		}
	case "mul":
		if leftKnown && li == 0 || rightKnown && ri == 0 {
			rewriteConst(ins, Int(0))
			return true
		}
		if leftKnown && li == 1 {
			rewriteMove(ins, ins.Args[1])
			return true
		}
		if rightKnown && ri == 1 {
			rewriteMove(ins, ins.Args[0])
			return true
		}
	case "div":
		if rightKnown && ri == 1 {
			rewriteMove(ins, ins.Args[0])
			return true
		}
	case "rem":
		if rightKnown && (ri == 1 || ri == -1) {
			rewriteConst(ins, Int(0))
			return true
		}
	}
	return false
}

func removeUnreachableBlocks(f *Function, report *OptimizationReport) {
	if len(f.Blocks) == 0 {
		return
	}
	reachable := make([]bool, len(f.Blocks))
	reachable[0] = true
	queue := []int{0}
	for len(queue) > 0 {
		bi := queue[0]
		queue = queue[1:]
		for _, target := range f.Blocks[bi].Terminator.Targets {
			if !reachable[target] {
				reachable[target] = true
				queue = append(queue, target)
			}
		}
	}

	reachableCount := countTrue(reachable)
	if reachableCount == len(f.Blocks) {
		return
	}

	remap := make([]int, len(f.Blocks))
	blocks := make([]Block, 0, reachableCount)
	for old, ok := range reachable {
		if !ok {
			remap[old] = -1
			report.RemovedBlocks++
			continue
		}
		remap[old] = len(blocks)
		blocks = append(blocks, f.Blocks[old])
	}
	for bi := range blocks {
		for ti, target := range blocks[bi].Terminator.Targets {
			mapped := remap[target]
			if mapped < 0 {
				panic("reachable block targets unreachable block")
			}
			blocks[bi].Terminator.Targets[ti] = mapped
		}
	}
	f.Blocks = blocks
}

func countTrue(values []bool) int {
	n := 0
	for _, v := range values {
		if v {
			n++
		}
	}
	return n
}

func removeDeadNoTrapInstructions(f *Function, report *OptimizationReport) {
	for {
		reads := make([]int, len(f.Slots))
		for _, b := range f.Blocks {
			for _, ins := range b.Instructions {
				for _, arg := range ins.Args {
					reads[arg]++
				}
			}
			if b.Terminator.Value >= 0 {
				reads[b.Terminator.Value]++
			}
		}

		removed := false
		for bi := range f.Blocks {
			src := f.Blocks[bi].Instructions
			dst := src[:0]
			for _, ins := range src {
				if ins.Dest >= 0 && reads[ins.Dest] == 0 && !ins.MayTrap && ins.Op != "call" {
					report.DeadInstructions++
					removed = true
					continue
				}
				dst = append(dst, ins)
			}
			f.Blocks[bi].Instructions = dst
		}
		if !removed {
			return
		}
	}
}
