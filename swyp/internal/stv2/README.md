# Swyp experimental ternary instruction machine (STV1)

This is an assembler, packed ternary bytecode format, decoder, and deterministic
software VM. It is separate from the ternary-weight matrix experiment and the
main Swyp compiler. No LLM, weights training, self-modification or native ternary
CPU is involved. Decoded instructions execute through Go on the host CPU.

## ISA

Eight signed int64 registers r0..r7; zero-based instruction pointer. Registers
start at zero unless supplied by the host. Each instruction consumes one fuel
unit. Execution is limited to 1,000,000 units and 4,096 instructions. Overflow,
falling off the end, invalid programs and exhausted fuel return errors. Only halt
returns a successful result. No files, network, allocation instructions or host
calls are available to programs.

| Opcode | Assembly | Exact effect |
|---:|---|---|
| 0 | `nop` | Advance instruction pointer |
| 1 | `const rA N` | Assign signed int32 immediate N to rA |
| 2 | `mov rA rB` | rA = rB |
| 3 | `add rA rB` | rA = rA + rB, checked int64 |
| 4 | `sub rA rB` | rA = rA - rB, checked int64 |
| 5 | `eq rA rB` | rA = 1 if equal, otherwise 0 |
| 6 | `jz rA N` | Jump to instruction N if rA is zero |
| 7 | `jmp N` | Unconditional jump to N |
| 8 | `halt rA` | Return rA and machine state |

Jump targets count instructions, not comments or source lines. The assembler
requires exact operand counts, r0..r7 names and decimal integer literals.
Unused fields must be zero for a canonical representation. `eq` overwrites its
first operand; use `mov` first when the original value must be retained.

An if/else returning 42 when r0 equals r1, otherwise -7:

```text
eq r0 r1
jz r0 4
const r2 42
halt r2
const r2 -7
halt r2
```

## Encoding

Header: ASCII STV1 followed by a little-endian uint32 instruction count.
Each instruction has 27 base-3 digits: opcode (2), register A (2), register B (2),
and immediate (21). Values are stored least-significant digit first. The
immediate is biased by 2^31; decoded values beyond uint32 are rejected.

Logical symbols -1, 0, +1 correspond to storage digits 0, 1, 2. These symbols have
no standalone control meaning: their positions and the ISA determine meaning.
Five digits pack into one byte, yielding 1.6 bits per trit for complete groups.
Bytes 243..255, nonzero trailing padding, trailing bytes, unsupported registers,
invalid jumps and unknown opcodes are rejected. No 16-bit hardware assumption
is required. No claim is made that this format is smaller than conventional
bytecode or that interpreting it is faster.

## Run and reproduce

From D:\nexus\swyp:

```powershell
go run ./experiments/ternaryvm/cmd examples/swyp/sum.ternary.tasm 100
go test ./experiments/ternaryvm/... -count=1
go test ./experiments/ternaryvm -run '^$' -fuzz FuzzDecode -fuzztime 5s -parallel 2
```

Observed demo: `value=5050 steps=404 instructions=7 packed_bytes=46`.
The command assembles, packs, decodes, validates and runs the program. The 46
bytes include the 8-byte header. Packing is a transport format; execution uses
decoded Go instruction structs and consequently additional memory.

Tests check sums for n=0..1000 against n*(n+1)/2, both conditional branches,
canonical encode/decode round trips, integer boundaries, malformed source,
truncation, invalid packed bytes, unused fields, padding, invalid targets,
overflow and fuel exhaustion. Fuzzing checks decoder robustness and canonical
round trips; it is not a proof against every possible defect.

This is an executable, precisely specified assembly language prototype. Its
bounded registers, program size and execution budget do not establish mathematical
universality, AGI, or an advantage over existing instruction sets.
