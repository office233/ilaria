package coreir

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode"
)

const (
	Version         = 1
	EffectVersion   = 1
	MaxBytes        = 1 << 20
	MaxFunctions    = 64
	MaxBlocks       = 256
	MaxSlots        = 512
	MaxInstructions = 8192
	MaxFuel         = 1_000_000
	MaxEffects      = 16
	MaxCapabilities = 32
)

type Module struct {
	Version   int        `json:"version"`
	Data      []byte     `json:"data,omitempty"`
	Functions []Function `json:"functions"`
}
type Parameter struct {
	Name string `json:"name"`
	Type Type   `json:"type"`
}
type Function struct {
	Name                 string                  `json:"name"`
	Params               []Parameter             `json:"params,omitempty"`
	Result               Type                    `json:"result"`
	EffectVersion        int                     `json:"effect_version,omitempty"`
	Effects              []string                `json:"effects,omitempty"`
	RequiredCapabilities []CapabilityRequirement `json:"required_capabilities,omitempty"`
	Slots                []Type                  `json:"slots,omitempty"`
	Blocks               []Block                 `json:"blocks"`
}
type Block struct {
	Instructions []Instruction `json:"instructions,omitempty"`
	Terminator   Terminator    `json:"terminator"`
}
type Instruction struct {
	Op       string   `json:"op"`
	Dest     int      `json:"dest"`
	Args     []int    `json:"args,omitempty"`
	Constant *Literal `json:"constant,omitempty"`
	Callee   string   `json:"callee,omitempty"`
	MayTrap  bool     `json:"may_trap"`
	Location Location `json:"location"`
}
type Terminator struct {
	Op       string   `json:"op"`
	Value    int      `json:"value"` // -1 means no value, never an implicit zero slot.
	Targets  []int    `json:"targets,omitempty"`
	Location Location `json:"location"`
}

// DecodeStrict rejects unknown fields, duplicate keys (including casing aliases),
// nulls, trailing values and excessive size/depth before semantic validation.
func DecodeStrict(data []byte, out any) error {
	return decodeStrictBounded(data, MaxBytes, out)
}

func decodeStrictBounded(data []byte, maxBytes int, out any) error {
	if len(data) == 0 || len(data) > maxBytes {
		return diagnostic("invalid_json", fmt.Sprintf("JSON size outside 1..%d bytes", maxBytes))
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var scan func(int) error
	scan = func(depth int) error {
		if depth > 128 {
			return fmt.Errorf("JSON nesting exceeds 128")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		if t == nil {
			return fmt.Errorf("null is not permitted")
		}
		if delim, ok := t.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, err := d.Token()
					if err != nil {
						return err
					}
					key, ok := k.(string)
					if !ok {
						return fmt.Errorf("expected object key")
					}
					key = foldJSONKey(key)
					if seen[key] {
						return fmt.Errorf("duplicate object key %q", key)
					}
					seen[key] = true
					if err := scan(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for d.More() {
					if err := scan(depth + 1); err != nil {
						return err
					}
				}
			default:
				return fmt.Errorf("unexpected delimiter")
			}
			_, err = d.Token()
			return err
		}
		return nil
	}
	if err := scan(0); err != nil {
		return diagnostic("invalid_json", err.Error())
	}
	if _, err := d.Token(); err != io.EOF {
		return diagnostic("invalid_json", "trailing JSON data")
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return diagnostic("invalid_json", err.Error())
	}
	return nil
}

// encoding/json matches field names using Unicode simple case folding, not
// just lowercase conversion. For example, long s (U+017F) aliases ASCII s.
// Use the smallest rune in each fold cycle so duplicate detection covers the
// same aliases as the decoder without depending on private stdlib helpers.
func foldJSONKey(key string) string {
	var folded strings.Builder
	for _, r := range key {
		canonical := r
		for next := unicode.SimpleFold(r); next != r; next = unicode.SimpleFold(next) {
			if next < canonical {
				canonical = next
			}
		}
		folded.WriteRune(canonical)
	}
	return folded.String()
}

func Decode(data []byte) (Module, error) {
	var m Module
	if err := DecodeStrict(data, &m); err != nil {
		return Module{}, err
	}
	if err := m.Validate(); err != nil {
		return Module{}, err
	}
	return m, nil
}

// Validate checks typed operations, calls, CFG edges and definite initialization
// on every reachable path. This is a mutable-slot IR, NOT SSA. All instructions,
// even unreachable ones, are structurally/type checked. No guest host calls exist.
func (m Module) Validate() error {
	bad := func(s string) error { return diagnostic("invalid_ir", s) }
	if m.Version != Version || len(m.Functions) == 0 || len(m.Functions) > MaxFunctions {
		return bad("unsupported version or function count")
	}
	if len(m.Data) > MaxByteArenaBytes {
		return bad(fmt.Sprintf("byte arena exceeds %d bytes", MaxByteArenaBytes))
	}
	functions := map[string]Function{}
	for _, f := range m.Functions {
		if f.Name == "" || len(f.Name) > 128 {
			return bad("invalid function name")
		}
		if _, ok := functions[f.Name]; ok {
			return bad("duplicate function " + f.Name)
		}
		functions[f.Name] = f
	}
	total := 0
	for _, f := range m.Functions {
		fail := func(s string) error { return bad(f.Name + ": " + s) }
		if !f.Result.storable() && f.Result != Void {
			return fail("unsupported result type")
		}
		if err := validateFunctionEffects(f); err != nil {
			return fail(err.Error())
		}
		effectSet := make(map[string]bool, len(f.Effects))
		for _, effect := range f.Effects {
			effectSet[effect] = true
		}
		if len(f.Slots) > MaxSlots || len(f.Blocks) == 0 || len(f.Blocks) > MaxBlocks || len(f.Params) > len(f.Slots) || len(f.Params) > 16 {
			return fail("invalid slots, parameters or blocks")
		}
		for _, t := range f.Slots {
			if !t.storable() {
				return fail("invalid slot type")
			}
		}
		names := map[string]bool{}
		for i, p := range f.Params {
			if p.Name == "" || len(p.Name) > 128 || names[p.Name] || p.Type != f.Slots[i] {
				return fail("invalid parameter")
			}
			names[p.Name] = true
		}
		preds := make([][]int, len(f.Blocks))
		for bi, block := range f.Blocks {
			total += len(block.Instructions) + 1
			if total > MaxInstructions {
				return fail("instruction limit exceeded")
			}
			for ii, ins := range block.Instructions {
				types := make([]Type, len(ins.Args))
				if len(ins.Args) > 16 {
					return fail("operand limit exceeded")
				}
				for i, a := range ins.Args {
					if a < 0 || a >= len(f.Slots) {
						return fail("invalid operand slot")
					}
					types[i] = f.Slots[a]
				}
				var result Type
				var trap bool
				var err error
				if ins.Op != "const" && ins.Constant != nil || ins.Op != "call" && ins.Callee != "" {
					return fail("unexpected instruction payload")
				}
				switch ins.Op {
				case "const":
					if len(ins.Args) != 0 || ins.Constant == nil {
						return fail("invalid constant")
					}
					var constant Value
					constant, err = ParseValue(ins.Constant.Type, ins.Constant.Value)
					if err == nil && ins.Constant.Type == Bytes {
						offset, length, _ := constant.ByteSpan()
						end := uint64(offset) + uint64(length)
						if uint64(offset) > uint64(len(m.Data)) || end > uint64(len(m.Data)) {
							err = diagnostic("invalid_bytespan", fmt.Sprintf("bytes constant %d:%d is outside module arena of %d bytes", offset, length, len(m.Data)))
						}
					}
					result = ins.Constant.Type
				case "move":
					if len(types) != 1 {
						return fail("move requires one operand")
					}
					result = types[0]
				case "call":
					callee, ok := functions[ins.Callee]
					if !ok || len(types) != len(callee.Params) {
						return fail("unknown call or incorrect arity")
					}
					if err := validateEffectPropagation(f, callee); err != nil {
						return fail(err.Error())
					}
					for i, t := range types {
						if t != callee.Params[i].Type {
							return fail("call argument type mismatch")
						}
					}
					result, trap = callee.Result, true
				case "io.stdout", "io.stderr":
					if len(types) != 1 || !types[0].scalar() {
						return fail(ins.Op + " requires one scalar operand")
					}
					required := EffectIOStdout
					if ins.Op == "io.stderr" {
						required = EffectIOStderr
					}
					if !effectSet[required] {
						return fail(fmt.Sprintf("%s requires declared effect %q", ins.Op, required))
					}
					result, trap = Void, true
				case "clock.read":
					if len(types) != 0 {
						return fail("clock.read requires no operands")
					}
					if !effectSet[EffectClockRead] {
						return fail(fmt.Sprintf("clock.read requires declared effect %q", EffectClockRead))
					}
					result, trap = U64, true
				case "rng.sample":
					if len(types) != 0 {
						return fail("rng.sample requires no operands")
					}
					if !effectSet[EffectRNGSample] {
						return fail(fmt.Sprintf("rng.sample requires declared effect %q", EffectRNGSample))
					}
					result, trap = U64, true
				case "fs.write":
					if len(types) != 2 || types[0] != Bytes || types[1] != Bytes {
						return fail("fs.write requires path bytes and data bytes")
					}
					if !effectSet[EffectFSWrite] {
						return fail(fmt.Sprintf("fs.write requires declared effect %q", EffectFSWrite))
					}
					result, trap = Void, true
				case "fs.read":
					if len(types) != 1 || types[0] != Bytes {
						return fail("fs.read requires path bytes")
					}
					if !effectSet[EffectFSRead] {
						return fail(fmt.Sprintf("fs.read requires declared effect %q", EffectFSRead))
					}
					result, trap = Bytes, true
				case "net.connect":
					if len(types) != 2 || types[0] != Bytes || types[1] != U64 {
						return fail("net.connect requires IPv4 bytes and u64 port")
					}
					if !effectSet[EffectNetConnect] {
						return fail(fmt.Sprintf("net.connect requires declared effect %q", EffectNetConnect))
					}
					result, trap = Bool, true
				case "net.fetch":
					if len(types) != 3 || types[0] != Bytes || types[1] != U64 || types[2] != Bytes {
						return fail("net.fetch requires IPv4 bytes, u64 port and path bytes")
					}
					if !effectSet[EffectNetFetch] {
						return fail(fmt.Sprintf("net.fetch requires declared effect %q", EffectNetFetch))
					}
					result, trap = Bytes, true
				case "process.exec":
					if len(types) != 6 || types[0] != Bytes || types[1] != U64 || types[2] != Bytes || types[3] != Bytes || types[4] != Bytes || types[5] != Bytes {
						return fail("process.exec requires executable bytes, u64 argc and four explicit bytes argv slots")
					}
					if !effectSet[EffectProcessExec] {
						return fail(fmt.Sprintf("process.exec requires declared effect %q", EffectProcessExec))
					}
					result, trap = U64, true
				case "bytes.len":
					if len(types) != 1 || types[0] != Bytes {
						return fail("bytes.len requires one bytes operand")
					}
					result = U64
				case "bytes.get":
					if len(types) != 2 || types[0] != Bytes || types[1] != U64 {
						return fail("bytes.get requires bytes and u64 operands")
					}
					result, trap = U64, true
				case "bytes.from_storage_u64":
					if len(types) != 2 || types[0] != U64 || types[1] != U64 {
						return fail("bytes.from_storage_u64 requires storage-id and length u64 operands")
					}
					result, trap = Bytes, true
				case "storage.alloc_u64":
					if len(types) != 1 || types[0] != U64 {
						return fail("storage.alloc_u64 requires element-count u64")
					}
					result, trap = U64, true
				case "storage.load_u64":
					if len(types) != 2 || types[0] != U64 || types[1] != U64 {
						return fail("storage.load_u64 requires storage-id u64 and index u64")
					}
					result, trap = U64, true
				case "storage.store_u64":
					if len(types) != 3 || types[0] != U64 || types[1] != U64 || types[2] != U64 {
						return fail("storage.store_u64 requires storage-id, index and value u64 operands")
					}
					result, trap = Void, true
				case "storage.free":
					if len(types) != 1 || types[0] != U64 {
						return fail("storage.free requires storage-id u64")
					}
					result, trap = Void, true
				case "storage.len_u64", "storage.capacity_u64":
					if len(types) != 1 || types[0] != U64 {
						return fail(ins.Op + " requires storage-id u64")
					}
					result, trap = U64, true
				case "storage.set_len_u64":
					if len(types) != 2 || types[0] != U64 || types[1] != U64 {
						return fail("storage.set_len_u64 requires storage-id and length u64")
					}
					result, trap = Void, true
				default:
					result, trap, err = resultType(ins.Op, types)
				}
				if err != nil {
					return fail(fmt.Sprintf("block %d instruction %d: %v", bi, ii, err))
				}
				if result == Void {
					if ins.Dest != -1 {
						return fail("void call must have dest -1")
					}
				} else if ins.Dest < 0 || ins.Dest >= len(f.Slots) || f.Slots[ins.Dest] != result {
					return fail("result slot type mismatch")
				}
				if ins.MayTrap != trap {
					return fail("incorrect may_trap annotation")
				}
			}
			t := block.Terminator
			switch t.Op {
			case "return":
				if len(t.Targets) != 0 {
					return fail("return has successors")
				}
				if f.Result == Void {
					if t.Value != -1 {
						return fail("void return has value")
					}
				} else if t.Value < 0 || t.Value >= len(f.Slots) || f.Slots[t.Value] != f.Result {
					return fail("return type mismatch")
				}
			case "jump":
				if len(t.Targets) != 1 || t.Value != -1 {
					return fail("invalid jump")
				}
			case "branch":
				if len(t.Targets) != 2 || t.Value < 0 || t.Value >= len(f.Slots) || f.Slots[t.Value] != Bool {
					return fail("invalid branch")
				}
			case "unreachable":
				if t.Value != -1 || len(t.Targets) != 0 {
					return fail("invalid unreachable")
				}
			default:
				return fail("missing or unknown terminator")
			}
			for _, target := range t.Targets {
				if target <= 0 || target >= len(f.Blocks) {
					return fail("invalid target or edge into entry block")
				}
				preds[target] = append(preds[target], bi)
			}
		}
		if err := definiteAssignment(f, preds); err != nil {
			return fail(err.Error())
		}
	}
	return nil
}

func definiteAssignment(f Function, preds [][]int) error {
	n, words := len(f.Blocks), (len(f.Slots)+63)/64
	reachable := make([]bool, n)
	reachable[0] = true
	queue := []int{0}
	for len(queue) > 0 {
		b := queue[0]
		queue = queue[1:]
		for _, target := range f.Blocks[b].Terminator.Targets {
			if !reachable[target] {
				reachable[target] = true
				queue = append(queue, target)
			}
		}
	}
	in, out := make([][]uint64, n), make([][]uint64, n)
	set := func(s []uint64, i int) { s[i/64] |= uint64(1) << uint(i%64) }
	has := func(s []uint64, i int) bool { return s[i/64]&(uint64(1)<<uint(i%64)) != 0 }
	for b := 0; b < n; b++ {
		in[b] = make([]uint64, words)
		out[b] = make([]uint64, words)
		if b != 0 && reachable[b] {
			for w := 0; w < words; w++ {
				in[b][w] = ^uint64(0)
				out[b][w] = ^uint64(0)
			}
		}
	}
	for i := range f.Params {
		set(in[0], i)
	}
	for changed := true; changed; {
		changed = false
		for b := 0; b < n; b++ {
			if !reachable[b] {
				continue
			}
			if b != 0 {
				for w := 0; w < words; w++ {
					v := ^uint64(0)
					for _, p := range preds[b] {
						if reachable[p] {
							v &= out[p][w]
						}
					}
					in[b][w] = v
				}
			}
			v := append([]uint64(nil), in[b]...)
			for _, ins := range f.Blocks[b].Instructions {
				if ins.Dest >= 0 {
					set(v, ins.Dest)
				}
			}
			for w := range v {
				if v[w] != out[b][w] {
					changed = true
					out[b][w] = v[w]
				}
			}
		}
	}
	for b, block := range f.Blocks {
		if !reachable[b] {
			continue
		}
		v := append([]uint64(nil), in[b]...)
		for _, ins := range block.Instructions {
			for _, a := range ins.Args {
				if !has(v, a) {
					return fmt.Errorf("block %d reads uninitialized slot %d", b, a)
				}
			}
			if ins.Dest >= 0 {
				set(v, ins.Dest)
			}
		}
		if a := block.Terminator.Value; a >= 0 && !has(v, a) {
			return fmt.Errorf("block %d terminator reads uninitialized slot %d", b, a)
		}
	}
	return nil
}
