package swyplang

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math/rand"
	"reflect"
	"strings"
	"sync"
	"testing"

	vm "swyp-lang/experiments/ternaryvm"
)

func swypbTestModule(t testing.TB, source string) *STV2Module {
	t.Helper()
	p, err := Parse("test.swyp", source)
	if err != nil {
		t.Fatal(err)
	}
	m, err := p.CompileSTV2()
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func swypbTestBytes(t testing.TB, m *STV2Module) []byte {
	t.Helper()
	b, err := m.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Recompute the public checksum to test structural validation, not just hashing.
func swypbReseal(b []byte) {
	digest := sha256.Sum256(b[:len(b)-sha256.Size])
	copy(b[len(b)-sha256.Size:], digest[:])
}

func TestSWYPBRoundTripAndMetadata(t *testing.T) {
	for _, tc := range []struct {
		source string
		args   []int64
		kind   string
		want   int64
	}{
		{"fn main() -> number { return 42; }", nil, "number", 42},
		{"fn main() -> bool { return true; }", nil, "bool", 1},
		{"fn main() -> bool { return false; }", nil, "bool", 0},
		{"fn main() -> number { return arg(0) * 2; }", []int64{-5}, "number", -10},
		{"fn main() -> bool { return arg(0) < arg(1); }", []int64{-5, 1}, "bool", 1},
		{"fn main() -> number { return arg(2); }", []int64{3, 4, 5}, "number", 5},
		{"fn main() -> number { return arg(3); }", []int64{3, 4, 5, 6}, "number", 6},
	} {
		m := swypbTestModule(t, tc.source)
		b := swypbTestBytes(t, m)
		if len(b) != len(m.Bytecode())+48 || string(b[:4]) != "SWYB" {
			t.Fatal("format/size")
		}
		if binary.LittleEndian.Uint16(b[4:6]) != 1 || b[6] != 1 || b[7] != 1 || b[10] != 0 || b[11] != 0 {
			t.Fatal("header")
		}
		q, err := LoadSWYPB(b)
		if err != nil {
			t.Fatal(err)
		}
		if q.ArgumentCount() != len(tc.args) || q.ResultType() != tc.kind || q.InstructionCount() != m.InstructionCount() {
			t.Fatal("metadata lost")
		}
		if !bytes.Equal(q.Bytecode(), m.Bytecode()) || !bytes.Equal(swypbTestBytes(t, q), b) {
			t.Fatal("noncanonical round trip")
		}
		r, err := q.Run(tc.args, 100)
		if err != nil || r.Value != tc.want {
			t.Fatalf("result=%v err=%v", r, err)
		}
	}
}

func TestSWYPBRejectMalformed(t *testing.T) {
	m := swypbTestModule(t, "fn main() -> number { return arg(0) + 1; }")
	data := swypbTestBytes(t, m)
	for n := 0; n < len(data); n++ {
		if _, err := LoadSWYPB(data[:n]); err == nil {
			t.Fatalf("accepted truncation %d", n)
		}
	}
	for _, tc := range []struct {
		name   string
		change func([]byte)
	}{
		{"magic", func(b []byte) { b[0] = 'X' }},
		{"version-zero", func(b []byte) { b[4] = 0 }},
		{"version-future", func(b []byte) { b[5] = 1 }},
		{"target", func(b []byte) { b[6] = 2 }},
		{"profile", func(b []byte) { b[7] = 0 }},
		{"result-zero", func(b []byte) { b[8] = 0 }},
		{"result-unknown", func(b []byte) { b[8] = 3 }},
		{"arity", func(b []byte) { b[9] = 5 }},
		{"reserved-a", func(b []byte) { b[10] = 1 }},
		{"reserved-b", func(b []byte) { b[11] = 1 }},
		{"length-zero", func(b []byte) { binary.LittleEndian.PutUint32(b[12:16], 0) }},
		{"length-max", func(b []byte) { binary.LittleEndian.PutUint32(b[12:16], ^uint32(0)) }},
		{"inner-version", func(b []byte) { b[19] = '1' }},
		{"inner-count", func(b []byte) { binary.LittleEndian.PutUint32(b[20:24], ^uint32(0)) }},
		{"inner-trit", func(b []byte) { b[24] = 243 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := append([]byte(nil), data...)
			tc.change(b)
			swypbReseal(b)
			if _, err := LoadSWYPB(b); err == nil {
				t.Fatal("accepted invalid module with valid checksum")
			}
		})
	}
	for _, b := range [][]byte{m.Bytecode(), append(append([]byte(nil), data...), 0), make([]byte, MaxSWYPBBytes+1)} {
		if _, err := LoadSWYPB(b); err == nil {
			t.Fatal("accepted wrong format/length")
		}
	}
	for i := range data {
		for bit := uint(0); bit < 8; bit++ {
			b := append([]byte(nil), data...)
			b[i] ^= 1 << bit
			if _, err := LoadSWYPB(b); err == nil {
				t.Fatalf("undetected single-bit mutation %d:%d", i, bit)
			}
		}
	}
	t.Logf("%d truncations and %d single-bit mutations rejected", len(data), len(data)*8)
}

func TestSWYPBAllHeaderByteValues(t *testing.T) {
	data := swypbTestBytes(t, swypbTestModule(t, "fn main() -> number { return 1; }"))
	accepted, rejected := 0, 0
	for index := 0; index < swypbHeaderSize; index++ {
		for value := 0; value < 256; value++ {
			b := append([]byte(nil), data...)
			b[index] = byte(value)
			swypbReseal(b)
			// Only known result tags and arities may differ in a valid header.
			want := byte(value) == data[index] || (index == 8 && value == 2) || (index == 9 && value <= 4)
			m, err := LoadSWYPB(b)
			if (err == nil) != want {
				t.Fatalf("index=%d value=%d err=%v", index, value, err)
			}
			if err == nil {
				accepted++
				if !bytes.Equal(swypbTestBytes(t, m), b) {
					t.Fatal("canonical header changed")
				}
			} else {
				rejected++
			}
		}
	}
	t.Logf("4096 resealed header cases: %d valid, %d rejected", accepted, rejected)
}

func TestSWYPBLoadedRuntimeContracts(t *testing.T) {
	identity := swypbTestBytes(t, swypbTestModule(t, "fn main() -> number { return arg(0); }"))
	m, err := LoadSWYPB(identity)
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]int64{nil, {1, 2}, {vm.MaxExactInteger + 1}, {-vm.MaxExactInteger - 1}} {
		if _, err := m.Run(args, 100); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
	for _, fuel := range []int{0, -1, vm.MaxFuel + 1} {
		if _, err := m.Run([]int64{0}, fuel); err == nil {
			t.Fatal("invalid fuel accepted")
		}
	}
	for _, v := range []int64{-vm.MaxExactInteger, vm.MaxExactInteger} {
		r, err := m.Run([]int64{v}, 100)
		if err != nil || r.Value != v {
			t.Fatal(r, err)
		}
	}
	// A checksum can be recomputed by anyone: result metadata is untrusted.
	identity[8] = 2
	swypbReseal(identity)
	boolean, err := LoadSWYPB(identity)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []int64{-1, 2, 42} {
		if _, err := boolean.Run([]int64{v}, 100); err == nil || !strings.Contains(err.Error(), "boolean") {
			t.Fatal("invalid boolean accepted", err)
		}
	}
	for _, v := range []int64{0, 1} {
		r, err := boolean.Run([]int64{v}, 100)
		if err != nil || r.Value != v {
			t.Fatal(r, err)
		}
	}
	for _, source := range []string{
		"fn main() -> number { while true {} return 0; }",
		"fn main() -> number { return 1 % 0; }",
		"fn main() -> number { let x = arg(0) + 1; return x - 1; }",
	} {
		compiled := swypbTestModule(t, source)
		loaded, err := LoadSWYPB(swypbTestBytes(t, compiled))
		if err != nil {
			t.Fatal("loading must not execute", err)
		}
		args := make([]int64, loaded.ArgumentCount())
		if len(args) > 0 {
			args[0] = vm.MaxExactInteger
		}
		if _, err := loaded.Run(args, 100); err == nil {
			t.Fatal("runtime contract bypassed")
		}
	}
}

func TestSWYPBOwnershipAndConcurrency(t *testing.T) {
	data := swypbTestBytes(t, swypbTestModule(t, "fn main() -> number { return arg(0) * 2; }"))
	m, err := LoadSWYPB(data)
	if err != nil {
		t.Fatal(err)
	}
	for i := range data {
		data[i] = 0
	}
	for _, exposed := range [][]byte{m.Bytecode(), swypbTestBytes(t, m)} {
		for i := range exposed {
			exposed[i] = 0
		}
	}
	var wg sync.WaitGroup
	for n := int64(0); n < 64; n++ {
		wg.Add(1)
		go func(n int64) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				r, err := m.Run([]int64{n}, 100)
				if err != nil || r.Value != n*2 {
					t.Errorf("%v %v", r, err)
					return
				}
				b, err := m.MarshalBinary()
				if err != nil {
					t.Error(err)
					return
				}
				if _, err := LoadSWYPB(b); err != nil {
					t.Error(err)
					return
				}
			}
		}(n)
	}
	wg.Wait()
}

func TestSWYPBInvalidModuleAndMaximum(t *testing.T) {
	for _, m := range []*STV2Module{nil, {}, {arguments: -1, resultType: "number"}, {arguments: 5, resultType: "number"}, {resultType: "string"}, {resultType: "number", code: vm.V2Program{{Op: vm.V2Op(255)}}}} {
		if _, err := m.MarshalBinary(); err == nil {
			t.Fatal("invalid module marshaled")
		}
		if _, err := m.Run(nil, 100); err == nil {
			t.Fatal("invalid module ran")
		}
	}
	p := make(vm.V2Program, vm.MaxInstructions)
	p[len(p)-1].Op = vm.V2Halt
	m := &STV2Module{code: p, resultType: "number"}
	data := swypbTestBytes(t, m)
	q, err := LoadSWYPB(data)
	if err != nil {
		t.Fatal(err)
	}
	r, err := q.Run(nil, vm.MaxInstructions)
	if err != nil || r.Steps != vm.MaxInstructions || r.Value != 0 {
		t.Fatal(r, err)
	}
	if _, err := q.Run(nil, vm.MaxInstructions-1); err == nil {
		t.Fatal("fuel underflow")
	}
	// Invalid register, reserved operand, padding and immediate encodings.
	base := swypbTestBytes(t, swypbTestModule(t, "fn main() -> number { return 0; }"))
	for _, mutate := range []func([]byte){
		func(b []byte) {
			for j, v := range []byte{2, 2} {
				swypbSetDigit(b[16:], 3+j, v)
			}
		}, // A=8
		func(b []byte) { swypbSetDigit(b[16:], 5, 1) }, // unused B on const
		func(b []byte) {
			for j := 0; j < 21; j++ {
				swypbSetDigit(b[16:], 7+j, 2)
			}
		},
		func(b []byte) { count := int(binary.LittleEndian.Uint32(b[20:24])); swypbSetDigit(b[16:], count*28, 1) },
	} {
		b := append([]byte(nil), base...)
		mutate(b)
		swypbReseal(b)
		if _, err := LoadSWYPB(b); err == nil {
			t.Fatal("invalid inner payload accepted")
		}
	}
	t.Logf("maximum instruction payload round trip: %d bytes, %d steps", len(data), r.Steps)
}

func swypbSetDigit(payload []byte, k int, value byte) {
	power := byte(1)
	for j := 0; j < k%5; j++ {
		power *= 3
	}
	index := 8 + k/5
	payload[index] -= (payload[index] / power) % 3 * power
	payload[index] += value * power
}

func TestSWYPBGeneratedPersistence(t *testing.T) {
	rng := rand.New(rand.NewSource(15803))
	checks := 0
	for i := 0; i < 1000; i++ {
		expr := stv2RandomNumber(rng, 2)
		if i%2 == 0 {
			expr = stv2RandomBool(rng, 2)
		}
		p, m := stv2CompileTest(t, "fn main() { return "+expr+"; }")
		b := swypbTestBytes(t, m)
		q, err := LoadSWYPB(b)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(b, swypbTestBytes(t, q)) {
			t.Fatal("nondeterministic persistence")
		}
		for trial := 0; trial < 5; trial++ {
			args := make([]int64, q.ArgumentCount())
			for j := range args {
				args[j] = int64(rng.Intn(41) - 20)
			}
			stv2CompareTest(t, p, q, args)
			a, ea := m.Run(args, 10000)
			c, ec := q.Run(args, 10000)
			if (ea == nil) != (ec == nil) || (ea == nil && !reflect.DeepEqual(a, c)) {
				t.Fatal("persistence changed behavior", ea, ec)
			}
			checks++
		}
	}
	t.Logf("1000 programs, %d persisted differential executions", checks)
}

func FuzzSWYPBLoad(f *testing.F) {
	seed := swypbTestBytes(f, swypbTestModule(f, "fn main() -> number { return arg(0) + 1; }"))
	f.Add(seed)
	f.Add([]byte("SWYB"))
	f.Add([]byte{})
	f.Add(bytes.Repeat([]byte{255}, 80))
	check := func(t *testing.T, b []byte) {
		m, err := LoadSWYPB(b)
		if err != nil {
			return
		}
		out, err := m.MarshalBinary()
		if err != nil || !bytes.Equal(out, b) {
			t.Fatal("noncanonical load", err)
		}
		args := make([]int64, m.ArgumentCount())
		a, ea := m.Run(args, 64)
		c, ec := m.Run(args, 64)
		if (ea == nil) != (ec == nil) || (ea == nil && !reflect.DeepEqual(a, c)) {
			t.Fatal("nondeterministic execution")
		}
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > MaxSWYPBBytes+1 {
			return
		}
		check(t, b)
		// Let coverage-driven mutations reach payload validation behind SHA-256.
		if len(b) >= swypbOverhead && len(b) <= MaxSWYPBBytes {
			copyOf := append([]byte(nil), b...)
			swypbReseal(copyOf)
			check(t, copyOf)
		}
	})
}

// Fixed interoperability vector derived by an independent Python implementation
// of the documented field layout. This is not built with the codec under test.
func TestSWYPBGoldenV1(t *testing.T) {
	const golden = "53575942010001010100000014000000535456320200000001ea66e883dd0241c8a0950026af82a7b773bf3fe4d69a4fbd16a09b5c14dbafaefdd46ea0cacdc997094adf"
	data, err := hex.DecodeString(golden)
	if err != nil {
		t.Fatal(err)
	}
	m, err := LoadSWYPB(data)
	if err != nil {
		t.Fatal(err)
	}
	r, err := m.Run(nil, 2)
	if err != nil || r.Value != 42 || r.Steps != 2 {
		t.Fatal(r, err)
	}
	expected := &STV2Module{code: vm.V2Program{{Op: vm.V2Const, Immediate: 42}, {Op: vm.V2Halt}}, resultType: "number"}
	if !bytes.Equal(swypbTestBytes(t, expected), data) || !bytes.Equal(swypbTestBytes(t, m), data) {
		t.Fatal("wire format drift")
	}
}
