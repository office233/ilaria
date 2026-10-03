# Swyp Ternary ISA v2 (STV2)

STV2 is an experimental deterministic instruction machine for Swyp. It is not an
LLM, neural network, or claim of native ternary hardware. The source assembly is
translated into base-3 instruction fields, packed five trits per byte, decoded,
validated, and executed by the Go VM.

## Why v2

STV1 established that a strict ternary bytecode can be assembled, packed,
decoded, fuzzed and executed deterministically. STV2 keeps STV1 unchanged and
adds a three-trit opcode field, exposing the full **27-opcode** space.

Each STV2 instruction uses 28 logical trits:

- opcode: 3 trits = 27 values
- register A: 2 trits
- register B: 2 trits
- immediate: 21 trits, biased signed int32

The packed transport stores five base-3 digits in one byte. Complete groups use
1.6 physical bits per trit on ordinary binary storage. The information content
of one trit is log2(3) ~= 1.585 bits; that is not a literal fractional hardware
bit.

## Registers and execution

There are eight signed int64 registers, r0 through r7. Execution is bounded by
the existing VM limits: at most 4,096 instructions and 1,000,000 fuel units.
Arithmetic is checked for signed int64 overflow. Division and remainder by zero
are errors. Falling off the program without halt is an error.

## Opcode table

| # | Assembly | Effect |
|---:|---|---|
| 0 | nop | no operation |
| 1 | const rA N | rA = signed int32 N |
| 2 | mov rA rB | rA = rB |
| 3 | add rA rB | checked rA += rB |
| 4 | sub rA rB | checked rA -= rB |
| 5 | mul rA rB | checked rA *= rB |
| 6 | div rA rB | checked signed division |
| 7 | mod rA rB | signed remainder |
| 8 | eq rA rB | rA = 1 when equal, else 0 |
| 9 | ne rA rB | rA = 1 when different, else 0 |
| 10 | lt rA rB | rA = 1 when rA < rB |
| 11 | le rA rB | rA = 1 when rA <= rB |
| 12 | gt rA rB | rA = 1 when rA > rB |
| 13 | ge rA rB | rA = 1 when rA >= rB |
| 14 | neg rA | checked negation |
| 15 | abs rA | checked absolute value |
| 16 | min rA rB | rA = min(rA,rB) |
| 17 | max rA rB | rA = max(rA,rB) |
| 18 | and rA rB | bitwise AND |
| 19 | or rA rB | bitwise OR |
| 20 | xor rA rB | bitwise XOR |
| 21 | not rA | bitwise NOT |
| 22 | jz rA target | jump when rA == 0 |
| 23 | jnz rA target | jump when rA != 0 |
| 24 | jmp target | unconditional jump |
| 25 | addi rA N | checked rA += signed int32 N |
| 26 | halt rA | return rA and machine state |

Jump targets may be numeric instruction indices or labels.

## Example

```text
const r1 0
const r2 1
loop:
jz r0 done
add r1 r0
sub r0 r2
jmp loop
done:
halt r1
```

Run it through the main CLI:

```powershell
go run ./cmd/swyp ternary examples/swyp/sum.ternary-v2.tasm 100
```

Expected value: 5050.

## Validation performed

The implementation includes deterministic tests for:

- labeled assembly
- all 27 opcode assignments
- canonical encode/decode round trips
- arithmetic and comparison behavior
- jz and jnz branches
- malformed source and invalid targets
- overflow and division/remainder by zero
- truncated bytecode, invalid packed digits and nonzero padding
- execution fuel exhaustion

The decoder also has a Go fuzz target. This validates implementation properties;
it does not prove the VM faster or more compact than every conventional ISA.

## Next milestone

The next useful step is not more opcodes. It is a lowering pass from checked Swyp
AST/IR into STV2 for a deliberately small integer subset. That will let the same
Swyp source target both the current interpreter/native backend and the ternary VM,
so behavior and representation can be compared directly.
