package main

import (
	"fmt"
	"testing"
)

// Node represents a small heap-allocated node.
type Node struct {
	Value int
	Next  *Node
}

// Global sink to prevent compiler dead-code elimination.
var Sink any

// 1. Stack / Non-escaping candidate: value does not escape stack frame.
func runStackAllocation() {
	var n Node
	n.Value = 42
	if n.Value != 42 {
		panic("invalid")
	}
}

// 2. Escaping allocation: pointer escapes to heap.
//go:noinline
func escapeAlloc() *Node {
	n := &Node{Value: 42}
	return n
}

func runEscapingAllocation() {
	Sink = escapeAlloc()
}

var dynamicCounter int

// 3. Dynamic interface boxing: assigning a runtime value to interface causes heap escape.
//go:noinline
func boxVal(v any) {
	Sink = v
}

func runInterfaceBoxing() {
	dynamicCounter++
	boxVal(Node{Value: dynamicCounter})
}

// 4. Bounded reusable buffer / arena pattern: pre-allocated reuse amortizes to 0 allocs.
type SimpleArena struct {
	storage [16]Node
	idx     int
}

func (a *SimpleArena) Alloc(v int) *Node {
	if a.idx >= len(a.storage) {
		return &Node{Value: v} // overflow fallback
	}
	n := &a.storage[a.idx]
	a.idx++
	n.Value = v
	return n
}

func (a *SimpleArena) Reset() {
	a.idx = 0
}

var globalArena SimpleArena

func runArenaAllocation() {
	globalArena.Reset()
	n1 := globalArena.Alloc(1)
	n2 := globalArena.Alloc(2)
	n1.Next = n2
	if n1.Value+n2.Value != 3 {
		panic("invalid")
	}
}

// 5. Cyclic allocation: two nodes referencing each other (simulating cyclic graph topologies).
//go:noinline
func createCycle() *Node {
	a := &Node{Value: 1}
	b := &Node{Value: 2}
	a.Next = b
	b.Next = a
	return a
}

func runCyclicAllocation() {
	Sink = createCycle()
}

func main() {
	fmt.Println("=== Bounded Allocation & Escape Analysis Micro-Experiment ===")
	fmt.Println("DISCLAIMER: Toy results measured on Go runtime (escape analysis & GC).")
	fmt.Println("This does NOT represent Swyp Lang's native memory architecture.")
	fmt.Println()

	runs := 1000

	stackAllocs := testing.AllocsPerRun(runs, runStackAllocation)
	fmt.Printf("[1] Non-escaping stack value:        %6.2f allocs/run\n", stackAllocs)

	escapeAllocs := testing.AllocsPerRun(runs, runEscapingAllocation)
	fmt.Printf("[2] Escaping heap pointer:           %6.2f allocs/run\n", escapeAllocs)

	boxAllocs := testing.AllocsPerRun(runs, runInterfaceBoxing)
	fmt.Printf("[3] Interface boxing escape:         %6.2f allocs/run\n", boxAllocs)

	arenaAllocs := testing.AllocsPerRun(runs, runArenaAllocation)
	fmt.Printf("[4] Bounded arena/reuse buffer:      %6.2f allocs/run\n", arenaAllocs)

	cycleAllocs := testing.AllocsPerRun(runs, runCyclicAllocation)
	fmt.Printf("[5] Dynamic cyclic reference:        %6.2f allocs/run\n", cycleAllocs)

	fmt.Println("\nSummary of Toy Observations:")
	fmt.Println("- Stack variables with proven lexical lifetimes require 0 heap allocations.")
	fmt.Println("- Escape analysis forces heap allocation when values cross function/goroutine boundaries.")
	fmt.Println("- Interface boxing breaks static type size guarantees, forcing heap promotion.")
	fmt.Println("- Bounded static arena buffers eliminate per-object allocation overheads without GC.")
	fmt.Println("- Cyclic structures require dynamic resolution (or GC) when static ownership cannot be inverted.")
}
