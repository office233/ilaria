package coreir

import (
	"fmt"
	"sort"
)

type SSABlockLiveness struct {
	LiveIn  []bool
	LiveOut []bool
}

type SSALiveness struct {
	Blocks []SSABlockLiveness
}

// AnalyzeSSALiveness computes phi-aware liveness. Phi inputs are uses on the
// incoming predecessor edge, while phi destinations are definitions at block
// entry.
func AnalyzeSSALiveness(f SSAFunction) (SSALiveness, error) {
	nValues := len(f.ValueTypes)
	if len(f.Blocks) == 0 {
		return SSALiveness{}, fmt.Errorf("ssa liveness: no blocks")
	}
	use := make([][]bool, len(f.Blocks))
	def := make([][]bool, len(f.Blocks))
	succ := make([][]int, len(f.Blocks))
	phiDefs := make([][]bool, len(f.Blocks))
	phiEdgeUses := make([]map[int][]SSAValue, len(f.Blocks))

	for bi, block := range f.Blocks {
		use[bi] = make([]bool, nValues)
		def[bi] = make([]bool, nValues)
		phiDefs[bi] = make([]bool, nValues)
		phiEdgeUses[bi] = map[int][]SSAValue{}
		if !block.Reachable {
			continue
		}
		for _, phi := range block.Phis {
			if phi.Dest < 0 || int(phi.Dest) >= nValues {
				return SSALiveness{}, fmt.Errorf("ssa liveness: block %d invalid phi dest %d", bi, phi.Dest)
			}
			def[bi][phi.Dest] = true
			phiDefs[bi][phi.Dest] = true
			for _, input := range phi.Inputs {
				if input.Value < 0 || int(input.Value) >= nValues {
					return SSALiveness{}, fmt.Errorf("ssa liveness: block %d invalid phi input %d", bi, input.Value)
				}
				phiEdgeUses[bi][input.Predecessor] = append(phiEdgeUses[bi][input.Predecessor], input.Value)
			}
		}
		for ii, ins := range block.Instructions {
			for _, value := range ins.Args {
				if value < 0 || int(value) >= nValues {
					return SSALiveness{}, fmt.Errorf("ssa liveness: block %d instruction %d invalid arg %d", bi, ii, value)
				}
				if !def[bi][value] {
					use[bi][value] = true
				}
			}
			if ins.Dest >= 0 {
				if int(ins.Dest) >= nValues {
					return SSALiveness{}, fmt.Errorf("ssa liveness: block %d instruction %d invalid dest %d", bi, ii, ins.Dest)
				}
				def[bi][ins.Dest] = true
			}
		}
		if block.Terminator.Value >= 0 {
			value := block.Terminator.Value
			if int(value) >= nValues {
				return SSALiveness{}, fmt.Errorf("ssa liveness: block %d invalid terminator value %d", bi, value)
			}
			if !def[bi][value] {
				use[bi][value] = true
			}
		}
		for _, target := range block.Terminator.Targets {
			if target < 0 || target >= len(f.Blocks) {
				return SSALiveness{}, fmt.Errorf("ssa liveness: block %d target %d out of range", bi, target)
			}
			succ[bi] = append(succ[bi], target)
		}
	}

	result := SSALiveness{Blocks: make([]SSABlockLiveness, len(f.Blocks))}
	for bi := range result.Blocks {
		result.Blocks[bi].LiveIn = make([]bool, nValues)
		result.Blocks[bi].LiveOut = make([]bool, nValues)
	}
	for changed := true; changed; {
		changed = false
		for bi := len(f.Blocks) - 1; bi >= 0; bi-- {
			if !f.Blocks[bi].Reachable {
				continue
			}
			newOut := make([]bool, nValues)
			for _, target := range succ[bi] {
				for value, live := range result.Blocks[target].LiveIn {
					if live && !phiDefs[target][value] {
						newOut[value] = true
					}
				}
				for _, value := range phiEdgeUses[target][bi] {
					newOut[value] = true
				}
			}
			newIn := make([]bool, nValues)
			for value := 0; value < nValues; value++ {
				newIn[value] = use[bi][value] || (newOut[value] && !def[bi][value])
			}
			if !sameBools(newOut, result.Blocks[bi].LiveOut) || !sameBools(newIn, result.Blocks[bi].LiveIn) {
				result.Blocks[bi].LiveOut = newOut
				result.Blocks[bi].LiveIn = newIn
				changed = true
			}
		}
	}
	return result, nil
}

func SSAInterferenceGraph(f SSAFunction) ([][]bool, error) {
	adjacency, err := ssaInterferenceAdjacency(f)
	if err != nil {
		return nil, err
	}
	n := len(f.ValueTypes)
	graph := make([][]bool, n)
	for i := range graph {
		graph[i] = make([]bool, n)
		for _, neighbor := range adjacency[i] {
			graph[i][neighbor] = true
		}
	}
	return graph, nil
}

// ssaInterferenceAdjacency is the allocator-facing interference
// representation. It avoids the O(N²) bool matrix previously allocated for
// every function; large sparse SSA functions now scale with actual live
// interference edges instead of the square of the value count.
func ssaInterferenceAdjacency(f SSAFunction) ([][]int, error) {
	live, err := AnalyzeSSALiveness(f)
	if err != nil {
		return nil, err
	}
	n := len(f.ValueTypes)
	edges := make(map[uint64]struct{})
	addEdge := func(a, b SSAValue) {
		if a < 0 || b < 0 || a == b {
			return
		}
		if registerClass(f.ValueTypes[a]) != registerClass(f.ValueTypes[b]) {
			return
		}
		x, y := int(a), int(b)
		if x > y {
			x, y = y, x
		}
		key := uint64(uint32(x))<<32 | uint64(uint32(y))
		edges[key] = struct{}{}
	}
	addClique := func(values []bool) {
		for a := 0; a < len(values); a++ {
			if !values[a] {
				continue
			}
			for b := a + 1; b < len(values); b++ {
				if values[b] {
					addEdge(SSAValue(a), SSAValue(b))
				}
			}
		}
	}

	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		current := append([]bool(nil), live.Blocks[bi].LiveOut...)
		addClique(current)
		if block.Terminator.Value >= 0 {
			current[block.Terminator.Value] = true
			addClique(current)
		}
		for ii := len(block.Instructions) - 1; ii >= 0; ii-- {
			ins := block.Instructions[ii]
			if ins.Dest >= 0 {
				for value, isLive := range current {
					if isLive {
						addEdge(ins.Dest, SSAValue(value))
					}
				}
				current[ins.Dest] = false
			}
			for _, value := range ins.Args {
				current[value] = true
			}
			addClique(current)
		}
		for pi := len(block.Phis) - 1; pi >= 0; pi-- {
			phi := block.Phis[pi]
			for value, isLive := range current {
				if isLive {
					addEdge(phi.Dest, SSAValue(value))
				}
			}
			current[phi.Dest] = false
		}
		addClique(live.Blocks[bi].LiveIn)
	}
	degree := make([]int, n)
	for key := range edges {
		a, b := int(uint32(key>>32)), int(uint32(key))
		degree[a]++
		degree[b]++
	}
	graph := make([][]int, n)
	for value, count := range degree {
		if count > 0 {
			graph[value] = make([]int, 0, count)
		}
	}
	for key := range edges {
		a, b := int(uint32(key>>32)), int(uint32(key))
		graph[a] = append(graph[a], b)
		graph[b] = append(graph[b], a)
	}
	for value := range graph {
		sort.Ints(graph[value])
	}
	return graph, nil
}

type SSARegisterPlan struct {
	Locations []RegisterLocation
	GPRUsed   int
	FPUsed    int
	Spills    int
}

func AllocateSSARegisters(f SSAFunction, gprCount, fpCount int) (SSARegisterPlan, error) {
	if gprCount < 0 || fpCount < 0 {
		return SSARegisterPlan{}, fmt.Errorf("register counts must be non-negative")
	}
	graph, err := ssaInterferenceAdjacency(f)
	if err != nil {
		return SSARegisterPlan{}, err
	}
	plan := SSARegisterPlan{Locations: make([]RegisterLocation, len(f.ValueTypes))}
	for i, t := range f.ValueTypes {
		plan.Locations[i] = RegisterLocation{Class: registerClass(t), Register: -1, Spill: -1}
	}
	order := make([]int, len(f.ValueTypes))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := order[i], order[j]
		ad, bd := len(graph[a]), len(graph[b])
		if ad != bd {
			return ad > bd
		}
		return a < b
	})

	gprSpill, fpSpill := 0, 0
	for _, value := range order {
		class := plan.Locations[value].Class
		limit := gprCount
		if class == RegisterFP {
			limit = fpCount
		}
		used := make([]bool, limit)
		for _, neighbor := range graph[value] {
			if plan.Locations[neighbor].Class != class {
				continue
			}
			if reg := plan.Locations[neighbor].Register; reg >= 0 && reg < len(used) {
				used[reg] = true
			}
		}
		reg := -1
		for candidate, busy := range used {
			if !busy {
				reg = candidate
				break
			}
		}
		if reg >= 0 {
			plan.Locations[value].Register = reg
			if class == RegisterGPR && reg+1 > plan.GPRUsed {
				plan.GPRUsed = reg + 1
			}
			if class == RegisterFP && reg+1 > plan.FPUsed {
				plan.FPUsed = reg + 1
			}
			continue
		}
		if class == RegisterGPR {
			plan.Locations[value].Spill = gprSpill
			gprSpill++
		} else {
			plan.Locations[value].Spill = fpSpill
			fpSpill++
		}
		plan.Spills++
	}
	return plan, nil
}
