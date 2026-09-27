package ternaryvm

import (
	"bytes"
	"encoding/binary"
	"math"
	"math/big"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func referenceTruth(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

// The oracle uses arbitrary-precision integers, independent of the VM overflow checks.
func TestSTV2ArithmeticOracle(t *testing.T) {
	edge := []int64{math.MinInt64, math.MinInt64 + 1, -(1 << 53), -(1 << 32), -2147483648, -2, -1, 0, 1, 2, 2147483647, 1 << 32, 1 << 53, math.MaxInt64 - 1, math.MaxInt64}
	ops := []V2Op{V2Add, V2Sub, V2Mul, V2Div, V2Mod}
	count := 0
	check := func(a, b int64) {
		for _, op := range ops {
			var want big.Int
			x, y := big.NewInt(a), big.NewInt(b)
			invalid := false
			switch op {
			case V2Add:
				want.Add(x, y)
			case V2Sub:
				want.Sub(x, y)
			case V2Mul:
				want.Mul(x, y)
			case V2Div:
				if b == 0 {
					invalid = true
				} else {
					want.Quo(x, y)
				}
			case V2Mod:
				if b == 0 {
					invalid = true
				} else {
					want.Rem(x, y)
				}
			}
			invalid = invalid || !want.IsInt64()
			p := V2Program{{Op: op, A: 0, B: 1}, {Op: V2Halt, A: 0}}
			got, err := RunV2(p, [8]int64{a, b}, 2)
			if (err != nil) != invalid || (!invalid && (got.Value != want.Int64() || got.Steps != 2)) {
				t.Fatalf("op=%d a=%d b=%d got=%+v err=%v want=%s invalid=%v", op, a, b, got, err, want.String(), invalid)
			}
			count++
		}
	}
	for _, a := range edge {
		for _, b := range edge {
			check(a, b)
		}
	}
	rng := rand.New(rand.NewSource(5802))
	for i := 0; i < 200000; i++ {
		a, b := int64(rng.Uint64()), int64(rng.Uint64())
		if i%2 == 0 {
			a = int64(rng.Intn(2000001) - 1000000)
			b = int64(rng.Intn(2000001) - 1000000)
		}
		check(a, b)
	}
	t.Logf("arithmetic oracle comparisons=%d seed=5802", count)
}

func TestSTV2ComparisonBitwiseAndAliasing(t *testing.T) {
	rng := rand.New(rand.NewSource(2702))
	count := 0
	for n := 0; n < 20000; n++ {
		a, b := int64(rng.Uint64()), int64(rng.Uint64())
		if n%7 == 0 {
			b = a
		}
		for _, alias := range []bool{false, true} {
			right := uint8(1)
			y := b
			if alias {
				right = 0
				y = a
			}
			values := []struct {
				op V2Op
				v  int64
			}{
				{V2Mov, y}, {V2Eq, referenceTruth(a == y)}, {V2Ne, referenceTruth(a != y)},
				{V2Lt, referenceTruth(a < y)}, {V2Le, referenceTruth(a <= y)}, {V2Gt, referenceTruth(a > y)}, {V2Ge, referenceTruth(a >= y)},
				{V2BitAnd, a & y}, {V2BitOr, a | y}, {V2BitXor, a ^ y},
				{V2Min, a}, {V2Max, a},
			}
			for i, c := range values {
				if c.op == V2Min && y < a {
					c.v = y
				}
				if c.op == V2Max && y > a {
					c.v = y
				}
				p := V2Program{{Op: c.op, B: right}, {Op: V2Halt}}
				got, e := RunV2(p, [8]int64{a, b}, 2)
				if e != nil || got.Value != c.v {
					t.Fatalf("n=%d index=%d alias=%v got=%v err=%v want=%d", n, i, alias, got, e, c.v)
				}
				count++
			}
		}
	}
	t.Logf("comparison/move/min/max/bitwise checks=%d seed=2702", count)
}

func TestSTV2UnaryAndImmediateBoundaries(t *testing.T) {
	for _, a := range []int64{math.MinInt64, math.MinInt64 + 1, -1, 0, 1, math.MaxInt64} {
		for _, op := range []V2Op{V2Neg, V2Abs, V2BitNot} {
			p := V2Program{{Op: op}, {Op: V2Halt}}
			got, e := RunV2(p, [8]int64{a}, 2)
			fail := a == math.MinInt64 && op != V2BitNot
			want := a
			switch op {
			case V2Neg:
				want = -a
			case V2Abs:
				if a < 0 {
					want = -a
				}
			case V2BitNot:
				want = ^a
			}
			if (e != nil) != fail || (!fail && got.Value != want) {
				t.Fatalf("op=%d a=%d got=%v err=%v", op, a, got, e)
			}
		}
		for _, b := range []int32{math.MinInt32, -1, 0, 1, math.MaxInt32} {
			p := V2Program{{Op: V2Addi, Immediate: b}, {Op: V2Halt}}
			got, e := RunV2(p, [8]int64{a}, 2)
			want := new(big.Int).Add(big.NewInt(a), big.NewInt(int64(b)))
			if (e == nil) != want.IsInt64() || (e == nil && got.Value != want.Int64()) {
				t.Fatal(a, b, got, e, want)
			}
		}
	}
	for _, v := range []int32{math.MinInt32, 0, math.MaxInt32} {
		p := V2Program{{Op: V2Const, A: 7, Immediate: v}, {Op: V2Halt, A: 7}}
		d, e := EncodeV2(p)
		if e != nil {
			t.Fatal(e)
		}
		q, e := DecodeV2(d)
		if e != nil || !reflect.DeepEqual(p, q) {
			t.Fatal(q, e)
		}
		r, e := RunV2(q, [8]int64{}, 2)
		if e != nil || r.Value != int64(v) {
			t.Fatal(r, e)
		}
	}
}

func TestSTV2FlowAndFuel(t *testing.T) {
	for _, op := range []V2Op{V2Jz, V2Jnz} {
		for _, a := range []int64{-1, 0, 1} {
			p := V2Program{{Op: op, Immediate: 3}, {Op: V2Const, A: 1, Immediate: 11}, {Op: V2Halt, A: 1}, {Op: V2Const, A: 1, Immediate: 22}, {Op: V2Halt, A: 1}}
			r, e := RunV2(p, [8]int64{a}, 3)
			want := int64(11)
			if (op == V2Jz && a == 0) || (op == V2Jnz && a != 0) {
				want = 22
			}
			if e != nil || r.Value != want || r.Steps != 3 {
				t.Fatal(op, a, r, e)
			}
		}
	}
	p, e := AssembleV2("nop\njmp done\nconst r0 -1\ndone: halt r0\n")
	if e != nil {
		t.Fatal(e)
	}
	for fuel := 0; fuel <= 4; fuel++ {
		r, e := RunV2(p, [8]int64{9}, fuel)
		if (e == nil) != (fuel >= 3) || (e == nil && (r.Steps != 3 || r.Value != 9)) {
			t.Fatal(fuel, r, e)
		}
	}
	if _, e := RunV2(p, [8]int64{}, MaxFuel+1); e == nil {
		t.Fatal("bad fuel")
	}
	if _, e := RunV2(V2Program{{Op: V2Nop}}, [8]int64{}, 2); e == nil {
		t.Fatal("fallthrough")
	}
	if _, e := RunV2(V2Program{{Op: V2Jmp}}, [8]int64{}, 20); e == nil {
		t.Fatal("loop")
	}
}

func TestSTV2ExactProfile(t *testing.T) {
	for _, a := range []int64{-MaxExactInteger, MaxExactInteger} {
		p := V2Program{{Op: V2Halt}}
		if r, e := RunV2Exact(p, [8]int64{a}, 1); e != nil || r.Value != a {
			t.Fatal(r, e)
		}
	}
	for _, a := range []int64{math.MinInt64, -MaxExactInteger - 1, MaxExactInteger + 1, math.MaxInt64} {
		if _, e := RunV2Exact(V2Program{{Op: V2Halt}}, [8]int64{a}, 1); e == nil {
			t.Fatal("wide initial value", a)
		}
	}
	for _, a := range []int64{-MaxExactInteger, MaxExactInteger} {
		b := int64(1)
		if a < 0 {
			b = -1
		}
		p := V2Program{{Op: V2Add, B: 1}, {Op: V2Sub, B: 1}, {Op: V2Halt}}
		if _, e := RunV2Exact(p, [8]int64{a, b}, 3); e == nil {
			t.Fatal("intermediate range violation")
		}
		if r, e := RunV2(p, [8]int64{a, b}, 3); e != nil || r.Value != a {
			t.Fatal("raw int64 semantics changed", r, e)
		}
	}
}

func TestSTV2AssemblyAndValidationAudit(t *testing.T) {
	for _, s := range []string{"", "# blank", "wat", "const r8 1", "const r0 2147483648", "const r0 -2147483649", "jmp unknown", "x:\nx:\nhalt r0", "9x: halt r0", "halt r0 extra", "x:y: halt r0", "jmp -1", "jmp end\nend:", "const r0 x", "jmp 1", "add r0 r8", strings.Repeat("nop\n", MaxInstructions+1), strings.Repeat("#", (1<<20)+1)} {
		if _, e := AssembleV2(s); e == nil {
			t.Fatalf("accepted malformed assembly %.80q", s)
		}
	}
	for _, s := range []string{"λ: nop\nhalt r0", "# hi\r\nconst r7 -2147483648 # negative\r\nhalt r7", "jmp 1\nhalt r0"} {
		if _, e := AssembleV2(s); e != nil {
			t.Fatal(s, e)
		}
	}
	for op := 0; op < 256; op++ {
		i := V2Instruction{Op: V2Op(op)}
		p := V2Program{i}
		e := p.Validate()
		if (e == nil) != (op <= 26) {
			t.Fatal("opcode validation", op, e)
		}
	}
	for _, i := range []V2Instruction{{Op: V2Halt, A: 8}, {Op: V2Mov, B: 8}, {Op: V2Nop, A: 1}, {Op: V2Const, B: 1}, {Op: V2Add, Immediate: 1}, {Op: V2Neg, B: 1}, {Op: V2Halt, Immediate: 1}, {Op: V2Jmp, A: 1}, {Op: V2Jz, Immediate: -1}, {Op: V2Jnz, Immediate: 1}} {
		p := V2Program{i}
		if _, e := EncodeV2(p); e == nil {
			t.Fatal("invalid instruction", i)
		}
	}
	if _, e := RunV2(nil, [8]int64{}, 1); e == nil {
		t.Fatal("empty program")
	}
}

func TestSTV2TransportMutationAudit(t *testing.T) {
	accepted, rejected := 0, 0
	for n := 1; n <= 10; n++ {
		p := make(V2Program, n)
		p[n-1] = V2Instruction{Op: V2Halt}
		data, e := EncodeV2(p)
		if e != nil {
			t.Fatal(e)
		}
		if len(data) != 8+(28*n+4)/5 {
			t.Fatal("length")
		}
		for j := 0; j < len(data); j++ {
			if _, e := DecodeV2(data[:j]); e == nil {
				t.Fatal("truncation", j)
			}
		}
		for j := 0; j < len(data); j++ {
			for b := 0; b < 256; b++ {
				changed := append([]byte(nil), data...)
				changed[j] = byte(b)
				q, e := DecodeV2(changed)
				if e != nil {
					rejected++
					continue
				}
				accepted++
				again, e := EncodeV2(q)
				if e != nil || !bytes.Equal(changed, again) {
					t.Fatal("noncanonical", n, j, b, e)
				}
			}
		}
	}
	for _, data := range [][]byte{nil, []byte("STV2"), []byte("STV2\xff\xff\xff\xff"), append([]byte("STV2"), 0, 0, 0, 0)} {
		if _, e := DecodeV2(data); e == nil {
			t.Fatal("invalid header", data)
		}
	}
	p := V2Program{{Op: V2Halt}}
	data, _ := EncodeV2(p)
	for _, n := range []uint32{0, MaxInstructions + 1, math.MaxUint32} {
		bad := append([]byte(nil), data...)
		binary.LittleEndian.PutUint32(bad[4:8], n)
		if _, e := DecodeV2(bad); e == nil {
			t.Fatal(n)
		}
	}
	if _, e := DecodeV2(append(data, 0)); e == nil {
		t.Fatal("trailing data")
	}
	legacy, _ := Encode(Program{{Op: Halt}})
	if _, e := DecodeV2(legacy); e == nil {
		t.Fatal("STV1 accepted as STV2")
	}
	if _, e := Decode(data); e == nil {
		t.Fatal("STV2 accepted as STV1")
	}
	t.Logf("single-byte transport mutations: accepted canonical=%d rejected=%d", accepted, rejected)
}

func FuzzSTV2DecodeAudit(f *testing.F) {
	for _, s := range []string{"halt r0", "const r7 -2147483648\nhalt r7", "loop: addi r0 1\njmp loop"} {
		p, _ := AssembleV2(s)
		b, _ := EncodeV2(p)
		f.Add(b)
	}
	f.Add([]byte("STV2"))
	f.Fuzz(func(t *testing.T, b []byte) {
		p, e := DecodeV2(b)
		if e != nil {
			return
		}
		out, e := EncodeV2(p)
		if e != nil || !bytes.Equal(out, b) {
			t.Fatal("round trip", e)
		}
		_, _ = RunV2(p, [8]int64{}, 64)
	})
}

func FuzzSTV2AssemblyAudit(f *testing.F) {
	for _, s := range []string{"halt r0", "loop: jmp loop", "λ: const r0 42\nhalt r0", ""} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		p, e := AssembleV2(s)
		if e != nil {
			return
		}
		b, e := EncodeV2(p)
		if e != nil {
			t.Fatal(e)
		}
		q, e := DecodeV2(b)
		if e != nil || !reflect.DeepEqual(p, q) {
			t.Fatal(q, e)
		}
	})
}
