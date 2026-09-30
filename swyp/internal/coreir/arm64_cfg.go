package coreir

import (
	"bytes"
	"fmt"
)

// ARM64CFGABI is the CFG-aware AAPCS64 assembly ABI.
const ARM64CFGABI = "swyp-arm64-cfg-aapcs64-v1"

// EmitARM64SSA emits direct AAPCS64 assembly for scalar SSA with multiple
// blocks, phi nodes, GPR spills and bounded native calls.
//
// Phi assignments are lowered on predecessor edges using balanced stack copies.
// Saving all sources before writing any destination preserves parallel-copy
// semantics, including register cycles. GPR and FP spills share an x29-relative
// frame with non-overlapping regions.
func EmitARM64SSA(f SSAFunction, plan SSARegisterPlan) ([]byte, error) {
	if len(plan.Locations) != len(f.ValueTypes) {
		return nil, fmt.Errorf("arm64 cfg: register plan/value count mismatch")
	}
	gprParams, fpParams := arm64ParamCounts(f)
	if gprParams >= len(arm64ArgRegisters) || fpParams > len(arm64FPArgRegisters) {
		return nil, fmt.Errorf("arm64 cfg: parameter registers exceeded")
	}

	reachable := 0
	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		reachable++
		for _, phi := range block.Phis {
			if phi.Dest < 0 || int(phi.Dest) >= len(f.ValueTypes) {
				return nil, fmt.Errorf("arm64 cfg: block %d invalid phi destination %d", bi, phi.Dest)
			}
		}
	}
	if reachable == 0 {
		return nil, fmt.Errorf("arm64 cfg: no reachable blocks")
	}

	for value, t := range f.ValueTypes {
		if t == F64 {
			return nil, fmt.Errorf("arm64 cfg: strict f64 is not supported by direct backend yet; use ieee64 or Core AOT")
		}
		loc := plan.Locations[value]
		limit := len(arm64LeafRegisters)
		if registerClass(t) == RegisterFP {
			limit = len(arm64FPRegisters)
		}
		if loc.Spill >= 0 {
			continue
		}
		if loc.Register < 0 || loc.Register >= limit {
			return nil, fmt.Errorf("arm64 cfg: invalid allocation, value %d location=%+v", value, loc)
		}
	}

	used := make([]bool, len(arm64LeafRegisters))
	usedFP := make([]bool, len(arm64FPRegisters))
	for value, loc := range plan.Locations {
		if loc.Register >= 0 {
			if registerClass(f.ValueTypes[value]) == RegisterFP {
				usedFP[loc.Register] = true
			} else {
				used[loc.Register] = true
			}
		}
	}

	var b bytes.Buffer
	b.WriteString(".text\n")
	fmt.Fprintf(&b, ".global %s\n%s:\n", ARM64LeafSymbol(f.Name), ARM64LeafSymbol(f.Name))

	// x16/x17 are scratch registers under AAPCS64 and are not assigned by the
	// Swyp register allocator. The incoming status pointer is copied into the
	// frame because x16 is caller-saved and native calls may clobber it.
	fmt.Fprintf(&b, "    mov x16, %s\n", arm64ArgRegisters[gprParams])
	b.WriteString("    str x29, [sp, #-16]!\n")

	for reg, active := range used {
		if active {
			fmt.Fprintf(&b, "    str %s, [sp, #-16]!\n", arm64LeafRegisters[reg])
		}
	}
	for reg, active := range usedFP {
		if active {
			fmt.Fprintf(&b, "    str %s, [sp, #-16]!\n", arm64FPRegisters[reg])
		}
	}
	gprSpillBytes := arm64GPRSpillBytes(f, plan)
	fpSpillBytes := arm64FPSpillBytes(f, plan)
	statusOffset := gprSpillBytes + fpSpillBytes
	frameBytes := (statusOffset + 8 + 15) &^ 15
	fmt.Fprintf(&b, "    sub sp, sp, #%d\n", frameBytes)
	b.WriteString("    mov x29, sp\n")
	fmt.Fprintf(&b, "    str x16, [x29, #%d]\n", statusOffset)
	gprIndex, fpIndex := 0, 0
	for _, value := range f.Params {
		if registerClass(f.ValueTypes[value]) == RegisterFP {
			src := arm64FPArgRegisters[fpIndex]
			fpIndex++
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				fmt.Fprintf(&b, "    str %s, %s\n", src, arm64FPSpillOperand(f, plan, loc.Spill))
			} else {
				dst := arm64FPReg(plan, value)
				if dst != src {
					fmt.Fprintf(&b, "    fmov %s, %s\n", dst, src)
				}
			}
		} else {
			src := arm64ArgRegisters[gprIndex]
			gprIndex++
			loc := plan.Locations[value]
			if loc.Spill >= 0 {
				fmt.Fprintf(&b, "    str %s, %s\n", src, arm64SpillOperand(loc.Spill))
			} else {
				dst := arm64Reg(plan, value)
				if dst != src {
					fmt.Fprintf(&b, "    mov %s, %s\n", dst, src)
				}
			}
		}
	}
	b.WriteString("    b .Lswyp_arm64_b0\n")

	for bi, block := range f.Blocks {
		if !block.Reachable {
			continue
		}
		fmt.Fprintf(&b, ".Lswyp_arm64_b%d:\n", bi)

		for _, ins := range block.Instructions {
			if err := emitARM64LeafInstruction(&b, f, plan, ins); err != nil {
				return nil, fmt.Errorf("arm64 cfg block %d: %w", bi, err)
			}
		}

		switch block.Terminator.Op {
		case "return":
			if block.Terminator.Value >= 0 {
				if registerClass(f.ValueTypes[block.Terminator.Value]) == RegisterFP {
					loc := plan.Locations[block.Terminator.Value]
					if loc.Spill >= 0 {
						fmt.Fprintf(&b, "    ldr d0, %s\n", arm64FPSpillOperand(f, plan, loc.Spill))
					} else {
						result := arm64FPReg(plan, block.Terminator.Value)
						if result != "d0" {
							fmt.Fprintf(&b, "    fmov d0, %s\n", result)
						}
					}
				} else {
					loc := plan.Locations[block.Terminator.Value]
					if loc.Spill >= 0 {
						fmt.Fprintf(&b, "    ldr x0, %s\n", arm64SpillOperand(loc.Spill))
					} else {
						result := arm64Reg(plan, block.Terminator.Value)
						if result != "x0" {
							fmt.Fprintf(&b, "    mov x0, %s\n", result)
						}
					}
				}
			} else {
				b.WriteString("    mov x0, #0\n")
			}
			b.WriteString("    mov x17, #0\n")
			fmt.Fprintf(&b, "    ldr x16, [x29, #%d]\n", statusOffset)
			b.WriteString("    str x17, [x16]\n")
			b.WriteString("    b .Lswyp_arm64_epilogue\n")

		case "jump":
			if len(block.Terminator.Targets) != 1 {
				return nil, fmt.Errorf("arm64 cfg: block %d jump target count %d", bi, len(block.Terminator.Targets))
			}
			target := block.Terminator.Targets[0]
			if err := emitARM64PhiEdgeCopies(&b, f, plan, bi, target); err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "    b .Lswyp_arm64_b%d\n", target)

		case "branch":
			if len(block.Terminator.Targets) != 2 || block.Terminator.Value < 0 {
				return nil, fmt.Errorf("arm64 cfg: invalid branch in block %d", bi)
			}
			falseEdge := fmt.Sprintf(".Lswyp_arm64_edge_b%d_false", bi)
			condLoc := plan.Locations[block.Terminator.Value]
			if condLoc.Spill >= 0 {
				fmt.Fprintf(&b, "    ldr x9, %s\n", arm64SpillOperand(condLoc.Spill))
				fmt.Fprintf(&b, "    cbz x9, %s\n", falseEdge)
			} else {
				fmt.Fprintf(&b, "    cbz %s, %s\n", arm64Reg(plan, block.Terminator.Value), falseEdge)
			}

			if err := emitARM64PhiEdgeCopies(&b, f, plan, bi, block.Terminator.Targets[0]); err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "    b .Lswyp_arm64_b%d\n", block.Terminator.Targets[0])

			fmt.Fprintf(&b, "%s:\n", falseEdge)
			if err := emitARM64PhiEdgeCopies(&b, f, plan, bi, block.Terminator.Targets[1]); err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "    b .Lswyp_arm64_b%d\n", block.Terminator.Targets[1])

		default:
			return nil, fmt.Errorf("arm64 cfg: unsupported terminator %q in block %d", block.Terminator.Op, bi)
		}
	}

	b.WriteString(".Lswyp_arm64_overflow:\n")
	b.WriteString("    mov x0, #0\n")
	b.WriteString("    fmov d0, xzr\n")
	b.WriteString("    mov x17, #1\n")
	fmt.Fprintf(&b, "    ldr x16, [x29, #%d]\n", statusOffset)
	b.WriteString("    str x17, [x16]\n")
	b.WriteString(".Lswyp_arm64_epilogue:\n")
	b.WriteString("    mov sp, x29\n")
	fmt.Fprintf(&b, "    add sp, sp, #%d\n", frameBytes)
	for reg := len(usedFP) - 1; reg >= 0; reg-- {
		if usedFP[reg] {
			fmt.Fprintf(&b, "    ldr %s, [sp], #16\n", arm64FPRegisters[reg])
		}
	}

	for reg := len(used) - 1; reg >= 0; reg-- {
		if used[reg] {
			fmt.Fprintf(&b, "    ldr %s, [sp], #16\n", arm64LeafRegisters[reg])
		}
	}
	b.WriteString("    ldr x29, [sp], #16\n")
	b.WriteString("    ret\n")

	return b.Bytes(), nil
}

// EmitARM64SSAModule emits all supplied CFG functions into one AArch64
// assembly unit. Local labels are namespaced per function before concatenation
// so multiple CFGs can coexist safely.
func EmitARM64SSAModule(functions []SSAFunction, plans map[string]SSARegisterPlan) ([]byte, error) {
	if len(functions) == 0 {
		return nil, fmt.Errorf("arm64 module: no functions")
	}
	seen := make(map[string]bool, len(functions))
	var out bytes.Buffer
	for _, f := range functions {
		if f.Name == "" || seen[f.Name] {
			return nil, fmt.Errorf("arm64 module: duplicate/empty function %q", f.Name)
		}
		seen[f.Name] = true
		plan, ok := plans[f.Name]
		if !ok {
			return nil, fmt.Errorf("arm64 module: missing register plan for %s", f.Name)
		}
		asm, err := EmitARM64SSA(f, plan)
		if err != nil {
			return nil, fmt.Errorf("arm64 module %s: %w", f.Name, err)
		}
		prefix := []byte(".Lswyp_arm64_" + sanitizeARM64Symbol(f.Name) + "_")
		asm = bytes.ReplaceAll(asm, []byte(".Lswyp_arm64_"), prefix)
		out.Write(asm)
		out.WriteByte('\n')
	}
	return out.Bytes(), nil
}

func emitARM64PhiEdgeCopies(b *bytes.Buffer, f SSAFunction, plan SSARegisterPlan, predecessor, target int) error {
	if target < 0 || target >= len(f.Blocks) || !f.Blocks[target].Reachable {
		return fmt.Errorf("arm64 cfg: invalid edge %d -> %d", predecessor, target)
	}

	type move struct {
		dst   RegisterLocation
		src   RegisterLocation
		class RegisterClass
	}
	moves := make([]move, 0, len(f.Blocks[target].Phis))

	for _, phi := range f.Blocks[target].Phis {
		input := NoSSAValue
		for _, candidate := range phi.Inputs {
			if candidate.Predecessor == predecessor {
				input = candidate.Value
				break
			}
		}
		if input == NoSSAValue {
			return fmt.Errorf("arm64 cfg: phi %d in block %d has no input from predecessor %d", phi.Dest, target, predecessor)
		}

		class := registerClass(f.ValueTypes[phi.Dest])
		if class != registerClass(f.ValueTypes[input]) {
			return fmt.Errorf("arm64 cfg: phi %d class mismatch on edge %d -> %d", phi.Dest, predecessor, target)
		}
		dst := plan.Locations[phi.Dest]
		src := plan.Locations[input]
		if dst != src {
			moves = append(moves, move{dst: dst, src: src, class: class})
		}
	}

	for _, m := range moves {
		if m.class == RegisterFP {
			if m.src.Spill >= 0 {
				fmt.Fprintf(b, "    ldr d6, %s\n", arm64FPSpillOperand(f, plan, m.src.Spill))
				b.WriteString("    str d6, [sp, #-16]!\n")
			} else {
				fmt.Fprintf(b, "    str %s, [sp, #-16]!\n", arm64FPRegisters[m.src.Register])
			}
		} else if m.src.Spill >= 0 {
			fmt.Fprintf(b, "    ldr x9, %s\n", arm64SpillOperand(m.src.Spill))
			b.WriteString("    str x9, [sp, #-16]!\n")
		} else {
			fmt.Fprintf(b, "    str %s, [sp, #-16]!\n", arm64LeafRegisters[m.src.Register])
		}
	}
	for i := len(moves) - 1; i >= 0; i-- {
		if moves[i].class == RegisterFP {
			if moves[i].dst.Spill >= 0 {
				b.WriteString("    ldr d6, [sp], #16\n")
				fmt.Fprintf(b, "    str d6, %s\n", arm64FPSpillOperand(f, plan, moves[i].dst.Spill))
			} else {
				fmt.Fprintf(b, "    ldr %s, [sp], #16\n", arm64FPRegisters[moves[i].dst.Register])
			}
		} else if moves[i].dst.Spill >= 0 {
			b.WriteString("    ldr x9, [sp], #16\n")
			fmt.Fprintf(b, "    str x9, %s\n", arm64SpillOperand(moves[i].dst.Spill))
		} else {
			fmt.Fprintf(b, "    ldr %s, [sp], #16\n", arm64LeafRegisters[moves[i].dst.Register])
		}
	}
	return nil
}

func arm64GPRSpillBytes(f SSAFunction, plan SSARegisterPlan) int {
	maxSpill := -1
	for value, loc := range plan.Locations {
		if registerClass(f.ValueTypes[value]) != RegisterGPR || loc.Spill < 0 {
			continue
		}
		if loc.Spill > maxSpill {
			maxSpill = loc.Spill
		}
	}
	if maxSpill < 0 {
		return 0
	}
	bytes := (maxSpill + 1) * 8
	return (bytes + 15) &^ 15
}

func arm64FPSpillBytes(f SSAFunction, plan SSARegisterPlan) int {
	maxSpill := -1
	for value, loc := range plan.Locations {
		if registerClass(f.ValueTypes[value]) != RegisterFP || loc.Spill < 0 {
			continue
		}
		if loc.Spill > maxSpill {
			maxSpill = loc.Spill
		}
	}
	if maxSpill < 0 {
		return 0
	}
	return (maxSpill + 1) * 8
}

func arm64SpillOperand(spill int) string {
	return fmt.Sprintf("[x29, #%d]", spill*8)
}

func arm64FPSpillOperand(f SSAFunction, plan SSARegisterPlan, spill int) string {
	offset := arm64GPRSpillBytes(f, plan) + spill*8
	return fmt.Sprintf("[x29, #%d]", offset)
}
