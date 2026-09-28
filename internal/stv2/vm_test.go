package stv2

import (
	"bytes"
	"math"
	"reflect"
	"testing"
)

const sumSource = "const r1 0\nconst r2 1\njz r0 6\nadd r1 r0\nsub r0 r2\njmp 2\nhalt r1"

func TestSumRoundTrip(t *testing.T) {
	p, e := Assemble(sumSource)
	if e != nil {
		t.Fatal(e)
	}
	data, e := Encode(p)
	if e != nil {
		t.Fatal(e)
	}
	decoded, e := Decode(data)
	if e != nil || !reflect.DeepEqual(p, decoded) {
		t.Fatalf("%v %v", decoded, e)
	}
	again, _ := Encode(decoded)
	if !bytes.Equal(data, again) {
		t.Fatal("noncanonical round trip")
	}
	for n := int64(0); n <= 1000; n++ {
		r, e := Run(decoded, [8]int64{n}, 10000)
		if e != nil || r.Value != n*(n+1)/2 {
			t.Fatalf("n=%d result=%v error=%v", n, r, e)
		}
	}
}

func TestConditional(t *testing.T) {
	p, e := Assemble("eq r0 r1\njz r0 4\nconst r2 42\nhalt r2\nconst r2 -7\nhalt r2")
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range []struct{ a, b, w int64 }{{5, 5, 42}, {5, 6, -7}, {-3, -3, 42}} {
		r, e := Run(p, [8]int64{c.a, c.b}, 20)
		if e != nil || r.Value != c.w {
			t.Fatalf("%v %v", r, e)
		}
	}
}

func TestErrorsAndBounds(t *testing.T) {
	for _, s := range []string{"", "oops", "const r8 2", "const r0 2147483648", "jmp -1", "jmp 2", "halt r0 extra"} {
		if _, e := Assemble(s); e == nil {
			t.Fatalf("accepted %q", s)
		}
	}
	loop, _ := Assemble("jmp 0")
	if _, e := Run(loop, [8]int64{}, 10); e == nil {
		t.Fatal("unbounded loop")
	}
	fall, _ := Assemble("nop")
	if _, e := Run(fall, [8]int64{}, 2); e == nil {
		t.Fatal("fallthrough")
	}
	for _, fuel := range []int{0, MaxFuel + 1} {
		if _, e := Run(loop, [8]int64{}, fuel); e == nil {
			t.Fatal("fuel")
		}
	}
	for _, c := range []struct {
		op   string
		a, b int64
	}{{"add", math.MaxInt64, 1}, {"add", math.MinInt64, -1}, {"sub", math.MinInt64, 1}, {"sub", math.MaxInt64, -1}} {
		p, _ := Assemble(c.op + " r0 r1\nhalt r0")
		if _, e := Run(p, [8]int64{c.a, c.b}, 3); e == nil {
			t.Fatal("overflow")
		}
	}
}

func TestEncodingValidation(t *testing.T) {
	p := Program{{Op: Const, Immediate: math.MinInt32}, {Op: Const, A: 7, Immediate: math.MaxInt32}, {Op: Mov, A: 1, B: 7}, {Op: Halt, A: 1}}
	data, _ := Encode(p)
	q, e := Decode(data)
	if e != nil || !reflect.DeepEqual(p, q) {
		t.Fatal(q, e)
	}
	for k := 0; k < len(data); k++ {
		if _, e := Decode(data[:k]); e == nil {
			t.Fatal("truncated accepted")
		}
	}
	bad := append([]byte(nil), data...)
	bad[8] = 243
	if _, e := Decode(bad); e == nil {
		t.Fatal("invalid trit")
	}
	bad = append(append([]byte(nil), data...), 0)
	if _, e := Decode(bad); e == nil {
		t.Fatal("trailing data")
	}
	if _, e := Encode(Program{{Op: 9}}); e == nil {
		t.Fatal("opcode")
	}
	if _, e := Encode(Program{{Op: Nop, A: 1}}); e == nil {
		t.Fatal("unused operand")
	}
	// Four instructions use 108 trits; the final two padding digits must be zero.
	bad = append([]byte(nil), data...)
	bad[len(bad)-1] += 27
	if _, e := Decode(bad); e == nil {
		t.Fatal("padding")
	}
}

func FuzzDecode(f *testing.F) {
	p, _ := Assemble(sumSource)
	data, _ := Encode(p)
	f.Add(data)
	f.Add([]byte("STV1"))
	f.Fuzz(func(t *testing.T, b []byte) {
		p, e := Decode(b)
		if e == nil {
			encoded, e := Encode(p)
			if e != nil || !bytes.Equal(encoded, b) {
				t.Fatal("noncanonical decoding")
			}
			_, _ = Run(p, [8]int64{}, 100)
		}
	})
}
