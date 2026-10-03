package coreir

import (
	"fmt"
	"sort"
)

// RegisterClass identifies the hardware register bank a Core slot requires.
type RegisterClass uint8

const (
	RegisterGPR RegisterClass = iota
	RegisterFP
)

// RegisterLocation is a backend-neutral allocation result. Exactly one of
// Register or Spill is non-negative.
type RegisterLocation struct {
	Class    RegisterClass
	Register int
	Spill    int
}

// RegisterPlan is a deterministic virtual-register assignment suitable for a
// direct native backend.
type RegisterPlan struct {
	Locations []RegisterLocation
	GPRUsed   int
	FPUsed    int
	Spills    int
}

// InterferenceGraph returns the slot interference graph for a function.
// Adjacent slots of the same register class cannot share a physical register.
func InterferenceGraph(f Function) ([][]bool, error) {
	live, err := AnalyzeLiveness(f)
	if err != nil {
		return nil, err
	}
	n := len(f.Slots)
	graph := make([][]bool, n)
	for i := range graph {
		graph[i] = make([]bool, n)
	}
	addEdge := func(a, b int) {
		if a < 0 || b < 0 || a == b {
			return
		}
		graph[a][b] = true
		graph[b][a] = true
	}
	addLiveClique := func(liveSet []bool) {
		for a := 0; a < len(liveSet); a++ {
			if !liveSet[a] {
				continue
			}
			for b := a + 1; b < len(liveSet); b++ {
				if liveSet[b] && sameRegisterClass(f.Slots[a], f.Slots[b]) {
					addEdge(a, b)
				}
			}
		}
	}

	for bi, block := range f.Blocks {
		current := append([]bool(nil), live.Blocks[bi].LiveOut...)
		addLiveClique(current)
		if slot := block.Terminator.Value; slot >= 0 {
			current[slot] = true
			addLiveClique(current)
		}
		for ii := len(block.Instructions) - 1; ii >= 0; ii-- {
			ins := block.Instructions[ii]
			if ins.Dest >= 0 {
				for slot, isLive := range current {
					if isLive && sameRegisterClass(f.Slots[ins.Dest], f.Slots[slot]) {
						addEdge(ins.Dest, slot)
					}
				}
				current[ins.Dest] = false
			}
			for _, slot := range ins.Args {
				current[slot] = true
			}
			addLiveClique(current)
		}
		addLiveClique(live.Blocks[bi].LiveIn)
		if bi == 0 {
			entryLive := make([]bool, n)
			for s, isLive := range current {
				if isLive {
					entryLive[s] = true
				}
			}
			for s, isLive := range live.Blocks[0].LiveIn {
				if isLive {
					entryLive[s] = true
				}
			}
			numParams := len(f.Params)
			for a := 0; a < numParams; a++ {
				for b := a + 1; b < numParams; b++ {
					if sameRegisterClass(f.Slots[a], f.Slots[b]) {
						addEdge(a, b)
					}
				}
				for s, isLive := range entryLive {
					if isLive && sameRegisterClass(f.Slots[a], f.Slots[s]) {
						addEdge(a, s)
					}
				}
			}
		}
	}
	return graph, nil
}

// AllocateRegisters greedily colors the interference graph with separate GPR
// and floating-point banks. The output is deterministic for a given function.
//
// This is intentionally a backend-neutral first allocator. Future direct
// backends may add ABI pre-coloring and rematerialization without changing the
// liveness/interference contract.
func AllocateRegisters(f Function, gprCount, fpCount int) (RegisterPlan, error) {
	if gprCount < 0 || fpCount < 0 {
		return RegisterPlan{}, fmt.Errorf("register counts must be non-negative")
	}
	graph, err := InterferenceGraph(f)
	if err != nil {
		return RegisterPlan{}, err
	}
	plan := RegisterPlan{Locations: make([]RegisterLocation, len(f.Slots))}
	for i, t := range f.Slots {
		plan.Locations[i] = RegisterLocation{Class: registerClass(t), Register: -1, Spill: -1}
	}

	order := make([]int, len(f.Slots))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := order[i], order[j]
		ad, bd := 0, 0
		for slot := range graph[a] {
			if graph[a][slot] && sameRegisterClass(f.Slots[a], f.Slots[slot]) {
				ad++
			}
			if graph[b][slot] && sameRegisterClass(f.Slots[b], f.Slots[slot]) {
				bd++
			}
		}
		if ad != bd {
			return ad > bd
		}
		return a < b
	})

	gprSpills, fpSpills := 0, 0
	for _, slot := range order {
		class := plan.Locations[slot].Class
		limit := gprCount
		if class == RegisterFP {
			limit = fpCount
		}
		used := make([]bool, limit)
		for neighbor, interferes := range graph[slot] {
			if !interferes || plan.Locations[neighbor].Class != class {
				continue
			}
			reg := plan.Locations[neighbor].Register
			if reg >= 0 && reg < len(used) {
				used[reg] = true
			}
		}
		assigned := -1
		for reg, busy := range used {
			if !busy {
				assigned = reg
				break
			}
		}
		if assigned >= 0 {
			plan.Locations[slot].Register = assigned
			if class == RegisterGPR && assigned+1 > plan.GPRUsed {
				plan.GPRUsed = assigned + 1
			}
			if class == RegisterFP && assigned+1 > plan.FPUsed {
				plan.FPUsed = assigned + 1
			}
			continue
		}
		if class == RegisterGPR {
			plan.Locations[slot].Spill = gprSpills
			gprSpills++
		} else {
			plan.Locations[slot].Spill = fpSpills
			fpSpills++
		}
		plan.Spills++
	}
	return plan, nil
}

func registerClass(t Type) RegisterClass {
	switch t {
	case F64, IEEE64:
		return RegisterFP
	default:
		return RegisterGPR
	}
}

func sameRegisterClass(a, b Type) bool {
	return registerClass(a) == registerClass(b)
}
