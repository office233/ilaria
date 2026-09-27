package ternaryvm

import (
	"bytes"
	"math"
	"reflect"
	"testing"
)

const v2SumSource = `
const r1 0
const r2 1
loop:
jz r0 done
add r1 r0
sub r0 r2
jmp loop
done:
halt r1
`

func TestV2SumLabelsAndRoundTrip(t *testing.T) {
	p, err := AssembleV2(v2SumSource)
	if err != nil { t.Fatal(err) }
	data, err := EncodeV2(p)
	if err != nil { t.Fatal(err) }
	if string(data[:4]) != "STV2" { t.Fatalf("header %q", data[:4]) }
	q, err := DecodeV2(data)
	if err != nil || !reflect.DeepEqual(p, q) { t.Fatalf("decode=%v err=%v", q, err) }
	again, err := EncodeV2(q)
	if err != nil || !bytes.Equal(data, again) { t.Fatal("noncanonical round trip") }
	for n := int64(0); n <= 1000; n++ {
		r, err := RunV2(q, [8]int64{n}, 10000)
		if err != nil || r.Value != n*(n+1)/2 {
			t.Fatalf("n=%d result=%v error=%v", n, r, err)
		}
	}
}

func TestV2AllOpcodesAreAddressable(t *testing.T) {
	seen := make(map[V2Op]bool)
	ops := []V2Op{V2Nop,V2Const,V2Mov,V2Add,V2Sub,V2Mul,V2Div,V2Mod,V2Eq,V2Ne,V2Lt,V2Le,V2Gt,V2Ge,V2Neg,V2Abs,V2Min,V2Max,V2BitAnd,V2BitOr,V2BitXor,V2BitNot,V2Jz,V2Jnz,V2Jmp,V2Addi,V2Halt}
	for _, op := range ops { seen[op] = true }
	if len(seen) != 27 { t.Fatalf("got %d opcodes", len(seen)) }
	for i := 0; i < 27; i++ { if !seen[V2Op(i)] { t.Fatalf("opcode %d missing", i) } }
}

func TestV2Operations(t *testing.T) {
	source := `
const r0 7
const r1 3
mul r0 r1
addi r0 1
const r2 22
eq r0 r2
jz r0 bad
const r3 -5
abs r3
max r3 r1
halt r3
bad: const r3 -99
halt r3
`
	p, err := AssembleV2(source)
	if err != nil { t.Fatal(err) }
	r, err := RunV2(p, [8]int64{}, 100)
	if err != nil || r.Value != 5 { t.Fatalf("result=%v err=%v", r, err) }
}

func TestV2ComparisonsAndBranches(t *testing.T) {
	for _, tc := range []struct{ a,b int64; want int64 }{{5,5,42},{5,6,-7},{-3,-3,42}} {
		p, err := AssembleV2(`
eq r0 r1
jz r0 no
const r2 42
halt r2
no: const r2 -7
halt r2
`)
		if err != nil { t.Fatal(err) }
		r, err := RunV2(p, [8]int64{tc.a,tc.b}, 20)
		if err != nil || r.Value != tc.want { t.Fatalf("%v %v", r, err) }
	}
	p, err := AssembleV2("const r0 1\njnz r0 yes\nconst r1 -1\nhalt r1\nyes: const r1 9\nhalt r1")
	if err != nil { t.Fatal(err) }
	r, err := RunV2(p, [8]int64{}, 20)
	if err != nil || r.Value != 9 { t.Fatalf("%v %v", r, err) }
}

func TestV2Errors(t *testing.T) {
	for _, src := range []string{
		"", "wat", "const r8 1", "const r0 2147483648", "jmp nowhere", "x:\nx:\nhalt r0",
		"bad-label!: halt r0", "jmp 9", "halt r0 extra",
	} {
		if _, err := AssembleV2(src); err == nil { t.Fatalf("accepted %q", src) }
	}
	for _, src := range []string{
		"const r0 0\nconst r1 0\ndiv r0 r1\nhalt r0",
		"const r1 -1\ndiv r0 r1\nhalt r0",
		"const r1 -1\nmul r0 r1\nhalt r0",
		"neg r0\nhalt r0",
		"abs r0\nhalt r0",
	} {
		p, err := AssembleV2(src)
		if err != nil { t.Fatal(err) }
		if _, err := RunV2(p, [8]int64{math.MinInt64}, 20); err == nil { t.Fatalf("expected runtime error for %q", src) }
	}
	loop, _ := AssembleV2("loop: jmp loop")
	if _, err := RunV2(loop, [8]int64{}, 10); err == nil { t.Fatal("fuel exhaustion expected") }
}

func TestV2EncodingRejectsMalformed(t *testing.T) {
	p, _ := AssembleV2("const r0 -2147483648\naddi r0 2147483647\nhalt r0")
	data, err := EncodeV2(p)
	if err != nil { t.Fatal(err) }
	for i := 0; i < len(data); i++ {
		if _, err := DecodeV2(data[:i]); err == nil { t.Fatalf("accepted truncation %d", i) }
	}
	bad := append([]byte(nil), data...); bad[8] = 243
	if _, err := DecodeV2(bad); err == nil { t.Fatal("invalid packed trit accepted") }
	bad = append(append([]byte(nil), data...), 0)
	if _, err := DecodeV2(bad); err == nil { t.Fatal("trailing byte accepted") }
	bad = append([]byte(nil), data...)
	bad[len(bad)-1] += 81
	if _, err := DecodeV2(bad); err == nil { t.Fatal("nonzero padding accepted") }
}

func FuzzDecodeV2(f *testing.F) {
	p, _ := AssembleV2(v2SumSource)
	data, _ := EncodeV2(p)
	f.Add(data)
	f.Add([]byte("STV2"))
	f.Fuzz(func(t *testing.T, b []byte) {
		p, err := DecodeV2(b)
		if err == nil {
			encoded, err := EncodeV2(p)
			if err != nil || !bytes.Equal(encoded, b) { t.Fatal("noncanonical decoding") }
			_, _ = RunV2(p, [8]int64{}, 100)
		}
	})
}
